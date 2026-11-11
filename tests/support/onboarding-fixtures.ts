import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application } from '../../src/core/application.js';
import type { AssistantAdapter, Contact, MessagingAdapter, Project } from '../../src/core/contracts.js';
import { loadConfig, type LoadedConfig } from '../../src/infrastructure/config.js';
import type { SetupIO } from '../../src/onboarding/terminal.js';
import { fakeAssistant, fakeChannel, loadState, providerNames } from './core-fixtures.js';

export const nativeEndpoint = 'http://127.0.0.1:9010/mcp';

/** A real config file in a temporary directory with its own data directory, loaded through the real loader. */
export async function withConfig(run: (config: LoadedConfig, directory: string) => Promise<void>, endpoint = nativeEndpoint): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'wabgpt-onboarding-'));
  try {
    await mkdir(join(directory, 'data'), { recursive: true });
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify({ browserMcpUrl: endpoint, dataDir: join(directory, 'data') }));
    await run(await loadConfig(path), directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

type Answer = string | ((io: ScriptedIO) => string);
export type ScriptedIO = SetupIO & { output: string; prompts: string[] };

/**
 * Synthetic terminal. The first rule whose pattern matches a prompt answers it; a rule with several answers hands them out in
 * order and repeats the last one. A prompt nobody expected fails the test.
 */
export function scriptedIO(rules: Array<[RegExp, ...Answer[]]>): ScriptedIO {
  const used = rules.map(() => 0);
  const io: ScriptedIO = {
    output: '', prompts: [],
    write(text) { io.output += text; },
    async ask(prompt) {
      io.prompts.push(prompt);
      const index = rules.findIndex(([pattern]) => pattern.test(prompt));
      const rule = rules[index];
      if (!rule) throw new Error(`Unexpected prompt: ${prompt}`);
      const [, ...answers] = rule;
      const answer = answers[Math.min(used[index] ?? 0, answers.length - 1)] ?? '';
      used[index] = (used[index] ?? 0) + 1;
      return typeof answer === 'function' ? answer(io) : answer;
    },
  };
  return io;
}

export interface Harness {
  application: Application;
  config: LoadedConfig;
  sent: string[];
}

export interface HarnessOptions {
  contacts?: Contact[];
  projects?: Project[] | ((signal?: AbortSignal) => Promise<Project[]>);
  /** Called for each connection attempt; throw to fail it. */
  connect?: (attempt: number) => void;
  assistant?: Partial<AssistantAdapter>;
}

/** The real Application over the real JSON state in `config.dataDir`, with synthetic WhatsApp and ChatGPT adapters. */
export async function harness(config: LoadedConfig, options: HarnessOptions = {}): Promise<Harness> {
  const contacts = options.contacts ?? [];
  const sent: string[] = [];
  let attempts = 0;
  let application: Application | undefined;
  const channel: MessagingAdapter = fakeChannel({
    contacts: () => contacts,
    resolveContact(input) {
      if (/^\d+@(?:s\.whatsapp\.net|lid)$/.test(input)) return { id: input, name: `+${input.split('@')[0]}` };
      const digits = input.replace(/[\s()+.-]/g, '');
      if (!/^[1-9]\d{6,14}$/.test(digits)) throw new Error('Enter a full international number with country code.');
      return { id: `${digits}@s.whatsapp.net`, name: `+${digits}` };
    },
    async start() {
      options.connect?.(++attempts);
      application?.emit('qr', 'synthetic-qr-payload');
      application?.setChannelStatus('waiting-for-qr-scan');
      application?.emit('qr', '');
      application?.setChannelStatus('open');
    },
    sendText: async (_id, text) => { sent.push(text); },
  });
  const catalog = options.projects ?? [];
  const assistant = fakeAssistant({ listProjects: typeof catalog === 'function' ? catalog : async () => catalog, ...options.assistant });
  application = new Application({ configPath: config.path, ...providerNames }, await loadState(config.dataDir), channel, assistant);
  return { application, config, sent };
}
