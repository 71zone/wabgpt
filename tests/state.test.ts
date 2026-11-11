import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chatgptReferences } from '../src/adapters/chatgpt/references.js';
import { createJsonStatePersistence } from '../src/adapters/storage/json-state.js';
import { RoutingState, type PersistedState } from '../src/core/state.js';
import { aliasPair, loadState, memoryPersistence, minute, opaqueReferences, projectA, projectB, withDirectory } from './support/core-fixtures.js';

const contact = { id: aliasPair.canonical, name: 'Contact' };
const aliasContact = { id: aliasPair.alias, name: 'Contact' };
const other = { id: '22222222222@s.whatsapp.net', name: 'Other' };

test('merging verified identities retains the conversation and suppresses duplicate delivery across aliases and restart', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory);
    await store.enable(contact);
    await store.enable(aliasContact);
    await store.conversation(aliasPair.alias, 'https://chatgpt.com/c/retained');
    await store.claim(`${aliasPair.alias}:message-1`, aliasPair.alias);
    await store.linkIdentity(aliasPair);
    await store.finish(`${aliasPair.alias}:message-1`, aliasPair.alias, 'done');
    assert.deepEqual(store.routes().map(route => route.contactId), [aliasPair.canonical]);
    assert.equal(store.route(aliasPair.alias)?.conversationRef, 'https://chatgpt.com/c/retained');
    assert.equal(store.route(aliasPair.canonical)?.enabled, true);
    const restored = await loadState(directory);
    assert.equal(restored.route(aliasPair.alias)?.conversationRef, 'https://chatgpt.com/c/retained');
    assert.equal(restored.route(aliasPair.canonical)?.enabled, true);
    assert.equal(await restored.claim(`${aliasPair.canonical}:message-1`, aliasPair.canonical), false);
    assert.equal(await restored.claim(`${aliasPair.alias}:message-1`, aliasPair.alias), false);
  });
});

test('conflicting saved conversations are not silently discarded during identity merging', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory);
    await store.enable(contact);
    await store.enable(aliasContact);
    await store.conversation(aliasPair.canonical, 'https://chatgpt.com/c/phone-history');
    await store.conversation(aliasPair.alias, 'https://chatgpt.com/c/lid-history');
    const before = store.routes();
    await assert.rejects(store.linkIdentity(aliasPair));
    assert.deepEqual(store.routes(), before);
    assert.equal(store.canonicalId(aliasPair.alias), aliasPair.alias);
    assert.deepEqual((await loadState(directory)).routes(), before);
  });
});

test('a conversation lives for a fixed lifetime from its first saved reference and expires exactly at the boundary', async () => {
  await withDirectory(async directory => {
    let clock = 1_000_000;
    const store = await loadState(directory, () => clock);
    await store.setConversationTtl(contact, 10);
    await store.conversation(contact.id, 'https://chatgpt.com/c/first');
    clock += 9 * minute;
    await store.conversation(contact.id, 'https://chatgpt.com/c/first');
    assert.equal(store.route(contact.id)?.conversationStartedAt, 1_000_000);
    clock = 1_000_000 + 10 * minute - 1;
    assert.equal((await store.refreshConversation(contact.id))?.conversationRef, 'https://chatgpt.com/c/first');
    clock = 1_000_000 + 10 * minute;
    const expired = await store.refreshConversation(contact.id);
    assert.equal(expired?.conversationRef, null);
    assert.equal(expired?.conversationStartedAt, null);
    const restored = await loadState(directory, () => clock);
    assert.equal(restored.route(contact.id)?.conversationRef, null);
    assert.equal(restored.route(contact.id)?.conversationStartedAt, null);
    await restored.conversation(contact.id, 'https://chatgpt.com/c/second');
    assert.equal(restored.route(contact.id)?.conversationStartedAt, clock);
  });
});

