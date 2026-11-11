import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadState, opaqueReferences } from './support/core-fixtures.js';
import { activityMessage, asError, asProjects, asState, commandState, sessionInfo, sessionOf, withServer, type Harness } from './support/http-harness.js';

const ada = '14155550101@s.whatsapp.net';
const bob = '14155550102@s.whatsapp.net';

async function assertNothingChanged(harness: Harness): Promise<void> {
  assert.equal(harness.calls.assistantStart, 0);
  assert.equal(harness.calls.channelStart, 0);
  const routes = asState((await harness.api(await harness.signIn(), 'GET', '/api/state')).json).contacts.filter(contact => contact.hasRoute);
  assert.deepEqual(routes, []);
}

test('the public shell and assets carry strict headers and expose no private state', async () => {
  await withServer(async harness => {
    for (const path of ['/', '/index.html', '/app.js', '/app.css']) {
      const reply = await harness.request('GET', path);
      assert.equal(reply.status, 200, path);
      assert.match(String(reply.headers['content-security-policy']), /default-src 'none'; script-src 'self'; style-src 'self'/);
      assert.match(String(reply.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.equal(reply.headers['x-content-type-options'], 'nosniff');
      assert.equal(reply.headers['access-control-allow-origin'], undefined);
      assert.ok(!reply.text.includes(harness.token));
      assert.ok(!reply.text.includes('Ada Example'));
    }
    assert.match(String((await harness.request('GET', '/')).headers['content-type']), /text\/html/);
    assert.equal((await harness.request('HEAD', '/')).text, '');
    assert.equal((await harness.request('GET', '/missing')).status, 404);
    assert.equal((await harness.request('GET', '/../package.json')).status, 404);
    assert.equal((await harness.request('GET', '//evil.example/')).status, 400);
    assert.equal((await harness.request('POST', '/')).status, 405);
    const session = await harness.request('GET', '/api/session');
    assert.deepEqual(session.json, { authenticated: false });
    assert.equal(session.headers['cache-control'], 'no-store');
  });
});

test('every private read, stream and mutation requires a signed-in session', async () => {
  await withServer(async harness => {
    for (const path of ['/api/state', '/api/projects']) assert.equal((await harness.request('GET', path)).status, 401, path);
    assert.equal((await harness.events(null)).status, 401);
    const bogus = { cookie: 'wabgpt_session=not-a-real-session', csrf: 'x' };
    assert.equal((await harness.api(bogus, 'GET', '/api/state')).status, 401);
    for (const path of ['/api/logout', '/api/channel/connect', '/api/browser/check', '/api/forwarding/resume', '/api/forwarding/pause']) {
      assert.equal((await harness.api(bogus, 'POST', path)).status, 401, path);
    }
    assert.equal((await harness.api(bogus, 'POST', '/api/contacts', { input: '+14155550199' })).status, 401);
    assert.equal((await harness.request('GET', '/api/state', { headers: { cookie: `wabgpt_session=${harness.token}` } })).status, 401);
    assert.equal((await harness.request('GET', '/api/state', { headers: { authorization: `Bearer ${harness.token}`, 'x-owner-token': harness.token } })).status, 401);
    await assertNothingChanged(harness);
  });
});

test('unexpected Host headers are rejected while loopback names work on any port', async () => {
  await withServer(async harness => {
    assert.equal((await harness.request('GET', '/', { headers: { host: 'attacker.example' } })).status, 421);
    assert.equal((await harness.request('GET', '/', { headers: { host: `attacker.example:${harness.port}` } })).status, 421);
    assert.equal((await harness.request('GET', '/api/session', { headers: { host: '10.0.0.5:8788' } })).status, 421);
    assert.equal((await harness.request('GET', '/', { headers: { host: 'localhost:9999' } })).status, 200);
    assert.equal((await harness.request('GET', '/', { headers: { host: '[::1]:8788' } })).status, 200);
    assert.equal((await harness.request('GET', '/', { headers: { host: '127.0.0.1:8788' } })).status, 200);
    const rebound = await harness.request('POST', '/api/login', { headers: { host: 'attacker.example', origin: 'http://attacker.example', 'content-type': 'application/json' }, body: JSON.stringify({ token: harness.token }) });
    assert.equal(rebound.status, 421);
    assert.equal(rebound.headers['set-cookie'], undefined);
  });
});

test('login issues an HttpOnly SameSite=Strict session and never leaks the owner token', async () => {
  await withServer(async harness => {
    const reply = await harness.login();
    assert.equal(reply.status, 200);
    const cookie = String(reply.headers['set-cookie']?.[0]);
    assert.match(cookie, /^wabgpt_session=[A-Za-z0-9_-]{43,};/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Strict/);
    assert.match(cookie, /; Max-Age=\d+/);
    assert.doesNotMatch(cookie, /Secure/);
    assert.ok(!reply.text.includes(harness.token));
    assert.ok(!cookie.includes(harness.token));
    const session = sessionOf(reply);
    assert.match(session.csrf, /^[A-Za-z0-9_-]{43,}$/);
    const check = await harness.api(session, 'GET', '/api/session');
    assert.equal(sessionInfo(check).authenticated, true);
    assert.equal(sessionInfo(check).csrfToken, session.csrf);

    const wrong = await harness.login('x'.repeat(43));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers['set-cookie'], undefined);
    assert.equal((await harness.login(`${harness.token}x`)).status, 401);
    assert.equal((await harness.login('')).status, 400);
  });
});

test('login requires a JSON POST from the same origin, a small body and known fields', async () => {
  await withServer(async harness => {
    const body = JSON.stringify({ token: harness.token });
    const post = (headers: Record<string, string | undefined>, payload = body) => harness.request('POST', '/api/login', { headers: { 'content-type': 'application/json', origin: harness.origin, ...headers }, body: payload });
    assert.equal((await post({ origin: undefined })).status, 403);
    assert.equal((await post({ origin: 'http://attacker.example' })).status, 403);
    assert.equal((await post({ origin: 'null' })).status, 403);
    assert.equal((await post({ origin: `http://localhost:${harness.port}` })).status, 403);
    assert.equal((await post({ 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post({ 'content-type': 'application/x-www-form-urlencoded' }, `token=${harness.token}`)).status, 415);
    assert.equal((await post({}, '{not json')).status, 400);
    assert.equal((await post({}, JSON.stringify({ token: harness.token, extra: true }))).status, 400);
    assert.equal((await post({}, JSON.stringify([harness.token]))).status, 400);
    assert.equal((await post({}, JSON.stringify({ token: 'x'.repeat(5000) }))).status, 413);
    const streamed = await harness.request('POST', '/api/login', { headers: { 'content-type': 'application/json', origin: harness.origin }, chunks: [Buffer.alloc(3000, 'a'), Buffer.alloc(3000, 'a')] });
    assert.equal(streamed.status, 413);
    assert.equal((await harness.request('GET', '/api/login')).status, 405);
    assert.equal((await post({})).status, 200);
  });
});

test('repeated failed sign-ins are rate limited, even for the right token, until the window passes', async () => {
  await withServer(async harness => {
    for (let attempt = 0; attempt < 3; attempt++) assert.equal((await harness.login('y'.repeat(43))).status, 401);
    const blocked = await harness.login();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    assert.equal(blocked.headers['set-cookie'], undefined);
    assert.equal(asError(blocked).error, 'too_many_attempts');
  }, { limits: { loginMaxFailures: 3, loginWindowMs: 60_000 } });
});

test('authenticated state is no-store, complete and keeps untrusted text as data', async () => {
  await withServer(async harness => {
    harness.chats.push({ id: '14155550103@s.whatsapp.net', name: 'Recent Chat', lastMessageAt: 1_700_000_000_000, unread: 2, archived: false });
    const session = await harness.signIn();
    const reply = await harness.api(session, 'GET', '/api/state');
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.match(String(reply.headers['content-security-policy']), /default-src 'none'/);
    assert.match(String(reply.headers['content-type']), /^application\/json/);
    const state = asState(reply.json);
    assert.deepEqual(state.app, { channelName: 'WhatsApp', assistantName: 'ChatGPT' });
    assert.equal(state.armed, false);
    assert.equal(state.channelStatus, 'disconnected');
    assert.equal(state.assistantStatus, 'disconnected');
    assert.equal(state.qr, null);
    assert.deepEqual(state.contacts.map(contact => contact.name), ['Ada Example', 'Bob <b>Example</b>', 'Recent Chat']);
    const recent = state.contacts.find(contact => contact.name === 'Recent Chat');
    assert.deepEqual([recent?.unread, recent?.lastMessageAt, recent?.saved, recent?.enabled], [2, 1_700_000_000_000, false, false]);
    assert.ok(!reply.text.includes(harness.token));
    assert.ok(!reply.text.includes('conversationRef'));
  });
});

test('cross-origin reads and streams are refused even with a valid session', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const foreign = { origin: 'http://attacker.example' };
    assert.equal((await harness.api(session, 'GET', '/api/state', undefined, foreign)).status, 403);
    assert.equal((await harness.api(session, 'GET', '/api/session', undefined, foreign)).status, 403);
    assert.equal((await harness.api(session, 'GET', '/api/projects', undefined, foreign)).status, 403);
    assert.equal((await harness.api(session, 'GET', '/api/state', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await harness.api(session, 'GET', '/api/state', undefined, { 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await harness.api(session, 'GET', '/api/state', undefined, { 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal((await harness.api(session, 'GET', '/api/state', undefined, { origin: harness.origin })).status, 200);
    assert.equal((await harness.events(session, foreign)).status, 403);
    const reply = await harness.api(session, 'GET', '/api/state', undefined, foreign);
    assert.equal(reply.headers['access-control-allow-origin'], undefined);
    assert.equal((await harness.request('OPTIONS', '/api/state', { headers: { origin: 'http://attacker.example', 'access-control-request-method': 'GET' } })).status, 403);
  });
});

test('mutations need the CSRF token and a same-origin Origin header, and GET never mutates', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const input = { input: '+1 415 555 0199' };
    const attempts: Array<[string, Record<string, string | undefined>]> = [
      ['no CSRF token', { 'x-csrf-token': undefined }],
      ['wrong CSRF token', { 'x-csrf-token': 'z'.repeat(43) }],
      ['foreign origin', { origin: 'http://attacker.example' }],
      ['missing origin', { origin: undefined }],
      ['cross-site fetch metadata', { 'sec-fetch-site': 'cross-site' }],
    ];
    for (const [label, headers] of attempts) {
      const reply = await harness.request('POST', '/api/contacts', {
        headers: { cookie: session.cookie, 'content-type': 'application/json', origin: harness.origin, 'x-csrf-token': session.csrf, ...headers },
        body: JSON.stringify(input),
      });
      assert.equal(reply.status, 403, label);
    }
    assert.equal((await harness.api(session, 'POST', '/api/contacts', input, { 'content-type': 'text/plain' })).status, 415);
    for (const path of ['/api/contacts', '/api/contacts/enabled', '/api/contacts/project', '/api/contacts/ttl', '/api/forwarding/resume', '/api/forwarding/pause', '/api/channel/connect', '/api/browser/check', '/api/logout', '/api/login']) {
      const reply = await harness.api(session, 'GET', path);
      assert.equal(reply.status, 405, path);
      assert.equal(reply.headers.allow, 'POST');
    }
    assert.equal((await harness.api(session, 'GET', '/api/nope')).status, 404);
    assert.equal((await harness.api(session, 'POST', '/api/nope')).status, 404);
    await assertNothingChanged(harness);
    assert.equal((await harness.api(session, 'POST', '/api/contacts', input)).status, 200);
  });
});

test('command bodies are size limited and strictly parsed', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const raw = (body: string | undefined, headers: Record<string, string> = {}) => harness.request('POST', '/api/contacts/enabled', { headers: { cookie: session.cookie, 'content-type': 'application/json', origin: harness.origin, 'x-csrf-token': session.csrf, ...headers }, body });
    assert.equal((await raw('x'.repeat(9000))).status, 413);
    assert.equal((await raw('{oops')).status, 400);
    assert.equal((await raw(JSON.stringify({ contactId: ada, enabled: 'yes' }))).status, 400);
    assert.equal((await raw(JSON.stringify({ contactId: ada }))).status, 400);
    assert.equal((await raw(JSON.stringify({ contactId: ada, enabled: true, config: '/etc/passwd' }))).status, 400);
    assert.equal((await raw(JSON.stringify({ contactId: '', enabled: true }))).status, 400);
    assert.equal(asError(await raw(JSON.stringify({ contactId: '99999@s.whatsapp.net', enabled: true }))).error, 'unknown_contact');
    assert.equal((await harness.api(session, 'POST', '/api/forwarding/pause', { surprise: 1 })).status, 400);
    await assertNothingChanged(harness);
  });
});

test('adding a contact enables it, starts forwarding through the guarded path and persists across a restart', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const rejected = await harness.api(session, 'POST', '/api/contacts', { input: 'not a number' });
    assert.equal(rejected.status, 422);
    assert.match(asError(rejected).message, /international number/);
    assert.equal(harness.calls.assistantStart, 0);

    const added = await harness.api(session, 'POST', '/api/contacts', { input: '+1 (415) 555-0199' });
    assert.equal(added.status, 200);
    const state = commandState(added);
    const route = state.contacts.find(contact => contact.id === '14155550199@s.whatsapp.net');
    assert.deepEqual([route?.name, route?.enabled, route?.hasRoute, state.armed, state.enabledCount, state.assistantStatus], ['+14155550199', true, true, true, 1, 'connected']);
    assert.equal(harness.calls.assistantStart, 1);
    assert.equal(harness.calls.channelStart, 1);
    assert.deepEqual(harness.calls.sent, []);

    const saved = await harness.persisted();
    assert.equal(saved.version, 2);
    assert.equal(saved.running, true);
    assert.deepEqual(saved.routes.map(item => [item.contactId, item.enabled, item.conversationRef]), [['14155550199@s.whatsapp.net', true, null]]);
    const reloaded = await loadState(join(harness.directory, 'data'), undefined, opaqueReferences);
    assert.equal(reloaded.route('14155550199@s.whatsapp.net')?.enabled, true);

    const again = await harness.api(session, 'POST', '/api/contacts', { input: '+14155550199' });
    assert.equal(again.status, 200);
    assert.equal(harness.calls.assistantStart, 1);
  });
});

