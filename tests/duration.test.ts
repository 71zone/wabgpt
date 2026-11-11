import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatConversationTtl, parseConversationTtl } from '../src/core/duration.js';
import { DEFAULT_CONVERSATION_TTL_MINUTES } from '../src/core/state.js';

test('conversation lifetimes accept minutes, hours, days, never, and an empty answer meaning the default', () => {
  assert.equal(parseConversationTtl(''), DEFAULT_CONVERSATION_TTL_MINUTES);
  assert.equal(parseConversationTtl('   '), DEFAULT_CONVERSATION_TTL_MINUTES);
  assert.equal(parseConversationTtl('Never'), null);
  assert.equal(parseConversationTtl('90'), 90);
  assert.equal(parseConversationTtl('90m'), 90);
  assert.equal(parseConversationTtl('45 minutes'), 45);
  assert.equal(parseConversationTtl('12h'), 720);
  assert.equal(parseConversationTtl('1.5 hours'), 90);
  assert.equal(parseConversationTtl('3d'), 4320);
  assert.equal(parseConversationTtl('2 days'), 2880);
});

test('conversation lifetimes reject unreadable, fractional and out-of-range values', () => {
  for (const text of ['abc', '1w', '-5', '1.5', '0', '0m', '0.01h', '3651d', String(3650 * 1440 + 1), '1e3']) {
    assert.throws(() => parseConversationTtl(text), Error, text);
  }
  assert.equal(parseConversationTtl('1m'), 1);
  assert.equal(parseConversationTtl('3650d'), 3650 * 1440);
});

test('formatted lifetimes parse back to the same value', () => {
  assert.equal(formatConversationTtl(null), 'never');
  assert.equal(formatConversationTtl(1440), '24h');
  assert.equal(formatConversationTtl(2880), '2d');
  assert.equal(formatConversationTtl(90), '90m');
  assert.equal(formatConversationTtl(60), '1h');
  assert.equal(formatConversationTtl(1), '1m');
  for (const minutes of [null, 1, 59, 60, 90, 1440, 1441, 2880, 4320, 3650 * 1440]) {
    assert.equal(parseConversationTtl(formatConversationTtl(minutes)), minutes);
  }
});
