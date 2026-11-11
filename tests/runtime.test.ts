import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntime } from '../src/bootstrap.js';
import { parseCommandLine } from '../src/infrastructure/arguments.js';
import { loadConfig } from '../src/infrastructure/config.js';
import { acquireLock } from '../src/infrastructure/lock.js';

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'wa-runtime-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

test('the process lock is exclusive, never auto-removed, and released once', () => withDirectory(async directory => {
  const release = await acquireLock(directory);
  await assert.rejects(acquireLock(directory), /Another bridge may be running.*bridge\.lock/);
  assert.equal(await exists(join(directory, 'bridge.lock')), true);
  await release();
  await release();
  const again = await acquireLock(directory);
  await again();
  assert.equal(await exists(join(directory, 'bridge.lock')), false);
}));

test('a stale lock from a crashed process is left for the operator', () => withDirectory(async directory => {
  await writeFile(join(directory, 'bridge.lock'), '999999');
  await assert.rejects(acquireLock(directory), /remove .*bridge\.lock/);
  assert.equal(await exists(join(directory, 'bridge.lock')), true);
}));

test('one runtime owns the data directory, restores the console on close and never starts providers on its own', () => withDirectory(async directory => {
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ browserMcpUrl: 'http://127.0.0.1:9', dataDir: 'data' }));
  const config = await loadConfig(configPath);
  const info = console.info;
  const runtime = await openRuntime(config);
  try {
    assert.notEqual(console.info, info);
    await assert.rejects(openRuntime(config), /Another bridge may be running/);
    assert.equal(console.info === info, false, 'a failed second open must not touch the first runtime console routing');
    assert.equal(runtime.application.snapshot().channelStatus, 'disconnected');
    assert.equal(runtime.application.snapshot().assistantStatus, 'disconnected');
    assert.equal((await stat(config.dataDir)).mode & 0o777, 0o700);
  } finally {
    await runtime.close();
    await runtime.close();
  }
  assert.equal(console.info, info);
  assert.equal(await exists(join(config.dataDir, 'bridge.lock')), false);
  const reopened = await openRuntime(config);
  await reopened.close();
}));

test('prepare runs under the lock before the Application exists and its config is the one used', () => withDirectory(async directory => {
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ browserMcpUrl: 'http://127.0.0.1:9', dataDir: 'data' }));
  const config = await loadConfig(configPath);
  const info = console.info;
  const chosen = join(directory, 'chosen.json');
  const runtime = await openRuntime(config, {
    prepare: async received => {
      assert.equal(received, config);
      assert.equal(console.info, info, 'console is untouched while preparing');
      await assert.rejects(openRuntime(config), /Another bridge may be running/);
      return { ...received, path: chosen };
    },
  });
  try { assert.equal(runtime.application.metadata.configPath, chosen); }
  finally { await runtime.close(); }
  assert.equal(console.info, info);
}));

test('a failed or cancelled prepare releases the lock and leaves the console alone', () => withDirectory(async directory => {
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ browserMcpUrl: 'http://127.0.0.1:9', dataDir: 'data' }));
  const config = await loadConfig(configPath);
  const info = console.info;
  const cancellation = new AbortController();
  const cancelled = openRuntime(config, {
    prepare: async () => {
      const pending = Promise.withResolvers<never>();
      cancellation.signal.addEventListener('abort', () => pending.reject(cancellation.signal.reason));
      queueMicrotask(() => cancellation.abort(new Error('cancelled')));
      return pending.promise;
    },
  });
  await assert.rejects(cancelled, /cancelled/);
  await assert.rejects(openRuntime(config, { prepare: async () => { throw new Error('browser setup failed'); } }), /browser setup failed/);
  assert.equal(console.info, info);
  assert.equal(await exists(join(config.dataDir, 'bridge.lock')), false);
  await (await openRuntime(config)).close();
}));

test('command line accepts the TUI default, setup, serve, token, help and both config spellings', () => {
  assert.deepEqual(parseCommandLine(['setup']), { command: 'setup' });
  assert.deepEqual(parseCommandLine(['--config=a.json', 'setup']), { command: 'setup', config: 'a.json' });
  assert.deepEqual(parseCommandLine(['setup', '--help']), { command: 'help' });
  assert.deepEqual(parseCommandLine([]), { command: 'tui' });
  assert.deepEqual(parseCommandLine(['--config', 'a.json']), { command: 'tui', config: 'a.json' });
  assert.deepEqual(parseCommandLine(['serve']), { command: 'serve' });
  assert.deepEqual(parseCommandLine(['--config=a.json', 'serve']), { command: 'serve', config: 'a.json' });
  assert.deepEqual(parseCommandLine(['token', '--config', 'a.json']), { command: 'token', config: 'a.json' });
  assert.deepEqual(parseCommandLine(['serve', '--help']), { command: 'help' });
  assert.deepEqual(parseCommandLine(['-h']), { command: 'help' });
  assert.deepEqual(parseCommandLine(['help']), { command: 'help' });
});

test('command line rejects malformed arguments', () => {
  for (const args of [['--config'], ['--config='], ['--config', 'a', '--config', 'b'], ['serve', 'token'], ['serve', 'extra'], ['--bogus'], ['--config', 'a', 'x']]) {
    assert.throws(() => parseCommandLine(args), /Usage: wabgpt/, args.join(' '));
  }
});