test('enable and pause are idempotent desired states; global pause keeps routes and survives reload', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const paused = await harness.api(session, 'POST', '/api/contacts/enabled', { contactId: ada, enabled: false });
    assert.equal(paused.status, 200);
    assert.equal(harness.calls.assistantStart, 0);
    assert.equal((await harness.persisted().catch(() => ({ routes: [] }))).routes.length, 0);

    for (let repeat = 0; repeat < 2; repeat++) {
      const enabled = await harness.api(session, 'POST', '/api/contacts/enabled', { contactId: ada, enabled: true });
      assert.equal(enabled.status, 200);
      assert.equal(commandState(enabled).contacts.find(contact => contact.id === ada)?.enabled, true);
    }
    assert.equal(harness.calls.assistantStart, 1);

    const globalPause = await harness.api(session, 'POST', '/api/forwarding/pause');
    assert.equal(commandState(globalPause).armed, false);
    let saved = await harness.persisted();
    assert.equal(saved.running, false);
    assert.equal(saved.routes[0]?.enabled, true);

    const resumed = await harness.api(session, 'POST', '/api/forwarding/resume');
    assert.equal(commandState(resumed).armed, true);

    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal((await harness.api(session, 'POST', '/api/contacts/enabled', { contactId: ada, enabled: false })).status, 200);
    }
    saved = await harness.persisted();
    assert.equal(saved.routes[0]?.enabled, false);
    const activity = asState((await harness.api(session, 'GET', '/api/state')).json).activity ?? [];
    assert.ok(activity.some(entry => /already paused/.test(entry.message)));
    assert.deepEqual(harness.calls.sent, []);
  });
});

