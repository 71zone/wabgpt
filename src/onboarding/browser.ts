// Managed BrowserOS Neo in Docker, for the terminal onboarding.
//
// One container and one data volume per wabgpt data directory, both named from a hash of that
// directory and carrying ownership labels. This helper never touches a container or volume it
// does not own, never deletes a profile, and never opens pages or prompts: it only makes the
// browser reachable. MCP (9010) and the noVNC viewer (6080) are published on 127.0.0.1 with
// Docker-chosen host ports, so they cannot collide with a native BrowserOS or the default
// Compose stack and are never reachable from another machine.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Same digest as `compose.yaml` (multi-arch index). Update both together. */
export const managedBrowserImage = 'ghcr.io/browseros-ai/neo@sha256:6b8939714b29538cb52765397cf14cbfbf71933732de19a350de1d268c51644d';

const MCP_PORT = 9010;
const VIEWER_PORT = 6080;
const LOOPBACK = '127.0.0.1';
const OWNER_LABEL = 'io.wabgpt.owner';
const SCOPE_LABEL = 'io.wabgpt.scope';
const ROLE_LABEL = 'io.wabgpt.role';
const OWNER = 'wabgpt';
const ROLE = 'browser';
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 1000;
const COMMAND_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 20 * 60_000;

export type ManagedBrowserErrorCode =
  | 'docker-missing'
  | 'docker-unavailable'
  | 'asset-missing'
  | 'foreign-container'
  | 'foreign-volume'
  | 'unsafe-container'
  | 'image-unavailable'
  | 'start-failed'
  | 'invalid-ports'
  | 'not-ready';

/** A failure the user can act on. Aborts are not wrapped: the signal's own reason is thrown. */
export class ManagedBrowserError extends Error {
  constructor(readonly code: ManagedBrowserErrorCode, message: string) {
    super(message);
    this.name = 'ManagedBrowserError';
  }
}

export interface DockerResult { stdout: string }
/** Runs `docker <args>`. Rejects with `DockerCommandError`; rejects with the signal's reason on abort. */
export type DockerRunner = (args: readonly string[], options: { signal: AbortSignal; timeoutMs?: number }) => Promise<DockerResult>;

export class DockerCommandError extends Error {
  constructor(readonly kind: 'missing' | 'failed', readonly stderr: string, message: string) {
    super(message);
    this.name = 'DockerCommandError';
  }
}

export interface ManagedBrowserOptions {
  dataDir: string;
  signal: AbortSignal;
  log: (text: string) => void;
  /** Replaceable docker client, for tests. Defaults to the `docker` executable on PATH. */
  docker?: DockerRunner;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ManagedBrowser { endpoint: string; viewerUrl: string; containerName: string }

export const runDocker: DockerRunner = (args, { signal, timeoutMs = COMMAND_TIMEOUT_MS }) => {
  signal.throwIfAborted();
  const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<DockerResult>();
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  execFile('docker', [...args], { signal: combined, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (!error) return resolvePromise({ stdout });
    if (signal.aborted) return reject(signal.reason);
    if ('code' in error && error.code === 'ENOENT') return reject(new DockerCommandError('missing', '', 'docker executable not found'));
    if (combined.aborted) return reject(new DockerCommandError('failed', '', `docker ${args[0] ?? ''} timed out after ${Math.round(timeoutMs / 1000)}s`));
    const detail = lastLine(stderr) || error.message;
    reject(new DockerCommandError('failed', stderr, detail));
  });
  return promise;
};

function lastLine(text: string): string {
  const line = text.split('\n').map(part => part.trim()).filter(Boolean).at(-1) ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** Stable, human-recognizable scope for a data directory. */
export async function managedBrowserNames(dataDir: string): Promise<{ scope: string; container: string; volume: string }> {
  const absolute = resolve(dataDir);
  const canonical = await realpath(absolute).catch(() => absolute);
  const scope = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return { scope, container: `wabgpt-neo-${scope}`, volume: `wabgpt-neo-${scope}-data` };
}

const portBinding = z.object({ HostIp: z.string(), HostPort: z.string() });
const inspectSchema = z.object({
  Name: z.string().optional(),
  State: z.object({ Running: z.boolean(), Status: z.string().optional() }),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable().optional() }),
  HostConfig: z.object({
    Privileged: z.boolean().optional(),
    NetworkMode: z.string().optional(),
    PidMode: z.string().optional(),
    PortBindings: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string().optional() })).nullable()).nullable().optional(),
  }),
  NetworkSettings: z.object({ Ports: z.record(z.string(), z.array(portBinding).nullable()).nullable().optional() }),
});
type Inspected = z.infer<typeof inspectSchema>;

