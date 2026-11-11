import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Application } from '../src/core/application.js';
import { serveUntilStopped } from '../src/serve.js';
import { fakeAssistant, fakeChannel, loadState, opaqueReferences, providerNames, withDirectory } from './support/core-fixtures.js';

const ada = { id: '14155550101@s.whatsapp.net', name: 'Ada Example' };

async function until(predicate: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await sleep(10);
  }
}
const reachable = (url: string): Promise<boolean> => fetch(new URL('/api/session', url)).then(reply => reply.status === 200, () => false);

interface Context { application: Application; url: () => string | undefined; closed: () => boolean; calls: string[]; logs: string[]; stop: () => void; done: Promise<void> }

async function serve(run: (context: Context) => Promise<void>, options: { failStarts: number; stopBeforeStart?: boolean }): Promise<void> {
  await withDirectory(async directory => {
    const store = await loadState(join(directory, 'data'), undefined, opaqueReferences);
    await store.enable(ada);
    await store.setRunning(true);
    const calls: string[] = [];
    const logs: string[] = [];
    let failures = options.failStarts;
    const assistant = fakeAssistant({
      references: opaqueReferences,
      start: async () => { calls.push('assistant.start'); if (failures-- > 0) throw new Error('ChatGPT is not signed in.'); },
      stop: async () => { calls.push('assistant.stop'); },
    });
    const channel = fakeChannel({ start: async () => { calls.push('channel.start'); }, stop: async () => { calls.push('channel.stop'); } });
    const application = new Application({ configPath: join(directory, 'config.json'), ...providerNames }, store, channel, assistant);
    application.on('log', message => logs.push(message));
    let closed = false;
    let listening: string | undefined;
    const stopped = Promise.withResolvers<void>();
    if (options.stopBeforeStart) stopped.resolve();
    const runtime = { application, close: async () => { closed = true; await application.close(); } };
    const done = serveUntilStopped({
      runtime, stopped: stopped.promise,
      settings: { host: '127.0.0.1', port: 0, tokenFile: join(directory, 'server-token') },
      output: text => { listening = /listening on (\S+)/.exec(text)?.[1]; },
    });
    try { await run({ application, url: () => listening, closed: () => closed, calls, logs, stop: stopped.resolve, done }); }
    finally { stopped.resolve(); await done.catch(() => undefined); }
  });
}

test('a failed restore keeps the dashboard reachable, forwarding disarmed and the cause logged until a signal', async () => {
  await serve(async ({ application, url, closed, calls, logs, stop, done }) => {
    await until(() => logs.some(message => /could not resume.*not signed in/.test(message)));
    const address = url()!;
    assert.equal(application.snapshot().assistantStatus, 'failed');
    assert.equal(application.snapshot().armed, false);
    assert.equal(closed(), false);
    assert.equal(await reachable(address), true);
    assert.equal(calls.includes('channel.start'), false);
    stop();
    await done;
    assert.equal(closed(), true);
    assert.equal(await reachable(address), false);
  }, { failStarts: 1 });
});

test('after a failed restore the owner can fix the browser and resume without restarting', async () => {
  await serve(async ({ application, url, logs, stop, done }) => {
    await until(() => logs.some(message => /could not resume/.test(message)));
    await application.resume();
    assert.equal(application.snapshot().armed, true);
    assert.equal(await reachable(url()!), true);
    stop();
    await done;
  }, { failStarts: 1 });
});

test('a signal received before restore skips restoring and still closes cleanly', async () => {
  await serve(async ({ calls, closed, done }) => {
    await done;
    assert.equal(closed(), true);
    assert.deepEqual(calls.filter(call => call.endsWith('.start')), []);
  }, { failStarts: 0, stopBeforeStart: true });
});

test('a healthy restore arms forwarding and serves until the signal', async () => {
  await serve(async ({ application, url, closed, stop, done }) => {
    await until(() => url() !== undefined && application.snapshot().armed);
    assert.equal(await reachable(url()!), true);
    assert.equal(closed(), false);
    stop();
    await done;
    assert.equal(closed(), true);
  }, { failStarts: 0 });
});