test('resuming with nothing enabled is refused with a readable error', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const reply = await harness.api(session, 'POST', '/api/forwarding/resume');
    assert.equal(reply.status, 409);
    assert.match(asError(reply).message, /Enable a contact/);
    assert.equal(harness.calls.assistantStart, 0);
  });
});

test('project and lifetime settings save a paused route and never enable forwarding or touch the browser', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const project = await harness.api(session, 'POST', '/api/contacts/project', { contactId: ada, projectRef: 'ws:Alpha' });
    assert.equal(project.status, 200);
    const ttl = await harness.api(session, 'POST', '/api/contacts/ttl', { contactId: ada, ttl: '12h' });
    assert.equal(ttl.status, 200);
    const state = commandState(ttl);
    const contact = state.contacts.find(item => item.id === ada);
    assert.deepEqual([contact?.enabled, contact?.hasRoute, contact?.projectRef, contact?.ttlMinutes, contact?.ttl, state.armed], [false, true, 'ws:alpha', 720, '12h', false]);
    assert.equal(harness.calls.assistantStart, 0);
    assert.equal(harness.calls.channelStart, 0);
    const saved = await harness.persisted();
    assert.deepEqual(saved.routes.map(item => [item.contactId, item.enabled, item.projectRef, item.conversationTtlMinutes]), [[ada, false, 'ws:alpha', 720]]);
    assert.equal(saved.running, false);

    assert.equal((await harness.api(session, 'POST', '/api/contacts/ttl', { contactId: ada, ttl: 'never' })).status, 200);
    assert.equal((await harness.persisted()).routes[0]?.conversationTtlMinutes, null);
    assert.equal((await harness.api(session, 'POST', '/api/contacts/ttl', { contactId: ada, ttl: '' })).status, 200);
    assert.equal((await harness.persisted()).routes[0]?.conversationTtlMinutes, 1440);
    const bad = await harness.api(session, 'POST', '/api/contacts/ttl', { contactId: ada, ttl: 'banana' });
    assert.equal(bad.status, 400);
    assert.match(asError(bad).message, /lifetime/i);
    assert.equal((await harness.api(session, 'POST', '/api/contacts/ttl', { contactId: ada, ttl: '99999999d' })).status, 400);
    assert.equal((await harness.persisted()).routes[0]?.conversationTtlMinutes, 1440);

    assert.equal((await harness.api(session, 'POST', '/api/contacts/project', { contactId: ada, projectRef: null })).status, 200);
    assert.equal((await harness.persisted()).routes[0]?.projectRef, null);
    const invalid = await harness.api(session, 'POST', '/api/contacts/project', { contactId: ada, projectRef: 'https://attacker.example/x' });
    assert.equal(invalid.status, 409);
    assert.ok(!asError(invalid).message.includes('attacker.example'));
    assert.equal(harness.calls.assistantStart, 0);
  });
});

