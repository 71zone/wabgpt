import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistedState, StatePersistence } from '../../core/state.js';

const FILE = 'state.json';

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function versionOf(raw: unknown): unknown {
  return typeof raw === 'object' && raw !== null && 'version' in raw ? raw.version : undefined;
}

/**
 * Filesystem-backed state: `<directory>/state.json`, directory 0700, file 0600, replaced atomically through a
 * temporary file and rename. Writes are serialized. Schema, migration and invariants live in core RoutingState.
 * The first write that replaces a document of another schema version keeps that document beside it as
 * `state.json.v<version>.bak` (0600, never overwritten) so a downgrade stays possible.
 */
export function createJsonStatePersistence(directory: string): StatePersistence {
  const path = join(directory, FILE);
  let writes: Promise<void> = Promise.resolve();
  let prepared: Promise<void> | null = null;
  const prepare = (): Promise<void> => prepared ??= (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  })().catch(error => { prepared = null; throw error; });

  async function preserveOtherVersion(next: number): Promise<void> {
    let previous: unknown;
    try { previous = versionOf(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) { if (isMissing(error) || error instanceof SyntaxError) return; throw error; }
    if (typeof previous !== 'number' || previous === next) return;
    const backup = join(directory, `${FILE}.v${previous}.bak`);
    try { await copyFile(path, backup, constants.COPYFILE_EXCL); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; return; }
    await chmod(backup, 0o600);
  }

  async function replace(state: PersistedState): Promise<void> {
    await prepare();
    await preserveOtherVersion(state.version);
    const temporary = `${path}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(state, null, 2) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path);
  }

  return {
    async read() {
      await prepare();
      try { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
      catch (error) { if (isMissing(error)) return undefined; throw error; }
    },
    write(state) {
      const next = writes.then(() => replace(state));
      writes = next.catch(() => undefined);
      return next;
    },
  };
}
