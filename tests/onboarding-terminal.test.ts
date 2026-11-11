import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createTerminalSetupIO, OnboardingCancelled } from '../src/onboarding/index.js';

function terminal(controller = new AbortController()) {
  const input = new PassThrough();
  const output = new PassThrough();
  const created = createTerminalSetupIO({ signal: controller.signal, onInterrupt: () => controller.abort(), input, output });
  return { ...created, input, controller };
}

test('the terminal prompt only takes over input when the first question is asked, and returns the typed answer', async () => {
  const { io, close, input } = terminal();
  assert.equal(input.readableFlowing, null);
  const answer = io.ask('Name: ');
  input.write('Ada\n');
  assert.equal(await answer, 'Ada');
  close();
});

test('aborting cancels a pending question and every later one', async () => {
  const { io, close, controller } = terminal();
  const pending = io.ask('Anything? ');
  controller.abort();
  await assert.rejects(pending, OnboardingCancelled);
  await assert.rejects(io.ask('Again? '), OnboardingCancelled);
  close();
});

test('a closed terminal cancels the pending question instead of hanging', async () => {
  const { io, close, input } = terminal();
  const pending = io.ask('Anything? ');
  input.end();
  await assert.rejects(pending, OnboardingCancelled);
  close();
  close();
});
