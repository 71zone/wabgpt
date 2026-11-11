export type CommandName = 'tui' | 'setup' | 'serve' | 'token' | 'help';
export interface CommandLine { command: CommandName; config?: string }

const commands = new Set(['setup', 'serve', 'token', 'help']);
export const usage = 'Usage: wabgpt [setup | serve | token] [--config <path>]';

/** Parses `wabgpt [setup|serve|token|help] [--config <path>]`; `--help`/`-h` anywhere wins. */
export function parseCommandLine(args: readonly string[]): CommandLine {
  let command: CommandName | undefined;
  let config: string | undefined;
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--config' || arg.startsWith('--config=')) {
      if (config !== undefined) throw new Error(`--config was given more than once. ${usage}`);
      const value = arg === '--config' ? args[++index] : arg.slice('--config='.length);
      if (!value) throw new Error(`--config needs a path. ${usage}`);
      config = value;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}. ${usage}`);
    if (command !== undefined || !commands.has(arg)) throw new Error(`Unknown command ${arg}. ${usage}`);
    command = arg as CommandName;
  }
  return { command: help ? 'help' : command ?? 'tui', ...(config === undefined ? {} : { config }) };
}
