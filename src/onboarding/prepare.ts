import { loadConfig, setBrowserMcpUrl, type LoadedConfig } from '../infrastructure/config.js';
import { ensureManagedBrowser, openSetupUrl } from './browser.js';
import { OnboardingCancelled } from './cancelled.js';
import { checkpoint, hasLegacyData, pendingSetup, readSetupState, writeSetupState, type BrowserSelection, type SetupState } from './state.js';
import { ask, clean, errorText } from './text.js';
import type { SetupIO } from './terminal.js';

export const browserOsReleases = 'https://github.com/browseros-ai/BrowserOS/releases';

/** Result of choosing and preparing the browser. `setup` is null when no wizard is needed. */
export interface PreparedOnboarding {
  config: LoadedConfig;
  setup: SetupState | null;
  /** Viewer of the managed browser, when one is being set up, so the wizard can point the user at it again. */
  viewerUrl?: string;
}

/** Replaceable side effects (managed browser, URL opener, config persistence), for tests. */
export interface OnboardingDependencies {
  ensureBrowser: typeof ensureManagedBrowser;
  openUrl: typeof openSetupUrl;
  saveEndpoint: (config: Pick<LoadedConfig, 'path'>, endpoint: string) => Promise<void>;
  reload: (path: string) => Promise<LoadedConfig>;
}

export interface PrepareOptions {
  force: boolean;
  io: SetupIO;
  signal: AbortSignal;
  dependencies?: Partial<OnboardingDependencies>;
}

const defaults: OnboardingDependencies = {
  ensureBrowser: ensureManagedBrowser,
  openUrl: openSetupUrl,
  saveEndpoint: setBrowserMcpUrl,
  reload: loadConfig,
};

type ManagedOutcome = { config: LoadedConfig; viewerUrl: string } | 'back';

/**
 * Ensures the managed Docker browser runs and that the effective config points at its current endpoint (host ports are
 * allocated per container start). Failures are explained and can be retried; nothing is reported as working until it is.
 */
async function startManagedBrowser(config: LoadedConfig, options: PrepareOptions, deps: OnboardingDependencies, allowBack: boolean): Promise<ManagedOutcome> {
  const { io, signal } = options;
  for (;;) {
    try {
      const browser = await deps.ensureBrowser({ dataDir: config.dataDir, signal, log: text => io.write(`${clean(text, 200)}\n`) });
      if (browser.endpoint === config.browserMcpUrl) return { config, viewerUrl: browser.viewerUrl };
      await deps.saveEndpoint(config, browser.endpoint);
      return { config: await deps.reload(config.path), viewerUrl: browser.viewerUrl };
    } catch (error) {
      if (signal.aborted) throw new OnboardingCancelled();
      io.write(`\nThe managed BrowserOS browser is not available: ${errorText(error)}\n`);
      const answer = (await ask(io, allowBack
        ? "Fix that (for example start Docker), then press Enter to retry, or type 'b' to choose a different browser: "
        : 'Fix that (for example start Docker), then press Enter to retry. Press Ctrl-C to stop; "wabgpt setup" can pick another browser: ')).toLowerCase();
      if (allowBack && (answer === 'b' || answer === 'back')) return 'back';
    }
  }
}

async function announceViewer(url: string, io: SetupIO, deps: OnboardingDependencies, open: boolean): Promise<void> {
  io.write(`\nYour private BrowserOS browser is running. Open it here to sign in to ChatGPT yourself:\n  ${url}\n`);
  if (!open) return;
  try { await deps.openUrl(url); io.write('(Opened in your default browser.)\n'); }
  catch { io.write('(Could not open it automatically; open the address above yourself.)\n'); }
}

/** Native: keep (or replace) the configured loopback BrowserOS MCP address. Reachability is proven later by listing projects. */
async function selectNative(config: LoadedConfig, options: PrepareOptions, deps: OnboardingDependencies, preferred: string): Promise<LoadedConfig> {
  const { io } = options;
  let current = config;
  let owed = preferred !== current.browserMcpUrl;
  const restore = async (): Promise<void> => {
    try {
      await deps.saveEndpoint(current, preferred);
      current = await deps.reload(current.path);
      owed = false;
    } catch (error) { io.write(`Could not restore your BrowserOS address ${clean(preferred, 120)}: ${errorText(error)}\n`); }
  };
  if (owed) await restore();
  io.write(owed ? '\nThe managed browser address is still in your config and is NOT a native BrowserOS.\n' : `\nUsing BrowserOS on this computer at ${current.browserMcpUrl}\n`);
  io.write(`Install it from ${browserOsReleases}, start it, and keep it running. You sign in to ChatGPT in it yourself.\n`);
  for (;;) {
    const answer = await ask(options.io, owed
      ? `Type your local BrowserOS MCP address, or press Enter to retry restoring ${clean(preferred, 120)}: `
      : 'Press Enter to use that address, or type a different local BrowserOS MCP address: ');
    if (!answer) {
      if (!owed) return current;
      await restore();
      if (!owed) io.write(`Restored ${current.browserMcpUrl}.\n`);
      continue;
    }
    try {
      await deps.saveEndpoint(current, answer);
      current = await deps.reload(current.path);
      io.write(`Saved ${current.browserMcpUrl} in ${current.path}.\n`);
      return current;
    } catch (error) { io.write(`${errorText(error)}\n`); }
  }
}

