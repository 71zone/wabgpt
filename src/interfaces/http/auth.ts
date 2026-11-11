import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;
const TOKEN_READ_ATTEMPTS = 20;
const TOKEN_READ_DELAY_MS = 50;

/** Constant-time string comparison that does not leak the length or content of the secret. */
export function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
}

function tokenFileError(path: string, reason: string): Error {
  return new Error(`Owner token file ${path} ${reason}. Remove it to issue a new owner token, then restart and sign in again.`);
}

async function readExisting(path: string): Promise<string | null> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const token = text.trim();
  if (!token) return '';
  if (!TOKEN_PATTERN.test(token)) throw tokenFileError(path, 'does not contain a valid token');
  const mode = (await stat(path)).mode & 0o777;
  if (mode & 0o077) await chmod(path, 0o600);
  return token;
}

/**
 * Returns the single owner token stored at `path`, creating it with 32 random bytes the first time. The file is created
 * exclusively with mode 0600 and its newly created parent directories with mode 0700. An existing invalid file is never
 * overwritten.
 */
export async function readOrCreateOwnerToken(path: string): Promise<string> {
  for (let attempt = 0; attempt < TOKEN_READ_ATTEMPTS; attempt++) {
    const existing = await readExisting(path);
    if (existing) return existing;
    if (existing === null) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const token = randomBytes(32).toString('base64url');
      try {
        const file = await open(path, 'wx', 0o600);
        try { await file.writeFile(`${token}\n`); await file.sync(); } finally { await file.close(); }
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    // Another process is creating the file right now: wait for its content.
    await sleep(TOKEN_READ_DELAY_MS);
  }
  throw tokenFileError(path, 'is empty');
}

/** Holds only a digest of the owner token so the plaintext never lives in server state. */
export function createTokenVerifier(token: string): (candidate: string) => boolean {
  const digest = createHash('sha256').update(token).digest();
  return candidate => timingSafeEqual(createHash('sha256').update(candidate).digest(), digest);
}

export interface SessionLimits {
  /** Absolute session lifetime in milliseconds. */
  ttlMs: number;
  /** Concurrently valid sessions; the oldest is revoked first. */
  maxSessions: number;
}

export interface Closable { close(): void }

export interface Session {
  readonly csrfToken: string;
  readonly expiresAt: number;
  /** Event streams opened with this session; they are closed when the session ends. */
  readonly streams: Set<Closable>;
}

interface Entry extends Session { timer: NodeJS.Timeout; key: string }

const keyOf = (id: string): string => createHash('sha256').update(id).digest('hex');

/** In-memory server-side sessions. The cookie carries a random id; only its hash is stored. */
export class SessionStore {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly limits: SessionLimits) {}

  create(): { id: string; session: Session } {
    while (this.entries.size >= this.limits.maxSessions) {
      const oldest = this.entries.values().next().value;
      if (!oldest) break;
      this.end(oldest);
    }
    const id = randomBytes(32).toString('base64url');
    const key = keyOf(id);
    const expiresAt = Date.now() + this.limits.ttlMs;
    const entry: Entry = { key, csrfToken: randomBytes(32).toString('base64url'), expiresAt, streams: new Set(), timer: setTimeout(() => this.end(entry), this.limits.ttlMs) };
    entry.timer.unref();
    this.entries.set(key, entry);
    return { id, session: entry };
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const entry = this.entries.get(keyOf(id));
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) { this.end(entry); return undefined; }
    return entry;
  }

  /** Revokes a session and closes its event streams. */
  revoke(session: Session): void {
    for (const entry of this.entries.values()) if (entry === session) { this.end(entry); return; }
  }

  closeAll(): void { for (const entry of [...this.entries.values()]) this.end(entry); }

  private end(entry: Entry): void {
    clearTimeout(entry.timer);
    this.entries.delete(entry.key);
    for (const stream of [...entry.streams]) stream.close();
    entry.streams.clear();
  }
}

/** Sliding-window failure counter keyed by caller. Used only for owner login. */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly maxFailures: number, private readonly windowMs: number, private readonly maxKeys = 1024) {}

  /** Milliseconds until another attempt is allowed, or 0. */
  retryAfter(key: string, now = Date.now()): number {
    const recent = this.recent(key, now);
    if (recent.length < this.maxFailures) return 0;
    return Math.max(1, (recent[0] ?? now) + this.windowMs - now);
  }

  fail(key: string, now = Date.now()): void {
    const recent = this.recent(key, now);
    recent.push(now);
    this.failures.delete(key);
    this.failures.set(key, recent);
    while (this.failures.size > this.maxKeys) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  clear(key: string): void { this.failures.delete(key); }

  private recent(key: string, now: number): number[] {
    return (this.failures.get(key) ?? []).filter(at => now - at < this.windowMs);
  }
}
