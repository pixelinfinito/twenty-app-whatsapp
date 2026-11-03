import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const checkout = process.argv[2];
if (!checkout) throw new Error('Usage: node tools/twenty-caller-delegation/apply.mjs /absolute/path/to/twenty [--check]');
const patch = fileURLToPath(new URL('./twenty-caller-delegation-v1.patch', import.meta.url));
const cwd = resolve(checkout);
// Check the entire patch before touching a checkout. No fuzzy rewriting or resets.
execFileSync('git', ['apply', '--check', patch], { cwd, stdio: 'inherit' });
if (!process.argv.includes('--check')) execFileSync('git', ['apply', patch], { cwd, stdio: 'inherit' });