function parseInspect(stdout: string): Inspected {
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { throw new ManagedBrowserError('start-failed', 'Docker returned unreadable container details.'); }
  const parsed = inspectSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!parsed.success) throw new ManagedBrowserError('start-failed', 'Docker returned unexpected container details.');
  return parsed.data;
}

function assertLoopbackOnly(bindings: Record<string, readonly { HostIp: string }[] | null>, verb: 'publishes' | 'is configured to publish'): void {
  for (const [container, list] of Object.entries(bindings)) {
    for (const binding of list ?? []) {
      if (binding.HostIp !== LOOPBACK && binding.HostIp !== '::1') {
        throw new ManagedBrowserError('unsafe-container', `The managed browser ${verb} ${container} on ${binding.HostIp || 'all interfaces'}, not loopback only. Remove the container and let wabgpt recreate it (the saved profile volume is kept).`);
      }
    }
  }
}

/** Host ports Docker published for the browser, only when every published binding is loopback. */
export function parsePublishedPorts(inspected: Pick<Inspected, 'NetworkSettings'>): { mcp: number; viewer: number } {
  const ports = inspected.NetworkSettings.Ports ?? {};
  assertLoopbackOnly(ports, 'publishes');
  const find = (port: number): number => {
    const binding = (ports[`${port}/tcp`] ?? []).find(candidate => candidate.HostIp === LOOPBACK);
    const hostPort = binding ? Number(binding.HostPort) : Number.NaN;
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) throw new ManagedBrowserError('invalid-ports', `Docker did not publish container port ${port} on ${LOOPBACK}.`);
    return hostPort;
  };
  return { mcp: find(MCP_PORT), viewer: find(VIEWER_PORT) };
}

function isOwned(labels: Record<string, string> | null | undefined, scope: string): boolean {
  return labels?.[OWNER_LABEL] === OWNER && labels[ROLE_LABEL] === ROLE && labels[SCOPE_LABEL] === scope;
}

function assertSafe(inspected: Inspected, name: string): void {
  const { Privileged, NetworkMode, PidMode, PortBindings } = inspected.HostConfig;
  if (Privileged || NetworkMode === 'host' || PidMode === 'host') {
    throw new ManagedBrowserError('unsafe-container', `Container ${name} is privileged or shares host namespaces. Remove it and let wabgpt recreate it (the saved profile volume is kept).`);
  }
  // Checked before any start: starting a container configured for 0.0.0.0 would expose MCP before we could reject it.
  assertLoopbackOnly(PortBindings ?? {}, 'is configured to publish');
  for (const port of [MCP_PORT, VIEWER_PORT]) {
    if (!(PortBindings?.[`${port}/tcp`] ?? []).some(binding => binding.HostIp === LOOPBACK)) throw new ManagedBrowserError('invalid-ports', `Container ${name} is not configured to publish port ${port} on ${LOOPBACK}. Remove it and let wabgpt recreate it (the saved profile volume is kept).`);
  }
}

async function neoAsset(): Promise<string> {
  const path = fileURLToPath(new URL('../../deploy/neo.toml', import.meta.url));
  try {
    if (!(await stat(path)).isFile()) throw new Error('not a file');
    return await realpath(path);
  } catch {
    throw new ManagedBrowserError('asset-missing', `The shipped BrowserOS settings file is missing (${path}). Reinstall wabgpt.`);
  }
}

async function docker(runner: DockerRunner, signal: AbortSignal, args: readonly string[], timeoutMs?: number): Promise<string> {
  signal.throwIfAborted();
  try { return (await runner(args, { signal, ...(timeoutMs ? { timeoutMs } : {}) })).stdout; }
  catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  }
}

async function requireEngine(runner: DockerRunner, signal: AbortSignal): Promise<void> {
  try { await docker(runner, signal, ['version', '--format', '{{.Server.Version}}'], 20_000); }
  catch (error) {
    if (!(error instanceof DockerCommandError)) throw error;
    if (error.kind === 'missing') throw new ManagedBrowserError('docker-missing', 'Docker was not found. Install Docker Desktop or OrbStack (or Docker Engine on Linux), start it, then retry.');
    if (/permission denied/i.test(error.stderr)) throw new ManagedBrowserError('docker-unavailable', 'Your user cannot use Docker (permission denied). Add yourself to the docker group or start Docker Desktop, then retry.');
    throw new ManagedBrowserError('docker-unavailable', `Docker is installed but its engine is not running. Start Docker Desktop or OrbStack, wait until it is ready, then retry. (${error.message})`);
  }
}

async function listNames(runner: DockerRunner, signal: AbortSignal, args: readonly string[]): Promise<string[]> {
  return (await docker(runner, signal, args)).split('\n').map(line => line.trim()).filter(Boolean);
}

async function inspectContainer(runner: DockerRunner, signal: AbortSignal, name: string): Promise<Inspected> {
  return parseInspect(await docker(runner, signal, ['container', 'inspect', '--format', '{{json .}}', name]));
}

