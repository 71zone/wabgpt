import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  DockerCommandError,
  ManagedBrowserError,
  ensureManagedBrowser,
  managedBrowserImage,
  managedBrowserNames,
  openSetupUrl,
  type DockerRunner,
} from '../src/onboarding/browser.js';
import { withDirectory } from './support/core-fixtures.js';

interface FakeContainer {
  labels: Record<string, string>;
  running: boolean;
  privileged: boolean;
  publishHost: string;
  /** Host IP of the configured (not yet running) port bindings. Defaults to publishHost. */
  configuredHost?: string;
  server?: Server;
  viewerPort: number;
  volume: string;
  /** Whether the Neo settings file was uploaded before the container first started. */
  settings?: boolean;
  startedWithSettings?: boolean;
}

/** A small in-memory Docker engine: just enough behavior for the managed browser's boundary. */
class FakeEngine {
  containers = new Map<string, FakeContainer>();
  volumes = new Map<string, Record<string, string>>();
  images = new Set<string>();
  mutations: string[] = [];
  up = true;
  missing = false;
  ready = true;
  failStart = false;
  failCopy = false;

  readonly run: DockerRunner = async (args, { signal }) => {
    signal.throwIfAborted();
    if (this.missing) throw new DockerCommandError('missing', '', 'docker executable not found');
    const [group, verb] = args;
    const flags = (name: string): string[] => args.flatMap((value, index) => (value === name ? [args[index + 1] ?? ''] : []));
    const last = args.at(-1) ?? '';
    if (group === 'version') {
      if (!this.up) throw new DockerCommandError('failed', 'Cannot connect to the Docker daemon', 'Cannot connect to the Docker daemon');
      return { stdout: '29.0.0\n' };
    }
    if (group === 'container' && verb === 'ls') return { stdout: [...this.containers.keys()].join('\n') };
    if (group === 'container' && verb === 'inspect') return { stdout: JSON.stringify(this.inspect(last)) };
    if (group === 'container' && verb === 'logs') return { stdout: 'chromium exited\n' };
    if (group === 'volume' && verb === 'ls') return { stdout: [...this.volumes.keys()].join('\n') };
    if (group === 'volume' && verb === 'inspect') return { stdout: JSON.stringify(this.volumes.get(last) ?? null) };
    if (group === 'volume' && verb === 'create') {
      this.mutations.push(`volume create ${last}`);
      this.volumes.set(last, Object.fromEntries(flags('--label').map(label => label.split('=') as [string, string])));
      return { stdout: last };
    }
    if (group === 'image' && verb === 'inspect') {
      if (!this.images.has(last)) throw new DockerCommandError('failed', 'No such image', 'No such image');
      return { stdout: 'sha256:1' };
    }
    if (group === 'pull') { this.mutations.push('pull'); this.images.add(last); return { stdout: '' }; }
    if (group === 'container' && verb === 'create') {
      const name = flags('--name')[0] ?? '';
      this.mutations.push(`container create ${name}`);
      const publish = flags('--publish');
      this.containers.set(name, {
        labels: Object.fromEntries(flags('--label').map(label => label.split('=') as [string, string])),
        running: false,
        privileged: false,
        publishHost: publish[0]?.split(':')[0] ?? '',
        viewerPort: 45000,
        volume: flags('--mount').find(mount => mount.includes('type=volume'))?.match(/source=([^,]+)/)?.[1] ?? '',
      });
      return { stdout: name };
    }
    if (group === 'container' && verb === 'cp') {
      this.mutations.push('container cp');
      if (this.failCopy) throw new DockerCommandError('failed', 'copy failed', 'copy failed');
      const target = this.containers.get((last.split(':')[0]) ?? '');
      if (!target) throw new DockerCommandError('failed', 'No such container', 'No such container');
      target.settings = true;
      return { stdout: '' };
    }
    if (group === 'container' && verb === 'start') {
      this.mutations.push(`container start ${last}`);
      if (this.failStart) throw new DockerCommandError('failed', 'port is already allocated', 'port is already allocated');
      const container = this.containers.get(last);
      if (!container) throw new DockerCommandError('failed', 'No such container', 'No such container');
      container.server = createServer((_request, reply) => {
        if (!this.ready) { reply.statusCode = 503; reply.end('{}'); return; }
        reply.setHeader('content-type', 'application/json');
        reply.end(JSON.stringify({ status: 'ok' }));
      });
      container.server.listen(0, '127.0.0.1');
      await once(container.server, 'listening');
      container.startedWithSettings ??= container.settings === true;
      container.running = true;
      return { stdout: last };
    }
    if (group === 'container' && verb === 'rm') {
      this.mutations.push(`container rm ${args.at(-1)}`);
      this.containers.delete(last);
      return { stdout: '' };
    }
    throw new Error(`unexpected docker call: ${args.join(' ')}`);
  };