test('a conversation with no lifetime never expires and a lifetime change keeps the original birth', async () => {
  await withDirectory(async directory => {
    let clock = 5_000;
    const store = await loadState(directory, () => clock);
    await store.enable(contact);
    await store.conversation(contact.id, 'https://chatgpt.com/c/old');
    await store.setConversationTtl(contact, null);
    clock += 10_000 * minute;
    assert.equal((await store.refreshConversation(contact.id))?.conversationRef, 'https://chatgpt.com/c/old');
    await store.setConversationTtl(contact, 1);
    assert.equal(store.route(contact.id)?.conversationStartedAt, 5_000);
    assert.equal((await store.refreshConversation(contact.id))?.conversationRef, null);
    await assert.rejects(store.setConversationTtl(contact, 0));
    await assert.rejects(store.setConversationTtl(contact, 1.5));
    await assert.rejects(store.setConversationTtl(contact, Number.NaN));
  });
});

test('conversation birth is saved once and survives restart', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory, () => 111);
    await store.enable(contact);
    await store.conversation(contact.id, 'https://chatgpt.com/c/born');
    const restored = await loadState(directory, () => 999_999);
    await restored.conversation(contact.id, 'https://chatgpt.com/c/born');
    assert.equal(restored.route(contact.id)?.conversationStartedAt, 111);
    assert.equal((await loadState(directory, () => 888_888)).route(contact.id)?.conversationStartedAt, 111);
  });
});

test('legacy version 1 conversations migrate to version 2 with one baseline birth, unchanged ids and keys, and a preserved original', async () => {
  await withDirectory(async directory => {
    const legacy = { version: 1, running: true, aliases: [{ lid: aliasPair.alias, pn: aliasPair.canonical }], routes: [
      { jid: contact.id, name: 'Contact', enabled: true, conversationUrl: 'https://chatgpt.com/c/legacy', error: null },
      { jid: other.id, name: 'Other', enabled: false, conversationUrl: null, error: null },
    ], deliveries: [{ key: `${contact.id}:old`, jid: contact.id, status: 'done' }, { key: `${aliasPair.alias}:older`, jid: aliasPair.alias, status: 'failed' }] };
    const original = JSON.stringify(legacy);
    await writeFile(join(directory, 'state.json'), original);
    const migrated = await loadState(directory, () => 70_000);
    assert.deepEqual(migrated.route(contact.id), { contactId: contact.id, name: 'Contact', enabled: true, conversationRef: 'https://chatgpt.com/c/legacy', projectRef: null, conversationTtlMinutes: 1440, conversationStartedAt: 70_000, error: null });
    assert.deepEqual(migrated.route(other.id), { contactId: other.id, name: 'Other', enabled: false, conversationRef: null, projectRef: null, conversationTtlMinutes: 1440, conversationStartedAt: null, error: null });
    assert.equal(await migrated.claim(`${contact.id}:old`, contact.id), false);
    assert.equal(await migrated.claim(`${aliasPair.alias}:older`, aliasPair.alias), false);
    const written = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as PersistedState;
    assert.equal(written.version, 2);
    assert.equal(written.running, true);
    assert.deepEqual(written.aliases, [aliasPair]);
    assert.deepEqual(written.deliveries.slice(0, 2), [{ key: `${contact.id}:old`, contactId: contact.id, status: 'done' }, { key: `${aliasPair.alias}:older`, contactId: aliasPair.alias, status: 'failed' }]);
    assert.equal(await readFile(join(directory, 'state.json.v1.bak'), 'utf8'), original);
    assert.equal(((await stat(join(directory, 'state.json.v1.bak'))).mode & 0o777), 0o600);
    const again = await loadState(directory, () => 90_000_000);
    assert.equal(again.route(contact.id)?.conversationStartedAt, 70_000);
    assert.equal(await readFile(join(directory, 'state.json.v1.bak'), 'utf8'), original);
  });
});

