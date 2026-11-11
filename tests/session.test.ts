import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { join } from 'node:path';
import { Application } from '../src/core/application.js';
import type { AssistantAdapter, MessagingAdapter, Project } from '../src/core/contracts.js';
import type { RoutingState } from '../src/core/state.js';
import { fakeAssistant, fakeChannel, loadState, opaqueReferences, providerNames, withDirectory } from './support/core-fixtures.js';

const contact = { id: '14155551234@s.whatsapp.net', name: 'Saved contact' };
const channel = fakeChannel({ contacts: () => [contact], sendText: async () => { assert.fail('No message should be sent by application restoration'); } });
const assistant = fakeAssistant({ reply: async () => { throw new Error('No prompt should be submitted by application restoration'); } });
const metadataFor = (directory: string) => ({ configPath: join(directory, 'config.json'), ...providerNames });
const appOf = (directory: string, store: RoutingState, messaging: MessagingAdapter = channel, backend: AssistantAdapter = assistant): Application => new Application(metadataFor(directory), store, messaging, backend);

test('active sessions resume with their conversation, while a global pause survives subsequent restarts', async () => {
  await withDirectory(async directory => {
    const initial = await loadState(directory);
    await initial.enable(contact);
    await initial.conversation(contact.id, 'https://chatgpt.com/c/retained');
    await initial.setRunning(true);
    const restored = appOf(directory, await loadState(directory));
    await restored.restore();
    assert.equal(restored.snapshot().armed, true);
    assert.equal(restored.snapshot().routes[0]?.conversationRef, 'https://chatgpt.com/c/retained');
    await restored.pause(); await restored.close();
    const paused = appOf(directory, await loadState(directory));
    await paused.restore();
    assert.equal(paused.snapshot().armed, false);
    assert.equal(paused.snapshot().routes[0]?.enabled, true);
    assert.equal(paused.snapshot().routes[0]?.conversationRef, 'https://chatgpt.com/c/retained');
    await paused.close();
  }, 'wabgpt-app-');
});

test('pausing while the assistant connects does not arm forwarding after the connection completes', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory); await store.enable(contact);
    const connecting = Promise.withResolvers<void>();
    const app = appOf(directory, store, channel, fakeAssistant({ start: () => connecting.promise }));
    const resume = app.resume();
    await app.pause(); connecting.resolve(); await resume;
    assert.equal(app.snapshot().armed, false);
    assert.equal((await loadState(directory)).isRunning(), false);
    await app.close();
  }, 'wabgpt-app-');
});

test('configuring a project and lifetime saves a paused route, emits changes, and never starts forwarding or the assistant', async () => {
  await withDirectory(async directory => {
    const project = `https://chatgpt.com/g/g-p-${'c'.repeat(32)}`;
    const app = appOf(directory, await loadState(directory), channel, fakeAssistant({ start: async () => { assert.fail('Configuration must not connect to the assistant'); } }));
    let changes = 0; app.on('change', () => { changes++; });
    await app.setProject(contact, `https://chatgpt.com/g/g-p-${'c'.repeat(32)}-notes/project`);
    await app.setConversationTtl(contact, null);
    assert.ok(changes >= 2);
    const [route] = app.snapshot().routes;
    assert.deepEqual([route?.enabled, route?.projectRef, route?.conversationTtlMinutes, route?.conversationRef], [false, project, null, null]);
    assert.equal(app.snapshot().armed, false);
    const restored = await loadState(directory);
    assert.equal(restored.isRunning(), false);
    assert.equal(restored.route(contact.id)?.projectRef, project);
    await app.setProject(contact, null);
    assert.equal(app.snapshot().routes[0]?.projectRef, null);
    await app.close();
  }, 'wabgpt-app-');
});

test('configuration is rejected while a delivery is working and then leaves the route unchanged', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory);
    await store.enable(contact); await store.claim(`${contact.id}:busy`, contact.id);
    const app = appOf(directory, store);
    await assert.rejects(app.setProject(contact, `https://chatgpt.com/g/g-p-${'c'.repeat(32)}`), /delivered/);
    await assert.rejects(app.setConversationTtl(contact, 5), /delivered/);
    assert.equal(app.snapshot().routes[0]?.projectRef, null);
    assert.equal(app.snapshot().routes[0]?.conversationTtlMinutes, 1440);
    await app.close();
  }, 'wabgpt-app-');
});

