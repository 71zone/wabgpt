import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const FILE = 'onboarding.json';
const CURRENT_VERSION = 1;

const timestamp = z.number().int().nonnegative();
/** Docker keeps the native endpoint that was configured before the managed browser's endpoint replaced it in the config file. */
const browser = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('native') }).strict(),
  z.object({ mode: z.literal('docker'), nativeEndpoint: z.string().min(1) }).strict(),
]);

/**
 * Resumable checkpoint. The stage names the next step still to do. A browser is only recorded once one was selected, and a
 * completion time exists only on a completed setup, so no invalid combination can be stored.
 */
const setupSchema = z.discriminatedUnion('stage', [
  z.object({ version: z.literal(CURRENT_VERSION), stage: z.literal('browser'), updatedAt: timestamp }).strict(),
  z.object({ version: z.literal(CURRENT_VERSION), stage: z.enum(['chatgpt', 'whatsapp', 'contact']), browser, updatedAt: timestamp }).strict(),
  z.object({ version: z.literal(CURRENT_VERSION), stage: z.literal('complete'), browser, updatedAt: timestamp, completedAt: timestamp }).strict(),
]);

export type SetupState = z.infer<typeof setupSchema>;
export type BrowserSelection = z.infer<typeof browser>;
export type BrowserMode = BrowserSelection['mode'];
export type SetupStage = SetupState['stage'];

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; }
  catch (error) { if (isMissing(error)) return false; throw error; }
}

/**
 * Reads the setup checkpoint, or null when none was ever written. A malformed, unknown or newer-version file is an error
 * and is never replaced: the user decides what to do with something this version did not write.
 */
export async function readSetupState(dataDir: string): Promise<SetupState | null> {
  const path = join(dataDir, FILE);
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (isMissing(error)) return null; throw error; }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error(`Setup progress file ${path} is not valid JSON. Fix or remove it, then run wabgpt again.`); }
  const version = typeof raw === 'object' && raw !== null && 'version' in raw ? raw.version : undefined;
  if (typeof version === 'number' && version > CURRENT_VERSION) throw new Error(`Setup progress file ${path} was written by a newer wabgpt (version ${version}). Update wabgpt or remove the file.`);
  const parsed = setupSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Setup progress file ${path} is invalid: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}. Fix or remove it, then run wabgpt again.`);
  return parsed.data;
}

/** Atomic, private (0600) replacement through a temporary file in the same directory. */
export async function writeSetupState(dataDir: string, state: SetupState): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const path = join(dataDir, FILE);
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(state, null, 2) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path);
}

/** Moves to `stage`, keeping the selected browser. Completion is only reached through `completeSetup`. */
export function checkpoint(selection: BrowserSelection, stage: 'chatgpt' | 'whatsapp' | 'contact', now: number = Date.now()): SetupState {
  return { version: CURRENT_VERSION, stage, browser: selection, updatedAt: now };
}

export function pendingSetup(now: number = Date.now()): SetupState {
  return { version: CURRENT_VERSION, stage: 'browser', updatedAt: now };
}

export function completeSetup(selection: BrowserSelection, now: number = Date.now()): SetupState {
  return { version: CURRENT_VERSION, stage: 'complete', browser: selection, updatedAt: now, completedAt: now };
}

/**
 * An installation that predates onboarding: it already has saved routing state or a WhatsApp login. Config-file presence alone
 * says nothing, because loadConfig creates it. Only meaningful while no setup marker exists.
 */
export async function hasLegacyData(dataDir: string): Promise<boolean> {
  return await exists(join(dataDir, 'state.json')) || await exists(join(dataDir, 'whatsapp', 'creds.json'));
}