test('legacy version 1 projects, lifetimes and interrupted deliveries migrate with their values intact', async () => {
  const persistence = memoryPersistence({ version: 1, running: false, aliases: [], routes: [
    { jid: contact.id, name: 'Contact', enabled: true, conversationUrl: `${projectA}-notes/c/chat-1?x=1`, error: null, projectUrl: `${projectA}-notes/project`, conversationTtlMinutes: null, conversationStartedAt: 42 },
    { jid: other.id, name: 'Other', enabled: true, conversationUrl: null, error: null, projectUrl: projectB, conversationTtlMinutes: 30, conversationStartedAt: null },
  ], deliveries: [{ key: `${other.id}:busy`, jid: other.id, status: 'working' }] });
  const store = await RoutingState.load(persistence, chatgptReferences, () => 1);
  assert.deepEqual(store.route(contact.id), { contactId: contact.id, name: 'Contact', enabled: true, conversationRef: `${projectA}/c/chat-1`, projectRef: projectA, conversationTtlMinutes: null, conversationStartedAt: 42, error: null });
  const quarantined = store.route(other.id);
  assert.equal(quarantined?.enabled, false);
  assert.match(quarantined?.error ?? '', /Interrupted delivery/);
  assert.equal(quarantined?.projectRef, projectB);
  assert.equal(quarantined?.conversationTtlMinutes, 30);
  assert.equal(await store.claim(`${other.id}:busy`, other.id), false);
  assert.equal(persistence.writes.length, 1);
  assert.equal(persistence.writes[0]?.version, 2);
  assert.equal(persistence.writes[0]?.deliveries[0]?.status, 'failed');
});

test('a rejected migration leaves the stored document untouched and writes nothing', async () => {
  const projectRoute = { jid: contact.id, name: 'Contact', enabled: false, error: null, projectUrl: projectA, conversationTtlMinutes: 1440, conversationStartedAt: 1 };
  const bad = [
    { version: 1, running: false, aliases: [], routes: [{ ...projectRoute, conversationUrl: 'https://chatgpt.com/c/standalone' }], deliveries: [] },
    { version: 1, running: false, aliases: [], routes: [{ ...projectRoute, conversationUrl: null }, { ...projectRoute, jid: other.id, conversationUrl: null }], deliveries: [] },
    { version: 1, running: false, aliases: [], routes: [{ ...projectRoute, conversationUrl: null, projectUrl: 'https://example.com/g/x' }], deliveries: [] },
    { version: 1, running: false, aliases: [{ lid: 'not-a-lid', pn: aliasPair.canonical }], routes: [], deliveries: [] },
    { version: 3, running: false, aliases: [], routes: [], deliveries: [] },
    { version: 2, running: false, aliases: [{ alias: 'a', canonical: 'b' }, { alias: 'b', canonical: 'c' }], routes: [], deliveries: [] },
    { version: 2, running: false, aliases: [], routes: [], deliveries: [{ key: 'k', contactId: '', status: 'done' }] },
  ];
  for (const document of bad) {
    const persistence = memoryPersistence(document);
    await assert.rejects(RoutingState.load(persistence, chatgptReferences), Error, JSON.stringify(document));
    assert.deepEqual(persistence.writes, []);
    assert.deepEqual(persistence.stored(), document);
  }
  await withDirectory(async directory => {
    const text = JSON.stringify(bad[0]);
    await writeFile(join(directory, 'state.json'), text);
    await assert.rejects(loadState(directory), /does not match its saved project/);
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), text);
    assert.deepEqual((await readdir(directory)).sort(), ['state.json']);
    await writeFile(join(directory, 'state.json'), '{ not json');
    await assert.rejects(loadState(directory), SyntaxError);
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), '{ not json');
  });
});

test('changing a project drops the local conversation, an unchanged project does not, and projects are unique per contact', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory, () => 1);
    await store.setProject(contact, projectA);
    await store.conversation(contact.id, `${projectA}/c/chat-1`);
    await store.setProject(contact, `https://chatgpt.com/g/g-p-${'a'.repeat(32)}-slug/project`);
    assert.equal(store.route(contact.id)?.conversationRef, `${projectA}/c/chat-1`);
    assert.equal(store.route(contact.id)?.conversationStartedAt, 1);
    await assert.rejects(store.setProject(other, projectA), /another contact/);
    assert.equal(store.route(other.id), undefined);
    await store.setProject(contact, projectB);
    assert.equal(store.route(contact.id)?.projectRef, projectB);
    assert.equal(store.route(contact.id)?.conversationRef, null);
    assert.equal(store.route(contact.id)?.conversationStartedAt, null);
    await store.setProject(other, projectA);
    await assert.rejects(store.conversation(contact.id, `${projectA}/c/chat-1`));
    await store.conversation(contact.id, `${projectB}/c/chat-2`);
    await store.setProject(contact, null);
    assert.equal(store.route(contact.id)?.projectRef, null);
    assert.equal(store.route(contact.id)?.conversationRef, null);
    await assert.rejects(store.setProject(contact, 'https://example.com/g/g-p-' + 'a'.repeat(32)));
    const restored = await loadState(directory, () => 1);
    assert.equal(restored.route(other.id)?.projectRef, projectA);
  });
});

