import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Largest file accepted in either direction; bigger media is skipped with a log line rather than loaded into memory or sent. */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const MAX_AGE_MS = 24 * 60 * 60_000;
const PURGE_EVERY_MS = 60 * 60_000;

/** Scratch directory for media in transit (photos from WhatsApp, files and images from ChatGPT). Files older than a day are deleted. */
export interface MediaStore {
  readonly directory: string;
  /** Returns a unique, not-yet-existing path inside the store for `fileName`; the file name is sanitized and keeps its extension. */
  allocate(fileName: string): Promise<string>;
}

function safeName(fileName: string): string {
  const base = basename(fileName).replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').trim().slice(0, 100);
  return base || `file${extname(fileName).slice(0, 10)}`;
}

export function createMediaStore(directory: string): MediaStore {
  let lastPurge = 0;
  async function purge(): Promise<void> {
    const now = Date.now();
    if (now - lastPurge < PURGE_EVERY_MS) return;
    lastPurge = now;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      const info = await stat(path).catch(() => undefined);
      if (info && now - info.mtimeMs > MAX_AGE_MS) await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return {
    directory,
    async allocate(fileName) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await purge();
      const folder = join(directory, randomUUID());
      await mkdir(folder, { mode: 0o700 });
      return join(folder, safeName(fileName));
    },
  };
}
