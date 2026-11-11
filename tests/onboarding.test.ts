import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, setBrowserMcpUrl, type LoadedConfig } from '../src/infrastructure/config.js';
import { OnboardingCancelled, prepareOnboarding, type OnboardingDependencies, type PreparedOnboarding } from '../src/onboarding/index.js';
import { checkpoint, completeSetup, readSetupState, writeSetupState } from '../src/onboarding/state.js';
import { loadState } from './support/core-fixtures.js';
import { nativeEndpoint, scriptedIO, withConfig } from './support/onboarding-fixtures.js';

const signal = new AbortController().signal;
const refuse = (): never => { throw new Error('That prompt should not appear'); };
const silent = scriptedIO([[/./, '']]);
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

function managed(endpoint: () => string, failures = 0): Partial<OnboardingDependencies> & { starts: number } {
  let remaining = failures;
  const dependencies = {
    starts: 0,
    ensureBrowser: async () => {
      dependencies.starts++;
      if (remaining-- > 0) throw new Error('Docker is not running.');
      return { endpoint: endpoint(), viewerUrl: 'http://127.0.0.1:41080/', containerName: 'wabgpt-test' };
    },
    openUrl: async () => {},
    saveEndpoint: setBrowserMcpUrl,
    reload: loadConfig,
  };
  return dependencies;
}

test('setup progress is private, validated and never overwritten when it is invalid or from a newer version', async () => {
  await withConfig(async config => {
    assert.equal(await readSetupState(config.dataDir), null);
    await writeSetupState(config.dataDir, checkpoint({ mode: 'native' }, 'whatsapp'));
    assert.equal((await stat(join(config.dataDir, 'onboarding.json'))).mode & 0o777, 0o600);
    assert.equal((await readSetupState(config.dataDir))?.stage, 'whatsapp');

    for (const bad of ['{ nope', JSON.stringify({ version: 2, stage: 'complete' }), JSON.stringify({ version: 1, stage: 'whatsapp', updatedAt: 1 }), JSON.stringify({ version: 1, stage: 'chatgpt', browser: { mode: 'docker' }, updatedAt: 1 }), JSON.stringify({ version: 1, stage: 'contact', browser: { mode: 'native' }, updatedAt: 1, completedAt: 1 })]) {
      await writeFile(join(config.dataDir, 'onboarding.json'), bad);
      await assert.rejects(() => readSetupState(config.dataDir));
      await assert.rejects(() => prepareOnboarding(config, { force: false, io: silent, signal }));
      assert.equal(await readFile(join(config.dataDir, 'onboarding.json'), 'utf8'), bad);
    }
  });
});

test('a first run records pending setup before any routing state exists, and the state file it later creates does not make it look legacy', async () => {
  await withConfig(async config => {
    const interrupted = new AbortController();
    const io = scriptedIO([[/Choose 1 or 2/, () => { interrupted.abort(); throw new OnboardingCancelled(); }]]);
    await assert.rejects(() => prepareOnboarding(config, { force: false, io, signal: interrupted.signal }), OnboardingCancelled);
    assert.equal((await readSetupState(config.dataDir))?.stage, 'browser');
    assert.equal(await exists(join(config.dataDir, 'state.json')), false);

    await loadState(config.dataDir);
    assert.equal(await exists(join(config.dataDir, 'state.json')), true);
    const resumed = await prepareOnboarding(config, { force: false, io: scriptedIO([[/Choose 1 or 2/, '1'], [/different local BrowserOS/, '']]), signal });
    assert.equal(resumed.setup?.stage, 'chatgpt');
    assert.equal(resumed.config.browserMcpUrl, nativeEndpoint);
  });
});