test('project and lifetime changes are rejected while a delivery is working and allowed once it finishes', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory);
    await store.enable(contact);
    await store.claim(`${contact.id}:busy`, contact.id);
    await assert.rejects(store.setProject(contact, projectA), /delivered/);
    await assert.rejects(store.setConversationTtl(contact, 5), /delivered/);
    assert.equal(store.route(contact.id)?.projectRef, null);
    assert.equal(store.route(contact.id)?.conversationTtlMinutes, 1440);
    await store.setProject(other, projectB);
    await store.finish(`${contact.id}:busy`, contact.id, 'done');
    await store.setProject(contact, projectA);
    await store.setConversationTtl(contact, 5);
    assert.equal(store.route(contact.id)?.projectRef, projectA);
    assert.equal(store.route(contact.id)?.conversationTtlMinutes, 5);
  });
});

test('configuring an untouched contact creates a paused route and never enables forwarding', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory);
    await store.setProject(contact, projectA);
    await store.setConversationTtl(other, 30);
    for (const [id, project, ttl] of [[contact.id, projectA, 1440], [other.id, null, 30]] as const) {
      const route = store.route(id);
      assert.equal(route?.enabled, false);
      assert.equal(route?.error, null);
      assert.equal(route?.projectRef, project);
      assert.equal(route?.conversationTtlMinutes, ttl);
    }
    assert.equal(store.isRunning(), false);
    assert.deepEqual((await loadState(directory)).routes().map(route => route.enabled), [false, false]);
  });
});

test('merging aliases keeps the project, lifetime and earliest conversation birth of both routes', async () => {
  await withDirectory(async directory => {
    let clock = 100;
    const store = await loadState(directory, () => clock);
    await store.setProject(aliasContact, projectA);
    await store.setConversationTtl(aliasContact, 60);
    await store.conversation(aliasPair.alias, `${projectA}/c/shared`);
    clock = 200;
    await store.enable(contact);
    await store.linkIdentity(aliasPair);
    const merged = store.route(aliasPair.alias);
    assert.equal(merged?.contactId, aliasPair.canonical);
    assert.equal(merged?.projectRef, projectA);
    assert.equal(merged?.conversationTtlMinutes, 60);
    assert.equal(merged?.conversationRef, `${projectA}/c/shared`);
    assert.equal(merged?.conversationStartedAt, 100);
    await assert.rejects(store.setProject(other, projectA), /another contact/);
    const restored = await loadState(directory, () => 300);
    assert.deepEqual(restored.route(aliasPair.canonical), merged);
  });
});

test('conflicting alias projects or a conversation outside the merged project are rejected before any mutation', async () => {
  for (const scenario of ['projects', 'conversation'] as const) {
    await withDirectory(async directory => {
      const store = await loadState(directory, () => 1);
      if (scenario === 'projects') {
        await store.setProject(contact, projectA);
        await store.setProject(aliasContact, projectB);
      } else {
        await store.setProject(contact, projectA);
        await store.enable(aliasContact);
        await store.conversation(aliasPair.alias, 'https://chatgpt.com/c/standalone');
      }
      await store.claim(`${aliasPair.alias}:m`, aliasPair.alias);
      const before = store.routes();
      await assert.rejects(store.linkIdentity(aliasPair));
      assert.deepEqual(store.routes(), before);
      assert.equal(store.canonicalId(aliasPair.alias), aliasPair.alias);
      await store.finish(`${aliasPair.alias}:m`, aliasPair.alias, 'done');
      assert.deepEqual((await loadState(directory, () => 1)).routes(), before);
    });
  }
});

