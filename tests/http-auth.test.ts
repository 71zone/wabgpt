import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FailureLimiter, SessionStore, createTokenVerifier, readOrCreateOwnerToken, safeEqual } from '../src/interfaces/http/auth.js';
import { withDirectory } from './support/core-fixtures.js';

test('the owner token is random, private, created once and shared by concurrent callers', async () => {
  await withDirectory(async directory => {
    const path = join(directory, 'nested', 'server-token');
    const tokens = await Promise.all(Array.from({ length: 6 }, () => readOrCreateOwnerToken(path)));
    assert.equal(new Set(tokens).size, 1);
    const [token] = tokens;
    assert.match(token ?? '', /^[A-Za-z0-9_-]{43,}$/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'nested'))).mode & 0o777, 0o700);
    assert.equal(await readOrCreateOwnerToken(path), token);
    assert.equal((await readFile(path, 'utf8')).trim(), token);
    const other = await readOrCreateOwnerToken(join(directory, 'other-token'));
    assert.notEqual(other, token);
  }, 'wabgpt-token-');
});

test('an existing token file is tightened to owner-only and never replaced when invalid', async () => {
  await withDirectory(async directory => {
    const path = join(directory, 'server-token');
    const token = 'A'.repeat(43);
    await writeFile(path, `${token}\n`, { mode: 0o644 });
    assert.equal(await readOrCreateOwnerToken(path), token);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const bad = join(directory, 'bad-token');
    await writeFile(bad, 'too short', { mode: 0o600 });
    await assert.rejects(readOrCreateOwnerToken(bad), /does not contain a valid token/);
    assert.equal(await readFile(bad, 'utf8'), 'too short');
    await mkdir(join(directory, 'dir-token'));
    await assert.rejects(readOrCreateOwnerToken(join(directory, 'dir-token')));
  }, 'wabgpt-token-');
});

test('token and CSRF comparison accept only the exact secret', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('secret', 'secreT'), false);
  assert.equal(safeEqual('secret', 'secret-and-more'), false);
  const verify = createTokenVerifier('owner-secret');
  assert.equal(verify('owner-secret'), true);
  assert.equal(verify('owner-secret '), false);
  assert.equal(verify(''), false);
});

test('sessions expire, can be revoked and evict the oldest when the cap is reached, closing their streams', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const store = new SessionStore({ ttlMs: 60, maxSessions: 2 });
    const closed: string[] = [];
    const first = store.create(); first.session.streams.add({ close: () => closed.push('first') });
    const second = store.create();
    assert.equal(store.get(first.id), first.session);
    assert.equal(store.get(undefined), undefined);
    assert.equal(store.get('not-a-session'), undefined);
    const third = store.create();
    assert.deepEqual(closed, ['first']);
    assert.equal(store.get(first.id), undefined);
    assert.equal(store.get(second.id), second.session);
    store.revoke(second.session);
    assert.equal(store.get(second.id), undefined);
    third.session.streams.add({ close: () => closed.push('third') });
    mock.timers.tick(61);
    assert.equal(store.get(third.id), undefined);
    assert.deepEqual(closed, ['first', 'third']);
    store.closeAll();
  } finally { mock.timers.reset(); }
});

test('failed logins are limited per window and recover afterwards', () => {
  const limiter = new FailureLimiter(3, 1000);
  for (let index = 0; index < 3; index++) { assert.equal(limiter.retryAfter('a', 0), 0); limiter.fail('a', index); }
  assert.ok(limiter.retryAfter('a', 10) > 900);
  assert.equal(limiter.retryAfter('b', 10), 0);
  assert.equal(limiter.retryAfter('a', 1500), 0);
  limiter.fail('b', 20); limiter.clear('b');
  assert.equal(limiter.retryAfter('b', 30), 0);
});
