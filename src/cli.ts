#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { serveUntilStopped } from './serve.js';
import { readOrCreateOwnerToken } from './interfaces/http/auth.js';
import { runTui } from './interfaces/tui/tui.js';
import { openRuntime } from './bootstrap.js';
import { parseCommandLine, usage } from './infrastructure/arguments.js';
import { defaultConfigPath, loadConfig } from './infrastructure/config.js';
import { completeOnboarding, createTerminalSetupIO, OnboardingCancelled, prepareOnboarding, type PreparedOnboarding } from './onboarding/index.js';

const help = `wabgpt · WhatsApp ↔ ChatGPT bridge

${usage}
  wabgpt                Terminal dashboard; the first run starts a short guided setup
  wabgpt setup          Run the guided setup again (browser, ChatGPT, WhatsApp, first contact)
  wabgpt serve          Headless owner web dashboard (single user, no terminal needed)
  wabgpt token          Print the owner login token for the web dashboard
Config: ${defaultConfigPath}

Terminal dashboard keys:
L  Connect WhatsApp or show a pairing QR
R  Resume enabled forwarding sessions
P  Pause all forwarding
A  Add an international phone number
B  Check BrowserOS connectivity and the ChatGPT composer (not proof of login)
G  Pick or clear the selected contact's ChatGPT project from a searchable list of your projects
T  Set the selected contact's fixed chat lifetime: 90m, 12h, 3d or never (default 24h)
Space  Enable or pause the selected contact/session
/  Search saved contacts and chats
1 / 2 / 3  All / Contacts / Recent chats
Tab  Switch between directory and saved sessions
Q  Quit, retaining settings for next launch

Contacts, recent chats, WhatsApp login, session choices, ChatGPT
conversation URLs, projects and lifetimes are saved locally. Previously
active sessions resume on launch. Paused or failed sessions stay paused.
No environment variables are required. Enabled chats share incoming text
with ChatGPT and send its reply automatically. Only direct text messages
are forwarded. Configuring G or T never enables a contact.

Projects: G opens a searchable list of your ChatGPT projects, read live
through BrowserOS in a separate tab; no URL is needed. Type to filter,
Up/Down move, Enter assigns, Tab switches to list keys (R refreshes, C
selects "No project"), F5 or Ctrl-R refreshes anywhere, Esc cancels.
A project used by another contact is shown but cannot be chosen. Use a
separate project per contact, with project-only memory set in ChatGPT;
wabgpt does not verify or change that setting. Changing a contact's
project resets its next chat. The old chat is not moved, imported or
deleted. Projects in ChatGPT:
https://help.openai.com/en/articles/10169521-projects-in-chatgpt

Lifetime: fixed from the first saved chat URL, not extended by new
messages. A saved chat past its lifetime is dropped locally only when the
next message arrives, never mid-reply and never remotely; the lifetime
limits only that active thread, not project-wide context. Older saved
chats get their lifetime clock started once when first upgraded. This is
a ChatGPT web subscription, not per-token API billing; no token, cost or
latency saving is promised.

Server: "wabgpt serve" runs the same bridge headless with an owner-only
web dashboard; sign in with the token from "wabgpt token". Optional config
key "server": { "host": "127.0.0.1", "port": 8788, "tokenFile": "<path>",
"publicOrigin": "https://..." }. It listens on loopback by default; reach it
over an SSH tunnel or VPN. publicOrigin is only for a TLS reverse proxy you
trust and must be HTTPS (or loopback). Only one wabgpt process may use a
data directory at a time.
`;

/** Exit status for a setup the user interrupted: progress is saved, so it is a normal stop, not a failure. */
const interruptedExitCode = 130;

/**
 * Terminal dashboard, preceded by guided setup when it is the first run or `force` is set. Setup runs
 * inside openRuntime's prepare hook, after the data-directory lock is held and before any provider is
 * built, so the browser endpoint it chooses is the one the Application uses. Interrupting setup (Ctrl-C,
 * SIGTERM, SIGHUP) aborts it, releases the lock and exits quietly; completed steps stay saved.
 */
async function runTerminal(configPath: string | undefined, force: boolean): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('wabgpt needs an interactive terminal. Run it directly in a terminal tab, use "wabgpt serve" for the web dashboard, or use --help for usage.');
  const config = await loadConfig(configPath);
  const cancellation = new AbortController();
  const { signal } = cancellation;
  const cancel = (): void => cancellation.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const name of signals) process.on(name, cancel);
  const terminal = createTerminalSetupIO({ signal, onInterrupt: cancel });
  let finished = false;
  const finishSetupIO = (): void => {
    if (finished) return;
    finished = true;
    for (const name of signals) process.off(name, cancel);
    terminal.close();
  };
  let plan: PreparedOnboarding = { config, setup: null };
  try {
    const runtime = await openRuntime(config, {
      prepare: async current => {
        plan = await prepareOnboarding(current, { force, io: terminal.io, signal });
        return plan.config;
      },
    });
    try {
      await completeOnboarding(runtime.application, plan, { io: terminal.io, signal });
      if (signal.aborted) throw signal.reason;
      finishSetupIO();
      await runTui(runtime.application);
    } finally { await runtime.close(); }
  } catch (error) {
    if (!signal.aborted && !(error instanceof OnboardingCancelled)) throw error;
    stdout.write('\nSetup stopped. Your progress is saved; run "wabgpt" to continue.\n');
    process.exitCode = interruptedExitCode;
  } finally { finishSetupIO(); }
}

async function runServer(configPath: string | undefined): Promise<void> {
  const config = await loadConfig(configPath);
  const runtime = await openRuntime(config);
  const stopped = Promise.withResolvers<void>();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const onSignal = (): void => stopped.resolve();
  for (const signal of signals) process.on(signal, onSignal);
  try { await serveUntilStopped({ runtime, settings: config.server, stopped: stopped.promise, output: text => stdout.write(text) }); }
  finally { for (const signal of signals) process.off(signal, onSignal); }
}

async function printToken(configPath: string | undefined): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('wabgpt token prints a login secret and only runs in an interactive terminal.');
  const config = await loadConfig(configPath);
  stdout.write(`${await readOrCreateOwnerToken(config.server.tokenFile)}\n`);
}

async function main(): Promise<void> {
  const { command, config } = parseCommandLine(process.argv.slice(2));
  if (command === 'help') { stdout.write(help); return; }
  if (command === 'serve') return runServer(config);
  if (command === 'token') return printToken(config);
  return runTerminal(config, command === 'setup');
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