test('the project catalog reports ownership and unique project assignment is enforced', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const before = await harness.api(session, 'GET', '/api/projects');
    assert.equal(before.status, 200);
    assert.deepEqual(asProjects(before), [{ name: 'Alpha', ref: 'ws:alpha', owner: null }, { name: 'Beta', ref: 'ws:beta', owner: null }]);
    assert.equal(harness.calls.assistantStart, 0);

    assert.equal((await harness.api(session, 'POST', '/api/contacts/project', { contactId: ada, projectRef: 'ws:alpha' })).status, 200);
    const after = asProjects(await harness.api(session, 'GET', '/api/projects'));
    assert.deepEqual(after[0]?.owner, { id: ada, name: 'Ada Example' });
    assert.equal(after[1]?.owner, null);

    const taken = await harness.api(session, 'POST', '/api/contacts/project', { contactId: bob, projectRef: 'ws:alpha' });
    assert.equal(taken.status, 409);
    assert.match(asError(taken).message, /already belongs to another contact/);
    assert.equal((await harness.persisted()).routes.length, 1);
    assert.equal((await harness.api(session, 'POST', '/api/contacts/project', { contactId: bob, projectRef: 'ws:beta' })).status, 200);
  });
});

test('dependency failures surface as short errors without addresses or stack details', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const check = await harness.api(session, 'POST', '/api/browser/check');
    assert.equal(check.status, 502);
    assert.match(asError(check).message, /unreachable/);
    assert.ok(!check.text.includes('127.0.0.1:9010'));
    assert.ok(!check.text.includes('\n    at '));
    const state = asState((await harness.api(session, 'GET', '/api/state')).json);
    assert.equal(state.assistantStatus, 'failed');

    const projects = await harness.api(session, 'GET', '/api/projects');
    assert.equal(projects.status, 502);
    assert.ok(!projects.text.includes('chatgpt.invalid'));
    assert.equal((await harness.api(session, 'GET', '/api/state')).status, 200);
  }, {
    assistant: {
      start: async () => { throw new Error('BrowserOS unreachable at http://127.0.0.1:9010/mcp'); },
      listProjects: async () => { throw new Error('Could not read https://chatgpt.invalid/projects\nsecond line'); },
    },
  });
});

