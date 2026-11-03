import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Read-only checks. Credentials stay in local files and are never printed.
const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node smoke.mjs /path/to/local-smoke-config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const url = new URL('/mcp', config.url);
let requestId = 0;

const invoke = async (token, name, args) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', Origin: new URL(config.url).origin },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call',
      params: { name, arguments: args } }),
    signal: AbortSignal.timeout(90_000),
  });
  assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
  const raw = await response.text();
  const payload = JSON.parse(raw.startsWith('event:') || raw.startsWith('data:')
    ? raw.split('\n').filter((line) => line.startsWith('data: ')).at(-1).slice(6) : raw);
  assert.ok(!payload.error, `${name}: MCP request failed`);
  const text = payload.result.content?.find((item) => item.type === 'text')?.text;
  return text ? JSON.parse(text) : payload.result;
};

const results = [];
for (const identity of config.identities) {
  const token = readFileSync(identity.tokenFile, 'utf8').trim();
  const catalog = await invoke(token, 'get_tool_catalog', {});
  const tools = Object.values(catalog.catalog).flat().filter((tool) => tool.name.startsWith('app_whatsapp_'));
  assert.equal(tools.length, identity.operator ? (identity.admin ? 12 : 11) : 0, identity.label);
  assert.equal(tools.some((tool) => tool.name === 'app_whatsapp_webhooks'), identity.admin);
  if (identity.operator) {
    const skills = await invoke(token, 'list_skills', {});
    assert.ok(skills.skillNames.includes('whatsapp'), `${identity.label}: WhatsApp skill missing`);
    const execute = async (name, args) => {
      const result = await invoke(token, 'execute_tool', { toolName: name, arguments: args });
      return result.result ?? result;
    };
    const capabilities = await execute('app_whatsapp_get_capabilities', {});
    assert.equal(capabilities.status, 'ready', identity.label);
    assert.deepEqual(capabilities.permissions, { operator: true, admin: identity.admin });
    assert.equal(capabilities.principal.kind, identity.kind);
    assert.equal((await execute('app_whatsapp_list_threads', { first: 1 })).status, 'ready');
    assert.equal((await execute('app_whatsapp_templates', { action: 'list', first: 1 })).status, 'ready');
    if (config.threadId) {
      assert.equal((await execute('app_whatsapp_get_thread', { threadId: config.threadId, first: 1 })).status, 'ready');
    }
  }
  results.push({ identity: identity.label, principal: identity.kind, whatsappTools: tools.length, passed: true });
}
console.log(JSON.stringify({ url: config.url, checks: results }, null, 2));