async function ensureVolume(runner: DockerRunner, signal: AbortSignal, volume: string, scope: string): Promise<void> {
  const existing = await listNames(runner, signal, ['volume', 'ls', '--quiet', '--filter', `name=^${volume}$`]);
  if (existing.includes(volume)) {
    const raw = await docker(runner, signal, ['volume', 'inspect', '--format', '{{json .Labels}}', volume]);
    let labels: unknown;
    try { labels = JSON.parse(raw); } catch { labels = null; }
    const parsed = z.record(z.string(), z.string()).nullable().safeParse(labels);
    if (!parsed.success || !isOwned(parsed.data, scope)) throw new ManagedBrowserError('foreign-volume', `A Docker volume named ${volume} exists but was not created by wabgpt. Rename or remove it, then retry.`);
    return;
  }
  await docker(runner, signal, ['volume', 'create', '--label', `${OWNER_LABEL}=${OWNER}`, '--label', `${ROLE_LABEL}=${ROLE}`, '--label', `${SCOPE_LABEL}=${scope}`, volume]);
}

async function ensureImage(runner: DockerRunner, signal: AbortSignal, log: (text: string) => void): Promise<void> {
  try { await docker(runner, signal, ['image', 'inspect', '--format', '{{.Id}}', managedBrowserImage]); return; }
  catch (error) { if (!(error instanceof DockerCommandError) || error.kind === 'missing') throw error; }
  log('Downloading the official BrowserOS Neo image (a few hundred MB; this can take several minutes)…');
  try { await docker(runner, signal, ['pull', '--quiet', managedBrowserImage], PULL_TIMEOUT_MS); }
  catch (error) {
    if (error instanceof DockerCommandError && error.kind === 'failed') throw new ManagedBrowserError('image-unavailable', `Could not download the BrowserOS Neo image: ${error.message}. Check your internet connection and Docker's network access, then retry.`);
    throw error;
  }
}

async function createContainer(runner: DockerRunner, signal: AbortSignal, names: { scope: string; container: string; volume: string }): Promise<void> {
  try {
    await docker(runner, signal, [
      'container', 'create',
      '--name', names.container,
      '--hostname', 'neo',
      '--label', `${OWNER_LABEL}=${OWNER}`,
      '--label', `${ROLE_LABEL}=${ROLE}`,
      '--label', `${SCOPE_LABEL}=${names.scope}`,
      '--shm-size', '1g',
      '--stop-timeout', '20',
      '--restart', 'unless-stopped',
      '--env', 'PUID=1000', '--env', 'PGID=1000', '--env', 'BROWSERCLAW_HOSTED_MODE=1',
      '--publish', `${LOOPBACK}::${MCP_PORT}`,
      '--publish', `${LOOPBACK}::${VIEWER_PORT}`,
      '--mount', `type=volume,source=${names.volume},target=/data`,
      managedBrowserImage,
    ]);
  } catch (error) {
    if (error instanceof DockerCommandError && error.kind === 'failed') throw new ManagedBrowserError('start-failed', `Could not create the BrowserOS container: ${error.message}`);
    throw error;
  }
}

/** Only a container created moments ago in this call is discarded; its volume (the profile) is never removed. */
async function discardNewContainer(runner: DockerRunner, name: string): Promise<void> {
  await runner(['container', 'rm', '--force', name], { signal: new AbortController().signal }).catch(() => undefined);
}

/**
 * Uploads the shipped Neo settings into the created, not yet started container. The Docker CLI
 * sends the bytes, so no host path has to be shared with the Docker VM (a global npm install
 * location usually is not). Copying the `neo` directory into `/etc` also creates `/etc/neo` when absent.
 */
async function copySettings(runner: DockerRunner, signal: AbortSignal, name: string, asset: string): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), 'wabgpt-neo-'));
  try {
    const folder = join(staging, 'neo');
    await mkdir(folder, { mode: 0o755 });
    await chmod(folder, 0o755);
    await copyFile(asset, join(folder, 'neo.toml'));
    await chmod(join(folder, 'neo.toml'), 0o644);
    await docker(runner, signal, ['container', 'cp', folder, `${name}:/etc/`]);
  } catch (error) {
    if (error instanceof DockerCommandError && error.kind === 'failed') {
      await discardNewContainer(runner, name);
      throw new ManagedBrowserError('start-failed', `Could not install the BrowserOS settings into its container: ${error.message}`);
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function startContainer(runner: DockerRunner, signal: AbortSignal, name: string, removeOnFailure: boolean): Promise<void> {
  try { await docker(runner, signal, ['container', 'start', name]); }
  catch (error) {
    if (!(error instanceof DockerCommandError) || error.kind !== 'failed') throw error;
    if (removeOnFailure) await discardNewContainer(runner, name);
    throw new ManagedBrowserError('start-failed', `Could not start the BrowserOS container: ${error.message}`);
  }
}

async function tailLogs(runner: DockerRunner, signal: AbortSignal, name: string): Promise<string> {
  try { return lastLine((await docker(runner, signal, ['container', 'logs', '--tail', '5', name])) || ''); }
  catch { return ''; }
}

async function probeReady(port: number, signal: AbortSignal): Promise<boolean> {
  try {
    const reply = await fetch(`http://${LOOPBACK}:${port}/system/ready`, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), redirect: 'error' });
    if (!reply.ok) return false;
    const body: unknown = await reply.json();
    return z.object({ status: z.literal('ok') }).safeParse(body).success;
  } catch {
    if (signal.aborted) throw signal.reason;
    return false;
  }
}