test('project catalog discovery is single-flight, never starts the delivery assistant, retries after failure and is awaited by close', async () => {
  await withDirectory(async directory => {
    const projects: Project[] = [{ name: 'Notes', ref: `https://chatgpt.com/g/g-p-${'a'.repeat(32)}` }];
    const pending = Promise.withResolvers<Project[]>();
    let calls = 0; let stopped = false;
    const app = appOf(directory, await loadState(directory), channel, fakeAssistant({
      start: async () => { assert.fail('Catalog discovery must not start the delivery assistant'); },
      stop: async () => { stopped = true; },
      listProjects: () => { calls++; return calls === 1 ? Promise.reject(new Error('ChatGPT is signed out')) : pending.promise; },
    }));
    await assert.rejects(app.listProjects(), /signed out/);
    const first = app.listProjects(); const second = app.listProjects();
    assert.equal(calls, 2);
    assert.equal(first, second);
    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    await tick();
    assert.equal(closed, false); assert.equal(stopped, false);
    await assert.rejects(app.listProjects(), /closing/);
    pending.resolve(projects);
    assert.deepEqual(await first, projects);
    await closing;
    assert.equal(stopped, true);
  }, 'wabgpt-app-');
});

test('catalog results are copies and close is single-flight', async () => {
  await withDirectory(async directory => {
    const catalog: Project[] = [{ name: 'Notes', ref: 'ws:notes' }];
    let stops = 0;
    const release = Promise.withResolvers<void>();
    const app = appOf(directory, await loadState(directory, undefined, opaqueReferences), fakeChannel({ stop: async () => { stops++; await release.promise; } }), fakeAssistant({ references: opaqueReferences, listProjects: async () => catalog }));
    const [listed] = await app.listProjects();
    assert.ok(listed);
    listed.name = 'Changed';
    assert.equal(catalog[0]?.name, 'Notes');
    const first = app.close(); const second = app.close();
    assert.equal(first, second);
    await tick();
    assert.equal(stops, 1);
    release.resolve(); await first;
    await app.close();
    assert.equal(stops, 1);
  }, 'wabgpt-app-');
});

test('restore starts the channel only when the adapter reports a saved session, without any filesystem probe', async () => {
  for (const saved of [true, false]) {
    await withDirectory(async directory => {
      let starts = 0;
      const app = appOf(directory, await loadState(directory), fakeChannel({ hasSavedSession: () => saved, start: async () => { starts++; } }));
      await app.restore();
      await tick();
      assert.equal(starts, saved ? 1 : 0);
      assert.equal(app.snapshot().channelStatus, saved ? 'connecting' : 'disconnected');
      await app.close();
    }, 'wabgpt-app-');
  }
});

test('channel status changes are exposed generically and terminal failures disarm forwarding', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory); await store.enable(contact);
    const logs: string[] = [];
    const app = appOf(directory, store);
    app.on('log', text => logs.push(text));
    await app.resume();
    assert.equal(app.snapshot().armed, true);
    assert.equal(app.snapshot().assistantStatus, 'connected');
    app.setChannelStatus('open');
    assert.equal(app.snapshot().channelStatus, 'open');
    assert.equal(app.snapshot().armed, true);
    app.setChannelStatus('logged-out');
    assert.equal(app.snapshot().channelStatus, 'logged-out');
    assert.equal(app.snapshot().armed, false);
    assert.ok(logs.includes('WhatsApp: logged-out'));
    await app.close();
  }, 'wabgpt-app-');
});

test('setContactEnabled is idempotent desired state and resumes forwarding only when it newly enables', async () => {
  await withDirectory(async directory => {
    let starts = 0;
    const app = appOf(directory, await loadState(directory), channel, fakeAssistant({ start: async () => { starts++; } }));
    await app.setContactEnabled(contact, false);
    assert.deepEqual(app.snapshot().routes, []);
    assert.equal(starts, 0);
    await app.setContactEnabled(contact, true);
    assert.equal(app.snapshot().routes[0]?.enabled, true);
    assert.equal(app.snapshot().armed, true);
    assert.equal(starts, 1);
    await app.pause();
    await app.setContactEnabled(contact, true);
    assert.equal(app.snapshot().armed, false, 'an already enabled contact must not silently resume global forwarding');
    assert.equal(starts, 1);
    await app.setContactEnabled(contact, false);
    await app.setContactEnabled(contact, false);
    assert.equal(app.snapshot().routes[0]?.enabled, false);
    assert.equal(app.snapshot().routes[0]?.error, null);
    await app.toggle(contact);
    assert.equal(app.snapshot().routes[0]?.enabled, true);
    assert.equal(app.snapshot().armed, true);
    await app.toggle(contact);
    assert.equal(app.snapshot().routes[0]?.enabled, false);
    await app.close();
  }, 'wabgpt-app-');
});