test('identity aliases cannot form self links or chains, before or after loading', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory);
    await assert.rejects(store.linkIdentity({ alias: 'x', canonical: 'x' }));
    await store.linkIdentity({ alias: 'a', canonical: 'b' });
    await store.linkIdentity({ alias: 'a', canonical: 'b' });
    await assert.rejects(store.linkIdentity({ alias: 'b', canonical: 'c' }), /canonical identity/);
    await assert.rejects(store.linkIdentity({ alias: 'c', canonical: 'a' }), /itself an alias/);
    assert.equal(store.canonicalId('a'), 'b');
    assert.equal(store.canonicalId('b'), 'b');
    assert.equal((await loadState(directory)).canonicalId('a'), 'b');
  });
});

test('loading rejects a saved conversation that does not belong to its saved project', async () => {
  await withDirectory(async directory => {
    const route = { jid: contact.id, name: 'Contact', enabled: false, error: null, projectUrl: projectA, conversationUrl: 'https://chatgpt.com/c/standalone', conversationTtlMinutes: 1440, conversationStartedAt: 1 };
    await writeFile(join(directory, 'state.json'), JSON.stringify({ version: 1, running: false, aliases: [], routes: [route], deliveries: [] }));
    await assert.rejects(loadState(directory), /does not match its saved project/);
    await writeFile(join(directory, 'state.json'), JSON.stringify({ version: 1, running: false, aliases: [], routes: [{ ...route, conversationUrl: null }, { ...route, jid: other.id, conversationUrl: null, projectUrl: `${projectA}-slug/project` }], deliveries: [] }));
    await assert.rejects(loadState(directory), /more than one contact/);
  });
});

test('loading rejects fractional or oversized lifetimes and unusable timestamps', async () => {
  await withDirectory(async directory => {
    const route = { jid: contact.id, name: 'Contact', enabled: false, error: null, projectUrl: null, conversationUrl: 'https://chatgpt.com/c/one', conversationTtlMinutes: 1440, conversationStartedAt: 1 };
    for (const patch of [{ conversationTtlMinutes: 1.5 }, { conversationTtlMinutes: 0 }, { conversationTtlMinutes: Number.MAX_SAFE_INTEGER }, { conversationStartedAt: -1 }, { conversationStartedAt: 1.5 }]) {
      await writeFile(join(directory, 'state.json'), JSON.stringify({ version: 1, running: false, aliases: [], routes: [{ ...route, ...patch }], deliveries: [] }));
      await assert.rejects(loadState(directory), Error, JSON.stringify(patch));
    }
    await writeFile(join(directory, 'state.json'), JSON.stringify({ version: 1, running: false, aliases: [], routes: [{ ...route, conversationTtlMinutes: null }], deliveries: [] }));
    assert.equal((await loadState(directory)).route(contact.id)?.conversationTtlMinutes, null);
    await assert.rejects(loadState(directory, () => -5), /unusable timestamp/);
  });
});

test('persisted alias routes with the same project and conversation load, then merge keeping policy and earliest birth; distinct contacts cannot share them', async () => {
  await withDirectory(async directory => {
    const shared = { enabled: false, error: null, projectRef: projectA, conversationRef: `${projectA}/c/shared` };
    const aliasRoute = { ...shared, contactId: aliasPair.alias, name: 'Contact', conversationTtlMinutes: 30, conversationStartedAt: 50 };
    const canonicalRoute = { ...shared, contactId: aliasPair.canonical, name: 'Contact', conversationTtlMinutes: 1440, conversationStartedAt: 80 };
    const document = (routes: unknown[], aliases: unknown[] = []) => JSON.stringify({ version: 2, running: false, aliases, routes, deliveries: [] });
    await writeFile(join(directory, 'state.json'), document([aliasRoute, canonicalRoute], [aliasPair]));
    const store = await loadState(directory, () => 1000);
    assert.equal(store.routes().length, 2);
    await store.linkIdentity(aliasPair);
    assert.deepEqual(store.routes(), [{ ...canonicalRoute, conversationTtlMinutes: 30, conversationStartedAt: 50 }]);
    assert.deepEqual((await loadState(directory, () => 2000)).routes(), store.routes());

    const unshared = { ...canonicalRoute, contactId: other.id, name: 'Other' };
    const sameProject = [{ ...canonicalRoute, conversationRef: null }, { ...unshared, conversationRef: null }];
    const sameConversation = [{ ...canonicalRoute, projectRef: null, conversationRef: 'https://chatgpt.com/c/shared' }, { ...unshared, projectRef: null, conversationRef: 'https://chatgpt.com/c/shared' }];
    for (const routes of [sameProject, sameConversation]) {
      await writeFile(join(directory, 'state.json'), document(routes));
      await assert.rejects(loadState(directory), /more than one contact/);
    }
    await writeFile(join(directory, 'state.json'), document([canonicalRoute, { ...canonicalRoute }]));
    await assert.rejects(loadState(directory), /more than one route/);
  });
});

