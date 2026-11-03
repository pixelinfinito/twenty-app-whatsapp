import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const [checkout, compilerRoot, image = 'twenty-whatsapp-mcp-dev:2.54.0-caller-v1'] = process.argv.slice(2);
if (!checkout || !compilerRoot) throw new Error('Usage: node build-docker.mjs /path/to/patched/twenty /path/to/compiler-prefix [image-tag]');
const require = createRequire(join(resolve(compilerRoot), 'package.json'));
const swc = require('@swc/core');
const lingui = require.resolve('@lingui/swc-plugin');
const root = resolve(checkout);
const upstream = JSON.parse(readFileSync(new URL('./upstream.json', import.meta.url), 'utf8'));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (revision !== upstream.commit) throw new Error(`Expected Twenty ${upstream.commit}; port and verify the patch before changing its base.`);
const patchHash = createHash('sha256').update(readFileSync(new URL('./twenty-caller-delegation-v1.patch', import.meta.url))).digest('hex');
const source = join(root, 'packages/twenty-server/src');
const context = mkdtempSync(join(tmpdir(), 'twenty-caller-image-'));
const files = [
  'engine/core-modules/auth/strategies/jwt.auth.strategy.ts',
  'engine/core-modules/auth/token/services/application-token.service.ts',
  'engine/guards/auth-principal.guard.ts',
  'engine/guards/utils/is-tool-caller-read-request.util.ts',
  'engine/middlewares/middleware.service.ts',
  'engine/utils/bind-data-to-request-object.util.ts',
  'engine/api/mcp/services/mcp-protocol.service.ts',
  'engine/core-modules/logic-function/logic-function-executor/constants/engine-injected-env-variable-names.constant.ts',
  'engine/core-modules/logic-function/logic-function-executor/logic-function-executor.service.ts',
  'engine/core-modules/tool-provider/providers/logic-function-tool.provider.ts',
  'engine/core-modules/tool-provider/services/logic-function-tool-delegation.service.ts',
  'engine/core-modules/tool-provider/services/tool-executor.service.ts',
  'engine/core-modules/tool-provider/services/tool-registry.service.ts',
  'engine/core-modules/tool-provider/tools/get-tool-catalog.tool.ts',
  'engine/core-modules/tool-provider/tool-provider.module.ts',
];
for (const file of files) {
  const filename = join(source, file);
  const target = join(context, 'dist', file.replace(/\.ts$/, '.js'));
  const compiled = swc.transformSync(readFileSync(filename, 'utf8'), {
    filename, swcrc: false, configFile: false, sourceMaps: false,
    module: { type: 'commonjs' },
    jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
      experimental: { plugins: [[lingui, { stripNonEssentialFields: false }]] } },
  });
  const code = compiled.code.replace(/require\(["']src\/([^"']+)["']\)/g, (_match, path) => {
    const destination = join(source, path);
    let imported = relative(dirname(filename), destination).replaceAll('\\', '/');
    if (!imported.startsWith('.')) imported = `./${imported}`;
    return `require(${JSON.stringify(imported)})`;
  });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, code);
}
writeFileSync(join(context, 'Dockerfile'), [
  `FROM ${upstream.baseImage}`,
  'LABEL io.pixel.whatsapp.caller-delegation="1"',
  `LABEL org.opencontainers.image.revision="${revision}"`,
  `LABEL io.pixel.whatsapp.caller-delegation-patch="${patchHash}"`,
  'COPY dist/ /app/packages/twenty-server/dist/',
  '',
].join('\n'));
execFileSync('docker', ['build', '-t', image, context], { stdio: 'inherit' });
