import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Exclusive single-writer lock for a data directory. A leftover lock is never removed
 * automatically: after a crash only the operator can tell whether the owner still runs.
 */
export async function acquireLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'bridge.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error(`Another bridge may be running. If it crashed, verify that it stopped, then remove ${path}.`);
    throw error;
  }
  await handle.writeFile(String(process.pid));
  let released: Promise<void> | undefined;
  return () => released ??= (async () => { await handle.close(); await unlink(path); })();
}