async function waitUntilReady(runner: DockerRunner, signal: AbortSignal, log: (text: string) => void, name: string, port: number, timeoutMs: number, pollMs: number): Promise<void> {
  const started = Date.now();
  let announced = started;
  for (let attempt = 0; ; attempt++) {
    if (await probeReady(port, signal)) return;
    if (attempt % 5 === 4) {
      const state = await inspectContainer(runner, signal, name).then(value => value.State, () => undefined);
      if (state && !state.Running) {
        const detail = await tailLogs(runner, signal, name);
        throw new ManagedBrowserError('not-ready', `The BrowserOS container stopped while starting${detail ? ` (${detail})` : ''}. Run "docker logs ${name}" for details, then retry.`);
      }
    }
    const now = Date.now();
    if (now - started >= timeoutMs) throw new ManagedBrowserError('not-ready', `BrowserOS did not become ready within ${Math.round(timeoutMs / 1000)}s. Run "docker logs ${name}" for details, then retry.`);
    if (now - announced >= 15_000) { announced = now; log('Still waiting for BrowserOS to start…'); }
    try { await sleep(pollMs, undefined, { signal }); } catch { throw signal.reason; }
  }
}

/**
 * Makes sure this data directory's managed BrowserOS container exists, runs, and answers
 * `/system/ready`. Reuses an owned container (and its profile) and never removes one.
 */
export async function ensureManagedBrowser(options: ManagedBrowserOptions): Promise<ManagedBrowser> {
  const { signal, log } = options;
  const runner = options.docker ?? runDocker;
  signal.throwIfAborted();
  const asset = await neoAsset();
  const names = await managedBrowserNames(options.dataDir);
  await requireEngine(runner, signal);

  const present = (await listNames(runner, signal, ['container', 'ls', '--all', '--filter', `name=^/${names.container}$`, '--format', '{{.Names}}'])).includes(names.container);
  if (present) {
    const existing = await inspectContainer(runner, signal, names.container);
    if (!isOwned(existing.Config.Labels, names.scope)) throw new ManagedBrowserError('foreign-container', `A Docker container named ${names.container} exists but was not created by wabgpt. Rename or remove it, then retry.`);
    assertSafe(existing, names.container);
    if (!existing.State.Running) {
      log('Starting your BrowserOS container…');
      await startContainer(runner, signal, names.container, false);
    }
  } else {
    await ensureVolume(runner, signal, names.volume, names.scope);
    await ensureImage(runner, signal, log);
    log('Creating your private BrowserOS container…');
    await createContainer(runner, signal, names);
    await copySettings(runner, signal, names.container, asset);
    await startContainer(runner, signal, names.container, true);
  }

  const running = await inspectContainer(runner, signal, names.container);
  assertSafe(running, names.container);
  const ports = parsePublishedPorts(running);
  log('Waiting for BrowserOS to be ready…');
  await waitUntilReady(runner, signal, log, names.container, ports.mcp, options.readinessTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, options.pollIntervalMs ?? DEFAULT_POLL_MS);
  return { endpoint: `http://${LOOPBACK}:${ports.mcp}/mcp`, viewerUrl: `http://${LOOPBACK}:${ports.viewer}/`, containerName: names.container };
}

/** Opens an http(s) URL in the user's default browser. Rejects when no opener exists or it fails. */
export function openSetupUrl(url: string): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return Promise.reject(new Error('Not a valid URL.')); }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return Promise.reject(new Error('Only plain http(s) URLs can be opened.'));
  const [command, args]: [string, string[]] = process.platform === 'darwin' ? ['open', [parsed.href]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', parsed.href]]
      : ['xdg-open', [parsed.href]];
  const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<void>();
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  const timer = setTimeout(() => { child.unref(); resolvePromise(); }, 3000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => {
    clearTimeout(timer);
    if (code === 0) resolvePromise(); else reject(new Error(`${command} exited with code ${code}`));
  });
  return promise;
}
