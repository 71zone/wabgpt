import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { routeConsoleOutput } from '../src/infrastructure/console-output.js';

test('dependency session objects cannot expose cryptographic details or bypass the TUI logger', () => {
  const messages: string[] = [];
  const original = console.info;
  let inspected = false;
  const restore = routeConsoleOutput(message => messages.push(message));
  try {
    console.info('Closing session:', { privateKey: 'private-key-fixture', [inspect.custom]: () => { inspected = true; return 'private-key-fixture'; } });
    console.warn('Decrypted message with closed session.');
    console.error(new Error('Connection closed'));
  } finally { restore(); }
  assert.equal(inspected, false);
  assert.equal(messages.some(message => message.includes('private-key-fixture')), false);
  assert.equal(messages.some(message => message.includes('Closing session:')), true);
  assert.equal(messages.some(message => message.includes('Decrypted message with closed session.')), true);
  assert.equal(messages.some(message => message.includes('Connection closed')), true);
  assert.equal(console.info, original);
});
