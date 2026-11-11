import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { isLoopbackHost, parseLocalMcpEndpoint } from './loopback.js';

export const defaultConfigPath = join(homedir(), '.wa-chatgpt', 'config.json');
export const defaultServerHost = '127.0.0.1';
export const defaultServerPort = 8788;

export interface ServerSettings { host: string; port: number; tokenFile: string; publicOrigin?: string }
export interface LoadedConfig { path: string; browserMcpUrl: string; dataDir: string; server: ServerSettings }

/** An exact browser origin: HTTPS, or plain HTTP only for loopback. No path, query or credentials. */
function parsePublicOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) throw new Error('publicOrigin must use HTTPS unless it is a loopback address');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('publicOrigin must be a bare origin like https://wabgpt.example.com');
  return url.origin;
}

const configSchema = z.object({
  browserMcpUrl: z.string().superRefine((value, context) => {
    try { parseLocalMcpEndpoint(value); } catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }); }
  }),
  dataDir: z.string().min(1),
  server: z.object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    tokenFile: z.string().min(1).optional(),
    publicOrigin: z.string().superRefine((value, context) => {
      try { parsePublicOrigin(value); } catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) }); }
    }).optional(),
  }).strict().optional(),
}).strict();

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export async function loadConfig(path = defaultConfigPath): Promise<LoadedConfig> {
  const configPath = resolve(expandHome(path));
  let text: string;
  try { text = await readFile(configPath, 'utf8'); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    const defaults = { browserMcpUrl: 'http://127.0.0.1:9010/mcp', dataDir: '~/.wa-chatgpt' };
    try { await writeFile(configPath, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (writeError) {
      if (!(writeError instanceof Error && 'code' in writeError && writeError.code === 'EEXIST')) throw writeError;
    }
    text = await readFile(configPath, 'utf8');
  }
  try {
    const config = configSchema.parse(JSON.parse(text));
    const base = dirname(configPath);
    const dataDir = resolve(base, expandHome(config.dataDir));
    const server: ServerSettings = {
      host: config.server?.host ?? defaultServerHost,
      port: config.server?.port ?? defaultServerPort,
      tokenFile: config.server?.tokenFile ? resolve(base, expandHome(config.server.tokenFile)) : join(dataDir, 'server-token'),
    };
    if (config.server?.publicOrigin) server.publicOrigin = parsePublicOrigin(config.server.publicOrigin);
    return { path: configPath, browserMcpUrl: config.browserMcpUrl, dataDir, server };
  } catch (error) {
    throw new Error(`Invalid configuration in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Replaces only `browserMcpUrl` in the config file at `config.path`, keeping every other key exactly as
 * stored (unknown-to-this-version keys are still rejected by the same schema, so a file that would not
 * load is never written). The replacement is validated as a credential-free loopback endpoint, written to
 * a private temporary file beside the config and renamed into place, so a crash leaves either the old or
 * the new complete file. Symlinked config files keep their link. Callers reload with loadConfig.
 */
export async function setBrowserMcpUrl(config: Pick<LoadedConfig, 'path'>, endpoint: string): Promise<void> {
  const target = await realpath(config.path);
  let raw: unknown;
  try { raw = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) { throw new Error(`Invalid configuration in ${config.path}: ${error instanceof Error ? error.message : String(error)}`); }
  const next = { ...(typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}), browserMcpUrl: endpoint };
  const parsed = configSchema.safeParse(next);
  if (!parsed.success) throw new Error(`Cannot save browser endpoint to ${config.path}: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
  const temporary = join(dirname(target), `.${randomUUID()}.config.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(next, null, 2) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
