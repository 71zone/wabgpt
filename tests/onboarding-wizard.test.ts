import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LoadedConfig } from '../src/infrastructure/config.js';
import { completeOnboarding, OnboardingCancelled, type PreparedOnboarding } from '../src/onboarding/index.js';
import type { Contact, Project } from '../src/core/contracts.js';
import type { RoutingState } from '../src/core/state.js';
import { checkpoint, readSetupState, writeSetupState, type BrowserSelection, type SetupState } from '../src/onboarding/state.js';
import { loadState, projectA, projectB } from './support/core-fixtures.js';
import { harness, scriptedIO, withConfig, type HarnessOptions, type ScriptedIO } from './support/onboarding-fixtures.js';

const alice = { id: '14155550001@s.whatsapp.net', name: 'Alice' };
const bob = { id: '14155550002@s.whatsapp.net', name: 'Bob' };
const native: BrowserSelection = { mode: 'native' };
const aliceProject = { name: 'Alice notes', ref: projectA };
const bobProject = { name: 'Bob notes', ref: projectB };

type Rules = Parameters<typeof scriptedIO>[0];
const signedIn: Rules[number] = [/should check/, ''];
/** Types the number a user would read off the screen for `name` in the most recent listing. */
const answerWithDisplayedNumber = (name: string) => (io: ScriptedIO): string => {
  const shown = [...io.output.matchAll(new RegExp(`(\\d+)\\) ${name}`, 'g'))].map(match => match[1]);
  return `${shown.at(-1)}`;
};
const chooseAlice: Rules = [[/contact now/, 'y'], [/Contact: part of a name/, 'alice'], [/Number \(Enter to search again\)/, '1']];

/** What prepareOnboarding hands over: the checkpoint is already saved before the wizard starts. */
async function planAt(config: LoadedConfig, stage: 'chatgpt' | 'whatsapp' | 'contact', browser: BrowserSelection = native): Promise<PreparedOnboarding> {
  const setup = checkpoint(browser, stage);
  await writeSetupState(config.dataDir, setup);
  return { config, setup };
}

interface Outcome { io: ScriptedIO; routes: RoutingState; running: boolean; marker: SetupState | null; armed: boolean; sent: string[] }

async function run(config: LoadedConfig, rules: Rules, options: HarnessOptions = {}, stage: 'chatgpt' | 'whatsapp' | 'contact' = 'chatgpt'): Promise<Outcome> {
  const { application, sent } = await harness(config, options);
  const io = scriptedIO(rules);
  try {
    await completeOnboarding(application, await planAt(config, stage), { io, signal: new AbortController().signal });
    const armed = application.snapshot().armed;
    const routes = await loadState(config.dataDir);
    return { io, routes, running: routes.isRunning(), marker: await readSetupState(config.dataDir), armed, sent };
  } finally { await application.close(); }
}