test('installs that predate onboarding keep their startup without prompts or markers, until setup is forced', async () => {
  for (const legacy of ['state', 'login'] as const) {
    await withConfig(async config => {
      if (legacy === 'state') await loadState(config.dataDir);
      else { await mkdir(join(config.dataDir, 'whatsapp')); await writeFile(join(config.dataDir, 'whatsapp', 'creds.json'), '{}'); }
      const plan = await prepareOnboarding(config, { force: false, io: { write: refuse, ask: refuse }, signal });
      assert.deepEqual([plan.setup, plan.config], [null, config]);
      assert.equal(await readSetupState(config.dataDir), null);
      const forced = await prepareOnboarding(config, { force: true, io: scriptedIO([[/Choose 1 or 2/, '1'], [/different local BrowserOS/, '']]), signal });
      assert.equal(forced.setup?.stage, 'chatgpt');
    });
  }
});

test('a completed setup skips the wizard and rerunning it can be abandoned without losing completion', async () => {
  await withConfig(async config => {
    await writeSetupState(config.dataDir, completeSetup({ mode: 'native' }));
    const plan = await prepareOnboarding(config, { force: false, io: { write: refuse, ask: refuse }, signal });
    assert.equal(plan.setup, null);

    const stop = new AbortController();
    const io = scriptedIO([[/Choose 1 or 2/, () => { stop.abort(); throw new OnboardingCancelled(); }]]);
    await assert.rejects(() => prepareOnboarding(config, { force: true, io, signal: stop.signal }), OnboardingCancelled);
    assert.equal((await readSetupState(config.dataDir))?.stage, 'complete');
  });
});

test('choosing the managed browser points the config at its endpoint, and a later switch back to native restores the original endpoint', async () => {
  await withConfig(async config => {
    const docker = managed(() => 'http://127.0.0.1:41090/mcp');
    const first = await prepareOnboarding(config, { force: false, io: scriptedIO([[/Choose 1 or 2/, '2']]), signal, dependencies: docker });
    assert.equal(first.config.browserMcpUrl, 'http://127.0.0.1:41090/mcp');
    assert.equal((await loadConfig(config.path)).browserMcpUrl, 'http://127.0.0.1:41090/mcp');
    assert.deepEqual(first.setup?.stage === 'chatgpt' && first.setup.browser, { mode: 'docker', nativeEndpoint });
    assert.equal(first.viewerUrl, 'http://127.0.0.1:41080/');
    await writeSetupState(config.dataDir, completeSetup({ mode: 'docker', nativeEndpoint }));

    const switched = await prepareOnboarding(first.config, { force: true, io: scriptedIO([[/Choose 1 or 2/, '1'], [/different local BrowserOS/, '']]), signal, dependencies: docker });
    assert.equal(switched.config.browserMcpUrl, nativeEndpoint);
    assert.equal((await loadConfig(config.path)).browserMcpUrl, nativeEndpoint);
    assert.deepEqual(switched.setup?.stage === 'chatgpt' && switched.setup.browser, { mode: 'native' });
    const saved = await readSetupState(config.dataDir);
    assert.deepEqual(saved?.stage === 'chatgpt' && saved.browser, { mode: 'native' });
  });
});

test('a custom native address typed during setup is validated and saved to the config', async () => {
  await withConfig(async config => {
    const typed = 'http://127.0.0.1:9333/mcp';
    const plan = await prepareOnboarding(config, { force: false, io: scriptedIO([[/Choose 1 or 2/, '1'], [/different local BrowserOS/, 'http://example.com/mcp', typed]]), signal, dependencies: managed(() => 'http://127.0.0.1:41090/mcp') });
    assert.equal(plan.config.browserMcpUrl, typed);
    assert.equal((await loadConfig(config.path)).browserMcpUrl, typed);
  });
});

