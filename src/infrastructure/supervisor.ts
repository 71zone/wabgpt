import { spawn, type ChildProcess } from 'node:child_process';

/** Exit status a dashboard process uses to ask its supervisor for a fresh process after a graceful stop. */
export const RESTART_EXIT_CODE = 75;
const SUPERVISED = 'WABGPT_SUPERVISED';
const SESSION_START = 'WABGPT_SESSION_START';
const RESTARTED = 'WABGPT_RESTARTED';
const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export function isSupervised(): boolean { return process.env[SUPERVISED] === '1'; }
export function wasRestarted(): boolean { return process.env[RESTARTED] === '1'; }

/**
 * Unix seconds at which the first process of this supervised run started, or undefined when unsupervised. Messages WhatsApp
 * queued while a restart was in progress are newer than this, so the new process still forwards them instead of treating
 * them as history. Delivery IDs already claimed are never replayed.
 */
export function sessionStartSeconds(): number | undefined {
  const value = Number(process.env[SESSION_START]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Runs this same command line in a child that shares the terminal and respawns it whenever it exits with RESTART_EXIT_CODE,
 * so a restart hotkey never returns to the shell. Any other exit status ends the supervisor with that status. The child holds
 * the data-directory lock; the supervisor holds nothing and ignores terminal Ctrl-C, which the child already receives as part
 * of the foreground process group.
 */
export async function superviseRestarts(): Promise<number> {
  const startedAt = String(Math.floor(Date.now() / 1000));
  let restarted = false;
  let child: ChildProcess | undefined;
  const relay = (signal: NodeJS.Signals): void => { child?.kill(signal); };
  for (const signal of forwarded) process.on(signal, relay);
  try {
    for (;;) {
      child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        stdio: 'inherit',
        env: { ...process.env, [SUPERVISED]: '1', [SESSION_START]: startedAt, [RESTARTED]: restarted ? '1' : '0' },
      });
      const exit = Promise.withResolvers<number>();
      child.once('error', error => { process.stderr.write(`${error.message}\n`); exit.resolve(1); });
      child.once('exit', (code, signal) => exit.resolve(code ?? (signal ? 128 : 1)));
      const code = await exit.promise;
      if (code !== RESTART_EXIT_CODE) return code;
      restarted = true;
    }
  } finally { for (const signal of forwarded) process.off(signal, relay); }
}