  private inspect(name: string): unknown {
    const container = this.containers.get(name);
    if (!container) throw new DockerCommandError('failed', 'No such container', 'No such container');
    const port = container.server ? (container.server.address() as AddressInfo).port : 0;
    return [{
      Name: `/${name}`,
      State: { Running: container.running },
      Config: { Labels: container.labels },
      HostConfig: {
        Privileged: container.privileged,
        NetworkMode: 'bridge',
        PortBindings: { '9010/tcp': [{ HostIp: container.configuredHost ?? container.publishHost, HostPort: '' }], '6080/tcp': [{ HostIp: container.configuredHost ?? container.publishHost, HostPort: '' }] },
      },
      NetworkSettings: {
        Ports: container.running
          ? { '9010/tcp': [{ HostIp: container.publishHost, HostPort: String(port) }], '6080/tcp': [{ HostIp: container.publishHost, HostPort: String(container.viewerPort) }] }
          : {},
      },
    }];
  }

  async stopAll(): Promise<void> {
    for (const container of this.containers.values()) {
      if (container.server?.listening) { container.server.close(); container.server.closeAllConnections(); }
    }
  }
}

async function withEngine(run: (engine: FakeEngine, dataDir: string) => Promise<void>): Promise<void> {
  const engine = new FakeEngine();
  engine.images.add(managedBrowserImage);
  try { await withDirectory(directory => run(engine, join(directory, 'data')), 'wabgpt-browser-'); }
  finally { await engine.stopAll(); }
}

const quick = { readinessTimeoutMs: 400, pollIntervalMs: 10 };
const options = (engine: FakeEngine, dataDir: string, signal = new AbortController().signal): Parameters<typeof ensureManagedBrowser>[0] => ({ dataDir, signal, log: () => undefined, docker: engine.run, ...quick });
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (error) { if (error instanceof ManagedBrowserError) return error.code; throw error; }
  throw new Error('expected ManagedBrowserError');
};