test('an unavailable managed browser is reported, retried and can be backed out of without claiming success', async () => {
  await withConfig(async config => {
    const docker = managed(() => 'http://127.0.0.1:41090/mcp', 2);
    const io = scriptedIO([[/Choose 1 or 2/, '2', '1'], [/different local BrowserOS/, ''], [/retry/, '', 'b']]);
    const plan = await prepareOnboarding(config, { force: false, io, signal, dependencies: docker });
    assert.equal(docker.starts, 2);
    assert.deepEqual(plan.setup?.stage === 'chatgpt' && plan.setup.browser, { mode: 'native' });
    assert.equal(plan.config.browserMcpUrl, nativeEndpoint);
    assert.equal((await loadConfig(config.path)).browserMcpUrl, nativeEndpoint);

    const retried = managed(() => 'http://127.0.0.1:41090/mcp', 1);
    const again = await prepareOnboarding(plan.config, { force: true, io: scriptedIO([[/Choose 1 or 2/, '2'], [/retry/, '']]), signal, dependencies: retried });
    assert.equal(retried.starts, 2);
    assert.equal(again.config.browserMcpUrl, 'http://127.0.0.1:41090/mcp');
  });
});

test('a completed Docker setup starts its browser on every launch and follows the endpoint it now has, without the wizard', async () => {
  await withConfig(async config => {
    await writeSetupState(config.dataDir, completeSetup({ mode: 'docker', nativeEndpoint }));
    let port = 41100;
    const docker = managed(() => `http://127.0.0.1:${port}/mcp`);
    const first = await prepareOnboarding(config, { force: false, io: { write: () => {}, ask: refuse }, signal, dependencies: docker });
    assert.equal(first.setup, null);
    assert.equal(first.config.browserMcpUrl, 'http://127.0.0.1:41100/mcp');
    port = 41200;
    const second = await prepareOnboarding(first.config, { force: false, io: { write: () => {}, ask: refuse }, signal, dependencies: docker });
    assert.equal(second.config.browserMcpUrl, 'http://127.0.0.1:41200/mcp');
    assert.equal((await readSetupState(config.dataDir))?.stage, 'complete');
  });
});

test('a setup interrupted after choosing Docker resumes at its checkpoint with the managed browser running again', async () => {
  await withConfig(async config => {
    await writeSetupState(config.dataDir, checkpoint({ mode: 'docker', nativeEndpoint }, 'whatsapp'));
    const docker = managed(() => 'http://127.0.0.1:41300/mcp');
    const plan = await prepareOnboarding(config, { force: false, io: silent, signal, dependencies: docker });
    assert.equal(plan.setup?.stage, 'whatsapp');
    assert.equal(plan.config.browserMcpUrl, 'http://127.0.0.1:41300/mcp');
    assert.equal(docker.starts, 1);
  });
});

test('when the native address cannot be restored after Docker, the managed endpoint is never accepted as native', async () => {
  const managedEndpoint = 'http://127.0.0.1:41090/mcp';
  const forcedSetup = async (config: LoadedConfig, restoreFailures: number, rules: Parameters<typeof scriptedIO>[0]): Promise<PreparedOnboarding> => {
    let failures = restoreFailures;
    const dependencies: Partial<OnboardingDependencies> = {
      saveEndpoint: async (target, endpoint) => {
        if (endpoint === nativeEndpoint && failures-- > 0) throw new Error('disk is read-only');
        await setBrowserMcpUrl(target, endpoint);
      },
    };
    await writeSetupState(config.dataDir, completeSetup({ mode: 'docker', nativeEndpoint }));
    return prepareOnboarding(config, { force: true, io: scriptedIO([[/Choose 1 or 2/, '1'], ...rules]), signal, dependencies });
  };
  await withConfig(async config => {
    const plan = await forcedSetup(config, 1, [[/Type your local BrowserOS/, ''], [/different local BrowserOS/, '']]);
    assert.equal(plan.config.browserMcpUrl, nativeEndpoint);
    assert.equal((await loadConfig(config.path)).browserMcpUrl, nativeEndpoint);
  }, managedEndpoint);
  await withConfig(async config => {
    const typed = 'http://127.0.0.1:9333/mcp';
    const plan = await forcedSetup(config, 99, [[/Type your local BrowserOS/, '', typed]]);
    assert.equal(plan.config.browserMcpUrl, typed);
    assert.equal((await loadConfig(config.path)).browserMcpUrl, typed);
  }, managedEndpoint);
});