test('opaque non-URL provider references are validated by the injected policy and round-trip unchanged', async () => {
  await withDirectory(async directory => {
    const store = await loadState(directory, () => 5, opaqueReferences);
    await store.setProject(contact, 'ws:Alpha');
    assert.equal(store.route(contact.id)?.projectRef, 'ws:alpha');
    await store.conversation(contact.id, 'ws:alpha/thread:t1');
    assert.equal(store.route(contact.id)?.conversationRef, 'ws:alpha/thread:t1');
    await assert.rejects(store.conversation(contact.id, 'thread:t2'), /workspace/);
    await assert.rejects(store.setProject(contact, projectA), /ws:<name>/);
    await assert.rejects(store.setProject(other, 'ws:ALPHA'), /another contact/);
    await store.setProject(other, 'ws:beta');
    await assert.rejects(store.conversation(other.id, 'ws:alpha/thread:t1'));
    await store.setProject(contact, 'ws:gamma');
    assert.equal(store.route(contact.id)?.conversationRef, null);
    await store.setProject(contact, null);
    await store.conversation(contact.id, 'thread:t9');
    const restored = await loadState(directory, () => 6, opaqueReferences);
    assert.deepEqual(restored.route(contact.id), { contactId: contact.id, name: 'Contact', enabled: false, conversationRef: 'thread:t9', projectRef: null, conversationTtlMinutes: 1440, conversationStartedAt: 5, error: null });
    assert.equal(restored.route(other.id)?.projectRef, 'ws:beta');
    await assert.rejects(loadState(directory, () => 7, chatgptReferences), /Saved conversation|Project URL|ChatGPT/);
    assert.equal((await loadState(directory, () => 8, opaqueReferences)).route(contact.id)?.conversationRef, 'thread:t9');
  });
});

test('legacy version 1 data can be migrated through a non-URL policy only when its references satisfy that policy', async () => {
  const legacy = { version: 1, running: false, aliases: [], routes: [{ jid: contact.id, name: 'Contact', enabled: false, conversationUrl: 'https://chatgpt.com/c/x', error: null }], deliveries: [] };
  const persistence = memoryPersistence(legacy);
  await assert.rejects(RoutingState.load(persistence, opaqueReferences), /Thread reference/);
  assert.deepEqual(persistence.writes, []);
  assert.deepEqual(persistence.stored(), legacy);
});