test('connect starts the messaging channel once and reports its status', async () => {
  const connecting = Promise.withResolvers<void>();
  try {
    await withServer(async harness => {
      const session = await harness.signIn();
      const reply = await harness.api(session, 'POST', '/api/channel/connect');
      assert.equal(reply.status, 200);
      assert.equal(commandState(reply).channelStatus, 'connecting');
      assert.equal(harness.calls.channelStart, 1);
      assert.equal((await harness.api(session, 'POST', '/api/channel/connect')).status, 200);
      assert.equal(harness.calls.channelStart, 1);
      assert.equal(harness.calls.assistantStart, 0);
    }, { channel: { start: () => connecting.promise } });
  } finally { connecting.resolve(); }
});

test('event streams deliver the snapshot, activity, state changes and QR images only to the signed-in owner', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const stream = await harness.events(session);
    assert.equal(stream.status, 200);
    const snapshot = asState((await stream.waitFor(event => event.event === 'snapshot')).data);
    assert.equal(snapshot.contacts.length, 2);
    assert.deepEqual(snapshot.activity, []);

    harness.application.log('Something happened at http://127.0.0.1:9010/mcp');
    const activity = await stream.waitFor(event => event.event === 'activity');
    assert.match(activityMessage(activity), /Something happened at \[address\]/);
    await stream.waitFor(event => event.event === 'state');

    harness.application.emit('qr', 'synthetic-pairing-payload');
    const withQr = await stream.waitFor(event => event.event === 'state' && typeof asState(event.data).qr === 'string');
    assert.match(String(asState(withQr.data).qr), /^data:image\/png;base64,[A-Za-z0-9+/=]{100,}$/);
    assert.ok(!JSON.stringify(withQr.data).includes('synthetic-pairing-payload'));
    assert.match(String(asState((await harness.api(session, 'GET', '/api/state')).json).qr), /^data:image\/png/);

    harness.application.emit('qr', '');
    await stream.waitFor(event => event.event === 'state' && asState(event.data).qr === null && event !== withQr && stream.events.indexOf(event) > stream.events.indexOf(withQr));

    await harness.api(session, 'POST', '/api/contacts/project', { contactId: ada, projectRef: 'ws:alpha' });
    const changed = await stream.waitFor(event => event.event === 'state' && asState(event.data).contacts.some(contact => contact.projectRef === 'ws:alpha'));
    assert.ok(changed);
    stream.close();
    await stream.ended;
  });
});