test('addContact resolves through the channel, enables the contact once, and rejects unusable input without a route', async () => {
  await withDirectory(async directory => {
    const resolved: string[] = [];
    const app = appOf(directory, await loadState(directory), fakeChannel({
      resolveContact: input => {
        resolved.push(input);
        if (input === 'bad') throw new Error('Enter a full international number.');
        return { id: '15555550123@s.whatsapp.net', name: '+15555550123' };
      },
    }));
    await assert.rejects(app.addContact('bad'), /international/);
    assert.deepEqual(app.snapshot().routes, []);
    const added = await app.addContact('+1 555 555 0123');
    assert.deepEqual(added, { id: '15555550123@s.whatsapp.net', name: '+15555550123' });
    assert.equal(app.snapshot().routes[0]?.enabled, true);
    await app.pause();
    await app.addContact('+1 555 555 0123');
    assert.equal(app.snapshot().armed, false);
    assert.equal(app.snapshot().routes.length, 1);
    assert.deepEqual(resolved, ['bad', '+1 555 555 0123', '+1 555 555 0123']);
    await app.close();
  }, 'wabgpt-app-');
});

test('snapshot merges saved routes, recent chats and known contacts into one sorted directory', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory);
    await store.enable({ id: 'route-only', name: 'Zed' });
    const chat = { id: 'chat-only', name: 'Alpha', lastMessageAt: 10, unread: 2, archived: false };
    const app = appOf(directory, store, fakeChannel({ contacts: () => [{ id: 'chat-only', name: 'Renamed Alpha' }, { id: 'contact-only', name: 'Mid' }], chats: () => [chat] }));
    const snapshot = app.snapshot();
    assert.deepEqual(snapshot.directory, [{ id: 'contact-only', name: 'Mid' }, { id: 'chat-only', name: 'Renamed Alpha' }, { id: 'route-only', name: 'Zed' }]);
    assert.deepEqual(snapshot.chats, [chat]);
    await app.close();
  }, 'wabgpt-app-');
});

test('identity links persist through the application and signal a change', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory);
    const app = appOf(directory, store);
    let changes = 0; app.on('change', () => { changes++; });
    await app.linkIdentity({ alias: '123456789@lid', canonical: contact.id });
    assert.equal(changes, 1);
    assert.equal(store.canonicalId('123456789@lid'), contact.id);
    await app.close();
  }, 'wabgpt-app-');
});

test('an application backed by a non-URL reference policy assigns projects and lifetimes without knowing their format', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory, () => 1, opaqueReferences);
    const app = appOf(directory, store, channel, fakeAssistant({ references: opaqueReferences }));
    await app.setProject(contact, 'ws:Research');
    await app.setConversationTtl(contact, 90);
    assert.deepEqual(app.snapshot().routes.map(route => [route.projectRef, route.conversationTtlMinutes, route.enabled]), [['ws:research', 90, false]]);
    await assert.rejects(app.setProject(contact, 'https://chatgpt.com/g/g-p-' + 'a'.repeat(32)), /ws:<name>/);
    assert.equal((await loadState(directory, () => 2, opaqueReferences)).route(contact.id)?.projectRef, 'ws:research');
    await app.close();
  }, 'wabgpt-app-');
});

test('addContact keeps a saved route name when the provider directory is empty, and known provider names win', async () => {
  await withDirectory(async directory => {
    const id = '15555550123@s.whatsapp.net';
    const lid = '987654321@lid';
    const store = await loadState(directory);
    await store.enable({ id, name: 'Saved Name' });
    await store.pause(id);
    await store.linkIdentity({ alias: lid, canonical: id });
    let known: Array<{ id: string; name: string }> = [];
    const app = appOf(directory, store, fakeChannel({
      contacts: () => known,
      resolveContact: input => ({ id: input === 'alias' ? lid : id, name: '+15555550123' }),
    }));
    const added = await app.addContact('+1 555 555 0123');
    assert.deepEqual(added, { id, name: 'Saved Name' });
    assert.deepEqual(app.snapshot().routes.map(route => [route.contactId, route.name, route.enabled]), [[id, 'Saved Name', true]]);
    await app.setContactEnabled(added, false);
    const viaAlias = await app.addContact('alias');
    assert.deepEqual(viaAlias, { id, name: 'Saved Name' });
    assert.equal(app.snapshot().routes[0]?.name, 'Saved Name');
    assert.equal(app.snapshot().routes[0]?.enabled, true);
    await app.setContactEnabled(viaAlias, false);
    known = [{ id, name: 'Fresh Provider Name' }];
    assert.equal((await app.addContact('+1 555 555 0123')).name, 'Fresh Provider Name');
    assert.equal(app.snapshot().routes[0]?.name, 'Fresh Provider Name');
    assert.equal(app.snapshot().routes.length, 1);
    await app.close();
  }, 'wabgpt-app-');
});

