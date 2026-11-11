// Compiles into a scratch directory and swaps it in only on success, so a failed
// build never removes a working dist/ (the global `wabgpt` link points into it).
import { spawnSync } from 'node:child_process';
import { chmod, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = join(root, 'dist.tmp');
const output = join(root, 'dist');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

await rm(scratch, { recursive: true, force: true });
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', scratch], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) {
  await rm(scratch, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}
try { await stat(join(scratch, 'cli.js')); }
catch { await rm(scratch, { recursive: true, force: true }); throw new Error('Build produced no cli.js.'); }
await chmod(join(scratch, 'cli.js'), 0o755);
await rm(output, { recursive: true, force: true });
await rename(scratch, output);