test('logout revokes the session, clears the cookie and ends its open event streams', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const other = await harness.signIn();
    const stream = await harness.events(session);
    const otherStream = await harness.events(other);
    await stream.waitFor(event => event.event === 'snapshot');
    await otherStream.waitFor(event => event.event === 'snapshot');

    const missingCsrf = await harness.request('POST', '/api/logout', { headers: { cookie: session.cookie, 'content-type': 'application/json', origin: harness.origin }, body: '{}' });
    assert.equal(missingCsrf.status, 403);
    assert.equal((await harness.api(session, 'GET', '/api/state')).status, 200);

    const out = await harness.api(session, 'POST', '/api/logout');
    assert.equal(out.status, 200);
    assert.match(String(out.headers['set-cookie']?.[0]), /^wabgpt_session=; .*Max-Age=0/);
    await stream.ended;
    assert.equal((await harness.api(session, 'GET', '/api/state')).status, 401);
    assert.equal((await harness.api(session, 'POST', '/api/forwarding/pause')).status, 401);
    assert.equal((await harness.events(session)).status, 401);
    assert.equal((await harness.api(other, 'GET', '/api/state')).status, 200);
    harness.application.log('other session still receives events');
    assert.match(activityMessage(await otherStream.waitFor(event => event.event === 'activity')), /still receives/);
    otherStream.close();
  });
});