test('the journey connects WhatsApp, saves the first contact paused with its own project and lifetime, and completes without forwarding anything', async () => {
  await withConfig(async config => {
    const outcome = await run(config, [signedIn, ...chooseAlice, [/Project number/, '1'], [/Lifetime \(/, '12h'], [/Turn on automatic replies/, '']], { contacts: [alice], projects: [aliceProject] });
    const route = outcome.routes.route(alice.id);
    assert.deepEqual([route?.enabled, route?.projectRef, route?.conversationTtlMinutes], [false, projectA, 720]);
    assert.deepEqual([outcome.running, outcome.armed, outcome.sent], [false, false, []]);
    assert.equal(outcome.marker?.stage, 'complete');
  });
});

test('only an explicit yes enables the contact and starts forwarding; anything else leaves it saved and paused', async () => {
  for (const answer of ['', 'no', 'maybe', 'later']) {
    await withConfig(async config => {
      const outcome = await run(config, [signedIn, ...chooseAlice, [/Project number/, '1'], [/Lifetime \(/, ''], [/Turn on automatic replies/, answer]], { contacts: [alice], projects: [aliceProject] });
      assert.equal(outcome.routes.route(alice.id)?.enabled, false);
      assert.deepEqual([outcome.running, outcome.armed], [false, false]);
    });
  }
  await withConfig(async config => {
    const outcome = await run(config, [signedIn, ...chooseAlice, [/Project number/, '1'], [/Lifetime \(/, ''], [/Turn on automatic replies/, 'yes']], { contacts: [alice], projects: [aliceProject] });
    assert.deepEqual([outcome.routes.route(alice.id)?.enabled, outcome.running, outcome.armed], [true, true, true]);
    assert.equal(outcome.marker?.stage, 'complete');
  });
});

test('skipping the first contact finishes setup with nothing enabled', async () => {
  await withConfig(async config => {
    const outcome = await run(config, [signedIn, [/contact now/, 'n']], { projects: [] });
    assert.deepEqual([outcome.routes.routes(), outcome.running, outcome.armed], [[], false, false]);
    assert.equal(outcome.marker?.stage, 'complete');
  });
});

test('a contact can be entered as an international number before any directory has synced, and it may use no project with a custom lifetime', async () => {
  await withConfig(async config => {
    const outcome = await run(config, [signedIn, [/contact now/, 'y'], [/Contact: part of a name/, '+1 415 555 1234'], [/Project number/, 'none'], [/Continue without one/, 'y'], [/Lifetime \(/, '3d'], [/Turn on automatic replies/, '']], { projects: [] });
    const route = outcome.routes.route('14155551234@s.whatsapp.net');
    assert.deepEqual([route?.enabled, route?.projectRef, route?.conversationTtlMinutes], [false, null, 4320]);
  });
});

test('a contact that syncs while the user is typing a name is found by that first answer', async () => {
  await withConfig(async config => {
    const contacts: Contact[] = [];
    const arrives = (): string => { contacts.push(alice); return 'alice'; };
    const outcome = await run(config, [[/contact now/, 'y'], [/Contact: part of a name/, arrives], [/Number \(Enter to search again\)/, '1'], [/Project number/, 'none'], [/Continue without one/, 'y'], [/Lifetime \(/, ''], [/Turn on automatic replies/, '']], { contacts }, 'contact');
    assert.equal(outcome.io.prompts.filter(prompt => /Contact: part of a name/.test(prompt)).length, 1);
    assert.equal(outcome.routes.route(alice.id)?.name, 'Alice');
  });
});

test('after a filtered project list, the number shown for a match chooses that project, without reading the catalog again', async () => {
  await withConfig(async config => {
    const [a, b, c, d] = [projectA, projectB, `https://chatgpt.com/g/g-p-${'c'.repeat(32)}`, `https://chatgpt.com/g/g-p-${'d'.repeat(32)}`];
    const catalog = [{ name: 'Family', ref: a }, { name: 'Work notes', ref: c }, { name: 'Gym', ref: b }, { name: 'Work plans', ref: d }];
    let reads = 0;
    const projects = async (): Promise<Project[]> => { reads++; return catalog; };
    const outcome = await run(config, [...chooseAlice, [/Project number/, 'work', answerWithDisplayedNumber('Work plans')], [/Lifetime \(/, ''], [/Turn on automatic replies/, '']], { contacts: [alice], projects }, 'contact');
    assert.equal(reads, 1);
    assert.equal(outcome.routes.route(alice.id)?.projectRef, d);
  });
});

test("another contact's project is refused, and the contact can be given a free one", async () => {
  await withConfig(async config => {
    const store = await loadState(config.dataDir);
    await store.setProject(bob, projectA);
    await store.enable(bob);
    await store.setRunning(true);
    const outcome = await run(config, [signedIn, ...chooseAlice, [/Project number/, '1', '2'], [/Lifetime \(/, ''], [/Turn on automatic replies/, 'yes']], { contacts: [alice, bob], projects: [aliceProject, bobProject] }, 'contact');
    assert.equal(outcome.routes.route(alice.id)?.projectRef, projectB);
    assert.equal(outcome.routes.route(bob.id)?.projectRef, projectA);
    assert.deepEqual([outcome.routes.route(alice.id)?.enabled, outcome.routes.route(bob.id)?.enabled, outcome.running], [false, true, false]);
  });
});

test('rerunning setup pauses forwarding and never switches on contacts that were already enabled', async () => {
  await withConfig(async config => {
    const store = await loadState(config.dataDir);
    await store.enable(bob);
    await store.setRunning(true);
    const skipped = await run(config, [[/contact now/, 'n']], { contacts: [alice, bob] }, 'contact');
    assert.deepEqual([skipped.running, skipped.armed, skipped.routes.route(bob.id)?.enabled], [false, false, true]);

    const configured = await run(config, [...chooseAlice, [/Project number/, '1'], [/Lifetime \(/, '']], { contacts: [alice, bob], projects: [aliceProject] }, 'contact');
    assert.deepEqual([configured.running, configured.armed], [false, false]);
    assert.deepEqual([configured.routes.route(alice.id)?.enabled, configured.routes.route(alice.id)?.projectRef], [false, projectA]);
    assert.equal(configured.routes.route(bob.id)?.enabled, true);
    assert.equal(configured.marker?.stage, 'complete');
  });
});

test('a forwarding start that fails after consent still completes setup with the contact enabled but paused', async () => {
  await withConfig(async config => {
    const outcome = await run(config, [signedIn, ...chooseAlice, [/Project number/, '1'], [/Lifetime \(/, ''], [/Turn on automatic replies/, 'yes']], { contacts: [alice], projects: [aliceProject], assistant: { start: async () => { throw new Error('BrowserOS vanished'); } } });
    assert.deepEqual([outcome.routes.route(alice.id)?.enabled, outcome.running, outcome.armed], [true, false, false]);
    assert.equal(outcome.marker?.stage, 'complete');
  });
});

test('failed ChatGPT access and failed WhatsApp connections are retried, and setup only advances once each really works', async () => {
  await withConfig(async config => {
    let listings = 0;
    let attempts = 0;
    const outcome = await run(config, [signedIn, [/check again/, ''], [/try again/, ''], [/contact now/, 'n']], {
      projects: async () => { if (++listings < 3) throw new Error('Not signed in to ChatGPT'); return []; },
      connect: attempt => { attempts = attempt; if (attempt < 2) throw new Error('socket exploded'); },
    });
    assert.deepEqual([listings, attempts], [3, 2]);
    assert.equal(outcome.marker?.stage, 'complete');
  });
});

test('stopping keeps the checkpoint of the last finished step and never marks setup complete', async () => {
  const stopAt = (rules: Rules, pattern: RegExp, controller: AbortController): Rules => [...rules, [pattern, () => { controller.abort(); throw new OnboardingCancelled(); }]];
  const cases: Array<{ pattern: RegExp; reached: string; options: HarnessOptions; rules: Rules }> = [
    { pattern: /should check/, reached: 'chatgpt', options: {}, rules: [] },
    { pattern: /check again/, reached: 'chatgpt', options: { projects: async () => { throw new Error('Not signed in'); } }, rules: [signedIn] },
    { pattern: /try again/, reached: 'whatsapp', options: { connect: () => { throw new Error('offline'); } }, rules: [signedIn] },
    { pattern: /contact now/, reached: 'contact', options: {}, rules: [signedIn] },
  ];
  for (const { pattern, reached, options, rules } of cases) {
    await withConfig(async config => {
      const controller = new AbortController();
      const { application } = await harness(config, options);
      try {
        const plan = await planAt(config, 'chatgpt');
        await assert.rejects(() => completeOnboarding(application, plan, { io: scriptedIO(stopAt(rules, pattern, controller)), signal: controller.signal }), OnboardingCancelled);
        assert.equal((await readSetupState(config.dataDir))?.stage, reached);
      } finally { await application.close(); }
    });
  }
});

test('an aborted signal during a pending catalog read stops setup promptly without waiting for the browser', async () => {
  await withConfig(async config => {
    const controller = new AbortController();
    // A catalog read that only ends when its signal aborts, like a real browser read that cancels its transport.
    const pending = (signal?: AbortSignal): Promise<Project[]> => new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    const { application } = await harness(config, { projects: pending });
    try {
      const io = scriptedIO([[/should check/, () => { queueMicrotask(() => controller.abort()); return ''; }]]);
      const plan = await planAt(config, 'chatgpt');
      await assert.rejects(() => completeOnboarding(application, plan, { io, signal: controller.signal }), OnboardingCancelled);
      assert.equal((await readSetupState(config.dataDir))?.stage, 'chatgpt');
    } finally { await application.close(); }
  });
});

test('no setup plan means nothing runs and forwarding preferences are untouched', async () => {
  await withConfig(async config => {
    const store = await loadState(config.dataDir);
    await store.enable(bob);
    await store.setRunning(true);
    const { application } = await harness(config);
    try {
      await completeOnboarding(application, { config, setup: null }, { io: scriptedIO([]), signal: new AbortController().signal });
      assert.equal((await loadState(config.dataDir)).isRunning(), true);
    } finally { await application.close(); }
  });
});