async function chooseBrowser(config: LoadedConfig, options: PrepareOptions, deps: OnboardingDependencies, previous: BrowserSelection | undefined): Promise<PreparedOnboarding> {
  const { io } = options;
  io.write('\nWelcome to wabgpt. It forwards chosen WhatsApp contacts to ChatGPT through the BrowserOS browser and sends the reply back.\n');
  io.write('Setup takes a few minutes and you can stop with Ctrl-C at any point and continue later.\n');
  let current = config;
  for (;;) {
    io.write('\nWhich BrowserOS should wabgpt use?\n');
    io.write('  1) BrowserOS already installed on this computer (uses the ChatGPT login it already has)\n');
    io.write('  2) Let wabgpt download BrowserOS and run it for you in Docker, with its own isolated, persistent profile.\n');
    io.write('     Its control and viewer ports are reachable from this computer only. No Docker Compose commands are needed.\n');
    const answer = await ask(io, `Choose 1 or 2${previous ? ` [${previous.mode === 'native' ? 1 : 2}]` : ''}: `);
    const mode = answer === '1' ? 'native' : answer === '2' ? 'docker' : answer === '' ? previous?.mode : undefined;
    if (mode === undefined) { io.write('Please enter 1 or 2.\n'); continue; }
    if (mode === 'native') {
      // After Docker the config holds the managed endpoint; the user's own native address was kept in the setup state.
      current = await selectNative(current, options, deps, previous?.mode === 'docker' ? previous.nativeEndpoint : current.browserMcpUrl);
      const setup = checkpoint({ mode: 'native' }, 'chatgpt');
      await writeSetupState(current.dataDir, setup);
      return { config: current, setup };
    }
    // Recorded before the config is rewritten, so an interruption can never lose the native endpoint.
    const selection: BrowserSelection = { mode: 'docker', nativeEndpoint: previous?.mode === 'docker' ? previous.nativeEndpoint : current.browserMcpUrl };
    const setup = checkpoint(selection, 'chatgpt');
    await writeSetupState(current.dataDir, setup);
    const outcome = await startManagedBrowser(current, options, deps, true);
    if (outcome === 'back') continue;
    await announceViewer(outcome.viewerUrl, io, deps, true);
    return { config: outcome.config, setup, viewerUrl: outcome.viewerUrl };
  }
}

/**
 * Decides, before the application exists, whether setup is needed and prepares the browser it will talk to. Runs under the
 * data directory's lock. A pending marker is written first when none exists, so the routing state file that opening the
 * application creates can never make a fresh install look like a legacy one.
 *
 * - Completed setup, or an installation that predates onboarding: no wizard (setup is null); a managed browser is still
 *   started and the config follows its current endpoint. `force` reruns setup.
 * - Otherwise the wizard resumes from its checkpoint.
 */
export async function prepareOnboarding(config: LoadedConfig, options: PrepareOptions): Promise<PreparedOnboarding> {
  const deps = { ...defaults, ...options.dependencies };
  const existing = await readSetupState(config.dataDir);
  if (!existing && !options.force && await hasLegacyData(config.dataDir)) return { config, setup: null };

  if (existing?.stage === 'complete' && !options.force) {
    if (existing.browser.mode !== 'docker') return { config, setup: null };
    const outcome = await startManagedBrowser(config, options, deps, false);
    return { config: outcome === 'back' ? config : outcome.config, setup: null };
  }

  if (!existing) await writeSetupState(config.dataDir, pendingSetup());
  if (!options.force && existing && existing.stage !== 'browser') {
    const resumed = existing;
    options.io.write(`\nContinuing wabgpt setup where you left off (${resumed.stage === 'chatgpt' ? 'ChatGPT sign-in' : resumed.stage === 'whatsapp' ? 'WhatsApp' : 'first contact'}).\n`);
    if (resumed.browser.mode === 'native') return { config, setup: resumed };
    const outcome = await startManagedBrowser(config, options, deps, true);
    if (outcome !== 'back') {
      if (resumed.stage === 'chatgpt') await announceViewer(outcome.viewerUrl, options.io, deps, false);
      return { config: outcome.config, setup: resumed, viewerUrl: outcome.viewerUrl };
    }
    return chooseBrowser(config, options, deps, resumed.browser);
  }
  const previous = existing && existing.stage !== 'browser' ? existing.browser : undefined;
  return chooseBrowser(config, options, deps, previous);
}