test('an expired session stops working and its stream is closed by the server', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const stream = await harness.events(session);
    await stream.waitFor(event => event.event === 'snapshot');
    await stream.ended;
    assert.equal((await harness.api(session, 'GET', '/api/state')).status, 401);
    assert.equal((await harness.api(session, 'POST', '/api/forwarding/pause')).status, 401);
    const fresh = await harness.signIn();
    assert.equal((await harness.api(fresh, 'GET', '/api/session')).status, 200);
  }, { limits: { sessionTtlMs: 250 } });
});

test('signing in again replaces the presented session', async () => {
  await withServer(async harness => {
    const first = await harness.signIn();
    const second = sessionOf(await harness.login(harness.token, { cookie: first.cookie }));
    assert.notEqual(second.cookie, first.cookie);
    assert.equal((await harness.api(first, 'GET', '/api/state')).status, 401);
    assert.equal((await harness.api(second, 'GET', '/api/state')).status, 200);
  });
});

test('stream counts are capped per session', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const first = await harness.events(session);
    const second = await harness.events(session);
    assert.deepEqual([first.status, second.status], [200, 200]);
    assert.equal((await harness.events(session)).status, 429);
    first.close(); second.close();
    await Promise.all([first.ended, second.ended]);
  }, { limits: { streamsPerSession: 2 } });
});

test('closing the server ends streams, detaches from the Application and leaves the Application running', async () => {
  await withServer(async harness => {
    const session = await harness.signIn();
    const stream = await harness.events(session);
    await stream.waitFor(event => event.event === 'snapshot');
    assert.ok(harness.application.listenerCount('change') > 0);
    assert.ok(harness.application.listenerCount('log') > 0);
    assert.ok(harness.application.listenerCount('qr') > 0);
    await harness.server.close();
    await stream.ended;
    assert.deepEqual([harness.application.listenerCount('change'), harness.application.listenerCount('log'), harness.application.listenerCount('qr')], [0, 0, 0]);
    await harness.server.close();
    await assert.rejects(harness.request('GET', '/'));
    harness.application.log('still usable after the server stopped');
    assert.equal(harness.application.snapshot().armed, false);
  });
});

test('serving behind a trusted HTTPS public origin uses a __Host- Secure cookie and that origin for CSRF', async () => {
  await withServer(async harness => {
    const publicOrigin = 'https://wabgpt.example.com';
    const asPublic = { host: 'wabgpt.example.com', origin: publicOrigin };
    const login = await harness.request('POST', '/api/login', { headers: { ...asPublic, 'content-type': 'application/json' }, body: JSON.stringify({ token: harness.token }) });
    assert.equal(login.status, 200);
    const cookie = String(login.headers['set-cookie']?.[0]);
    assert.match(cookie, /^__Host-wabgpt_session=[A-Za-z0-9_-]{43,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
    const session = sessionOf(login);
    const publicApi = (method: string, path: string, body?: unknown) => harness.request(method, path, { headers: { ...asPublic, cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await publicApi('GET', '/api/state')).status, 200);
    assert.equal((await publicApi('POST', '/api/forwarding/pause', {})).status, 200);
    const wrongOrigin = await harness.request('POST', '/api/forwarding/pause', { headers: { host: 'wabgpt.example.com', origin: harness.origin, cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(wrongOrigin.status, 403);
    assert.equal((await harness.request('GET', '/', { headers: { host: 'other.example.com' } })).status, 421);
    // The plain cookie name is not accepted for the public origin, and the loopback path keeps its own plain cookie.
    assert.equal((await harness.request('GET', '/api/state', { headers: { ...asPublic, cookie: `wabgpt_session=${session.cookie.split('=')[1]}` } })).status, 401);
    const local = await harness.signIn();
    assert.equal((await harness.api(local, 'GET', '/api/state')).status, 200);
    assert.equal((await harness.api(local, 'GET', '/api/state', undefined, { host: 'wabgpt.example.com' })).status, 401);
  }, { publicOrigin: 'https://wabgpt.example.com' });
});

test('the served token file is the owner token and a stale token is rejected', async () => {
  await withServer(async harness => {
    const onDisk = (await readFile(join(harness.directory, 'server-token'), 'utf8')).trim();
    assert.equal(onDisk, harness.token);
    assert.equal((await harness.login(onDisk)).status, 200);
    assert.equal((await harness.login(onDisk.split('').reverse().join(''))).status, 401);
  });
});