/** An assistant whose catalog honours its signal: on abort it finishes asynchronous cleanup, records it, and only then rejects. */
function cancellableCatalog(): { assistant: AssistantAdapter; signals: AbortSignal[]; cleaned: () => number } {
  const signals: AbortSignal[] = [];
  let cleaned = 0;
  const assistant = fakeAssistant({
    listProjects: signal => {
      assert.ok(signal, 'the application must hand the adapter its own cancellation signal');
      signals.push(signal);
      const { promise, reject } = Promise.withResolvers<Project[]>();
      signal.addEventListener('abort', () => { void tick().then(() => { cleaned++; reject(signal.reason); }); }, { once: true });
      return promise;
    },
  });
  return { assistant, signals, cleaned: () => cleaned };
}

test('a catalog caller that aborts is rejected with its reason only after the adapter has drained, and the next lookup starts afresh', async () => {
  await withDirectory(async directory => {
    const { assistant: cancellable, signals, cleaned } = cancellableCatalog();
    const app = appOf(directory, await loadState(directory), channel, cancellable);
    const controller = new AbortController();
    const reason = new Error('setup cancelled');
    const first = app.listProjects(controller.signal);
    const settled = assert.rejects(first, error => error === reason);
    assert.equal(signals.length, 1);
    controller.abort(reason);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(cleaned(), 0);
    await settled;
    assert.equal(cleaned(), 1);
    // The cancelled lookup is never joined; a new one starts its own read with its own signal.
    const second = app.listProjects(new AbortController().signal);
    assert.equal(signals.length, 2);
    assert.notEqual(signals[1], signals[0]);
    assert.equal(signals[1]?.aborted, false);
    const secondRejected = assert.rejects(second, /closing/);
    await app.close();
    await secondRejected;
    assert.equal(cleaned(), 2);
  }, 'wabgpt-app-');
});

test('one caller aborting does not cancel a catalog another caller still waits for, but the last one leaving does', async () => {
  await withDirectory(async directory => {
    const { assistant: cancellable, signals, cleaned } = cancellableCatalog();
    const app = appOf(directory, await loadState(directory), channel, cancellable);
    const a = new AbortController(); const b = new AbortController();
    const first = app.listProjects(a.signal); const second = app.listProjects(b.signal);
    assert.equal(signals.length, 1);
    const firstRejected = assert.rejects(first, /first left/);
    a.abort(new Error('first left'));
    await firstRejected;
    assert.equal(signals[0]?.aborted, false);
    const secondRejected = assert.rejects(second, /second left/);
    b.abort(new Error('second left'));
    assert.equal(signals[0]?.aborted, true);
    await secondRejected;
    assert.equal(cleaned(), 1);
    await app.close();
  }, 'wabgpt-app-');
});

test('a caller without a signal keeps the catalog alive when a signalled caller leaves; close then cancels it and waits for the adapter to drain', async () => {
  await withDirectory(async directory => {
    const { assistant: cancellable, signals, cleaned } = cancellableCatalog();
    const stops: string[] = [];
    const app = appOf(directory, await loadState(directory), fakeChannel({ stop: async () => { stops.push(`channel:${cleaned()}`); } }), { ...cancellable, stop: async () => { stops.push(`assistant:${cleaned()}`); } });
    const leaving = new AbortController();
    const pinned = app.listProjects();
    const signalled = app.listProjects(leaving.signal);
    const signalledRejected = assert.rejects(signalled, /left/);
    leaving.abort(new Error('left'));
    await signalledRejected;
    assert.equal(signals.length, 1);
    assert.equal(signals[0]?.aborted, false);
    const pinnedRejected = assert.rejects(pinned, /closing/);
    await app.close();
    await pinnedRejected;
    assert.equal(signals[0]?.aborted, true);
    assert.deepEqual(stops, ['channel:1', 'assistant:1']);
  }, 'wabgpt-app-');
});

test('an already aborted signal is rejected without touching the adapter', async () => {
  await withDirectory(async directory => {
    const { assistant: cancellable, signals } = cancellableCatalog();
    const app = appOf(directory, await loadState(directory), channel, cancellable);
    await assert.rejects(app.listProjects(AbortSignal.abort(new Error('already cancelled'))), /already cancelled/);
    assert.equal(signals.length, 0);
    await app.close();
  }, 'wabgpt-app-');
});