test('creates an owned loopback-only browser with its own profile volume and returns reachable endpoints', async () => {
  await withEngine(async (engine, dataDir) => {
    engine.images.clear();
    const browser = await ensureManagedBrowser(options(engine, dataDir));
    const names = await managedBrowserNames(dataDir);
    assert.equal(browser.containerName, names.container);
    assert.match(browser.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.match(browser.viewerUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.notEqual(new URL(browser.endpoint).port, '9010');
    assert.notEqual(new URL(browser.viewerUrl).port, '6080');
    const container = engine.containers.get(names.container);
    assert.equal(container?.running, true);
    assert.equal(container?.publishHost, '127.0.0.1');
    assert.equal(container?.privileged, false);
    assert.equal(container?.volume, names.volume);
    assert.equal(container?.startedWithSettings, true);
    assert.equal(engine.volumes.get(names.volume)?.['io.wabgpt.scope'], names.scope);
    assert.ok(engine.mutations.includes('pull'));
    assert.equal((await fetch(new URL('/system/ready', browser.endpoint))).status, 200);
  });
});

test('reuses and restarts its own stopped container without recreating it or its profile', async () => {
  await withEngine(async (engine, dataDir) => {
    const first = await ensureManagedBrowser(options(engine, dataDir));
    const names = await managedBrowserNames(dataDir);
    const container = engine.containers.get(names.container);
    assert.ok(container?.server);
    container.server.close();
    container.server.closeAllConnections();
    container.running = false;
    delete container.server;
    engine.mutations.length = 0;
    const second = await ensureManagedBrowser(options(engine, dataDir));
    assert.equal(second.containerName, first.containerName);
    assert.deepEqual(engine.mutations, [`container start ${names.container}`]);
    assert.equal(engine.containers.size, 1);
    assert.equal(engine.volumes.size, 1);
    assert.equal((await fetch(new URL('/system/ready', second.endpoint))).status, 200);
  });
});

test('an already running owned browser is used as is', async () => {
  await withEngine(async (engine, dataDir) => {
    await ensureManagedBrowser(options(engine, dataDir));
    engine.mutations.length = 0;
    await ensureManagedBrowser(options(engine, dataDir));
    assert.deepEqual(engine.mutations, []);
  });
});

test('different data directories get different containers and profiles', async () => {
  await withEngine(async (engine, dataDir) => {
    const other = `${dataDir}-other`;
    const a = await ensureManagedBrowser(options(engine, dataDir));
    const b = await ensureManagedBrowser(options(engine, other));
    assert.notEqual(a.containerName, b.containerName);
    assert.equal(engine.containers.size, 2);
    assert.equal(engine.volumes.size, 2);
  });
});

test('never touches a foreign container or volume that happens to share the name', async () => {
  await withEngine(async (engine, dataDir) => {
    const names = await managedBrowserNames(dataDir);
    engine.containers.set(names.container, { labels: { app: 'someone-else' }, running: true, privileged: false, publishHost: '127.0.0.1', viewerPort: 1, volume: 'theirs' });
    assert.equal(await codeOf(ensureManagedBrowser(options(engine, dataDir))), 'foreign-container');
    assert.deepEqual(engine.mutations, []);
    engine.containers.clear();
    engine.volumes.set(names.volume, { owner: 'someone-else' });
    assert.equal(await codeOf(ensureManagedBrowser(options(engine, dataDir))), 'foreign-volume');
    assert.deepEqual(engine.mutations, []);
  });
});

test('a container of another data directory is not claimed through a copied label set', async () => {
  await withEngine(async (engine, dataDir) => {
    const names = await managedBrowserNames(dataDir);
    engine.containers.set(names.container, { labels: { 'io.wabgpt.owner': 'wabgpt', 'io.wabgpt.role': 'browser', 'io.wabgpt.scope': 'deadbeefcafe' }, running: false, privileged: false, publishHost: '127.0.0.1', viewerPort: 1, volume: '' });
    assert.equal(await codeOf(ensureManagedBrowser(options(engine, dataDir))), 'foreign-container');
    assert.deepEqual(engine.mutations, []);
  });
});

test('refuses an owned container that is exposed beyond loopback or privileged', async () => {
  await withEngine(async (engine, dataDir) => {
    await ensureManagedBrowser(options(engine, dataDir));
    const names = await managedBrowserNames(dataDir);
    const container = engine.containers.get(names.container);
    assert.ok(container);
    container.publishHost = '0.0.0.0';
    assert.equal(await codeOf(ensureManagedBrowser(options(engine, dataDir))), 'unsafe-container');
    container.publishHost = '127.0.0.1';
    container.privileged = true;
    assert.equal(await codeOf(ensureManagedBrowser(options(engine, dataDir))), 'unsafe-container');
  });
});

test('a stopped owned container configured to publish beyond loopback is rejected before it is started', async () => {
  await withEngine(async (engine, dataDir) => {
    const names = await managedBrowserNames(dataDir);
    engine.containers.set(names.container, {
      labels: { 'io.wabgpt.owner': 'wabgpt', 'io.wabgpt.role': 'browser', 'io.wabgpt.scope': names.scope },
      running: false, privileged: false, publishHost: '127.0.0.1', configuredHost: '0.0.0.0', viewerPort: 1, volume: names.volume,
    });
    assert.equal(await codeOf(ensureManagedBrowser(options(engine, dataDir))), 'unsafe-container');
    assert.deepEqual(engine.mutations, []);
    assert.equal(engine.containers.get(names.container)?.running, false);
  });
});

test('reports a missing Docker and a stopped engine as distinct, actionable failures', async () => {
  await withEngine(async (engine, dataDir) => {
    engine.missing = true;
    assert.equal(await codeOf(ensureManagedBrowser(options(engine, dataDir))), 'docker-missing');
    engine.missing = false;
    engine.up = false;
    assert.equal(await codeOf(ensureManagedBrowser(options(engine, dataDir))), 'docker-unavailable');
    engine.up = true;
    assert.equal((await ensureManagedBrowser(options(engine, dataDir))).containerName.startsWith('wabgpt-neo-'), true);
  });
});

test('a browser that never becomes ready fails with a bounded timeout, keeping the container', async () => {
  await withEngine(async (engine, dataDir) => {
    engine.ready = false;
    assert.equal(await codeOf(ensureManagedBrowser(options(engine, dataDir))), 'not-ready');
    const names = await managedBrowserNames(dataDir);
    assert.equal(engine.containers.has(names.container), true);
    engine.ready = true;
    await ensureManagedBrowser(options(engine, dataDir));
  });
});

test('abort stops waiting for readiness promptly with the abort reason', async () => {
  await withEngine(async (engine, dataDir) => {
    engine.ready = false;
    const controller = new AbortController();
    const started = Date.now();
    const log = (text: string): void => { if (text.startsWith('Waiting')) controller.abort(new Error('cancelled by user')); };
    await assert.rejects(ensureManagedBrowser({ ...options(engine, dataDir, controller.signal), log, readinessTimeoutMs: 60_000 }), /cancelled by user/);
    assert.ok(Date.now() - started < 3000);
  });
});

test('an already aborted signal does no Docker work', async () => {
  await withEngine(async (engine, dataDir) => {
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await assert.rejects(ensureManagedBrowser(options(engine, dataDir, controller.signal)), /stopped/);
    assert.deepEqual(engine.mutations, []);
  });
});

test('a failed settings upload discards the new empty container but keeps the profile volume and never starts it', async () => {
  await withEngine(async (engine, dataDir) => {
    engine.failCopy = true;
    assert.equal(await codeOf(ensureManagedBrowser(options(engine, dataDir))), 'start-failed');
    const names = await managedBrowserNames(dataDir);
    assert.equal(engine.containers.has(names.container), false);
    assert.equal(engine.volumes.has(names.volume), true);
    assert.equal(engine.mutations.some(entry => entry.startsWith('container start')), false);
    engine.failCopy = false;
    assert.equal((await ensureManagedBrowser(options(engine, dataDir))).containerName, names.container);
  });
});

test('a failed first start discards the empty container but keeps the profile volume', async () => {
  await withEngine(async (engine, dataDir) => {
    engine.failStart = true;
    assert.equal(await codeOf(ensureManagedBrowser(options(engine, dataDir))), 'start-failed');
    const names = await managedBrowserNames(dataDir);
    assert.equal(engine.containers.has(names.container), false);
    assert.equal(engine.volumes.has(names.volume), true);
    engine.failStart = false;
    assert.equal((await ensureManagedBrowser(options(engine, dataDir))).containerName, names.container);
  });
});

test('openSetupUrl only opens plain http(s) URLs', async () => {
  await assert.rejects(openSetupUrl('file:///etc/passwd'), /http/);
  await assert.rejects(openSetupUrl('javascript:alert(1)'), /http/);
  await assert.rejects(openSetupUrl('http://user:pass@127.0.0.1:1/'), /http/);
  await assert.rejects(openSetupUrl('not a url'), /valid URL/);
});