test('state writes keep call order even when an earlier write is slow', async () => {
  const order: number[] = [];
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const persistence = {
    read: async () => undefined,
    write: async (state: PersistedState) => {
      const call = ++calls;
      if (call === 2) await release.promise;
      order.push(state.deliveries.length);
    },
  };
  const store = await RoutingState.load(persistence, chatgptReferences);
  const first = store.claim('one', contact.id);
  const second = store.claim('two', contact.id);
  const third = store.claim('three', contact.id);
  release.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test('JSON state persistence is private, atomic, serialized and reports absence as undefined', async () => {
  await withDirectory(async directory => {
    const persistence = createJsonStatePersistence(join(directory, 'nested', 'data'));
    assert.equal(await persistence.read(), undefined);
    const base: PersistedState = { version: 2, running: false, aliases: [], routes: [], deliveries: [] };
    const writes = Array.from({ length: 20 }, (_, index) => persistence.write({ ...base, deliveries: [{ key: String(index), contactId: 'x', status: 'done' }] }));
    await Promise.all(writes);
    const data = join(directory, 'nested', 'data');
    assert.deepEqual(await persistence.read(), { ...base, deliveries: [{ key: '19', contactId: 'x', status: 'done' }] });
    assert.equal((await stat(data)).mode & 0o777, 0o700);
    assert.equal((await stat(join(data, 'state.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(data), ['state.json']);
    await writeFile(join(data, 'state.json.tmp'), 'stale', { mode: 0o644 });
    await persistence.write(base);
    assert.equal((await stat(join(data, 'state.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(data), ['state.json']);
  });
});

test('opaque ids containing colons keep delivery keys owner-aware across alias merges and restart', async () => {
  await withDirectory(async directory => {
    const alias = { alias: 'chan:a:lid1', canonical: 'chan:a:pn1' };
    const store = await loadState(directory);
    await store.enable({ id: alias.alias, name: 'Contact' });
    assert.equal(await store.claim(`${alias.alias}:m:1`, alias.alias), true);
    await store.linkIdentity(alias);
    assert.equal(await store.claim(`${alias.alias}:m:1`, alias.alias), false);
    assert.equal(await store.claim(`${alias.canonical}:m:1`, alias.canonical), false);
    await store.finish(`${alias.alias}:m:1`, alias.alias, 'done');
    const stored = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as PersistedState;
    assert.deepEqual(stored.deliveries, [{ key: `${alias.canonical}:m:1`, contactId: alias.canonical, status: 'done' }]);
    const restored = await loadState(directory);
    assert.equal(await restored.claim(`${alias.alias}:m:1`, alias.alias), false);
    assert.equal(await restored.claim(`${alias.canonical}:m:1`, alias.canonical), false);
    assert.equal(await restored.claim(`${alias.canonical}:m:2`, alias.canonical), true);
  });
});

test('the same raw delivery key for different contacts never collides, and finishing needs the owning contact', async () => {
  await withDirectory(async directory => {
    const shortOwner = { id: 'a', name: 'Short' };
    const longOwner = { id: 'a:b', name: 'Long' };
    const store = await loadState(directory);
    await store.enable(shortOwner); await store.enable(longOwner);
    assert.equal(await store.claim('a:b:c', shortOwner.id), true);
    assert.equal(await store.claim('a:b:c', longOwner.id), true);
    assert.equal(await store.claim('a:b:c', shortOwner.id), false);
    assert.equal(await store.claim('a:b:c', longOwner.id), false);
    await assert.rejects(store.finish('a:b:c', 'unrelated', 'done'), /Unknown delivery/);
    await store.finish('a:b:c', shortOwner.id, 'done');
    const stored = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as PersistedState;
    assert.deepEqual(stored.deliveries, [{ key: 'a:b:c', contactId: 'a', status: 'done' }, { key: 'a:b:c', contactId: 'a:b', status: 'working' }]);
    const restored = await loadState(directory);
    assert.equal(restored.route('a')?.enabled, true);
    assert.equal(restored.route('a:b')?.enabled, false);
    assert.match(restored.route('a:b')?.error ?? '', /Interrupted/);
    assert.equal(await restored.claim('a:b:c', shortOwner.id), false);
    assert.equal(await restored.claim('a:b:c', longOwner.id), false);
  });
});

test('merging aliases dedupes journal rows per contact and keeps the strongest status without touching unrelated keys', async () => {
  await withDirectory(async directory => {
    const alias = { alias: 'x:lid', canonical: 'x:pn' };
    const store = await loadState(directory);
    await store.claim('x:lid:m', alias.alias);
    await store.finish('x:lid:m', alias.alias, 'failed');
    await store.claim('x:pn:m', alias.canonical);
    await store.claim('legacy-key-without-owner', alias.alias);
    await store.linkIdentity(alias);
    const stored = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as PersistedState;
    assert.deepEqual(stored.deliveries, [
      { key: 'x:pn:m', contactId: 'x:pn', status: 'working' },
      { key: 'legacy-key-without-owner', contactId: 'x:pn', status: 'working' },
    ]);
  });
});
