import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { OnboardingCancelled } from './cancelled.js';

export interface SetupIO {
  write(text: string): void;
  ask(prompt: string): Promise<string>;
}

export interface TerminalSetupOptions {
  signal: AbortSignal;
  /** Called when the user presses Ctrl-C while the prompt owns the terminal. */
  onInterrupt: () => void;
  /** Overridable streams; they default to the process terminal. */
  input?: Readable;
  output?: Writable;
}

/**
 * Line-based prompts over the terminal. The readline interface is created by the first question, so launches that never
 * onboard leave stdin untouched. Output goes straight to the stream, not through the (possibly redirected) console.
 * A pending question rejects with OnboardingCancelled when the signal aborts or the terminal closes.
 */
export function createTerminalSetupIO(options: TerminalSetupOptions): { io: SetupIO; close(): void } {
  const { signal, onInterrupt } = options;
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  let readline: Interface | undefined;
  let closed = false;
  let rejectPending: ((error: OnboardingCancelled) => void) | undefined;

  const onAbort = (): void => rejectPending?.(new OnboardingCancelled());
  signal.addEventListener('abort', onAbort);

  function open(): Interface {
    const created = createInterface({ input, output });
    created.on('SIGINT', onInterrupt);
    created.on('close', () => { closed = true; rejectPending?.(new OnboardingCancelled()); });
    return created;
  }

  function close(): void {
    signal.removeEventListener('abort', onAbort);
    closed = true;
    readline?.close();
  }

  return {
    io: {
      write(text) { output.write(text); },
      async ask(prompt) {
        if (closed || signal.aborted) throw new OnboardingCancelled();
        readline ??= open();
        const { promise: cancelled, reject } = Promise.withResolvers<never>();
        rejectPending = reject;
        const answer = readline.question(prompt, { signal });
        answer.catch(() => undefined);
        try { return await Promise.race([answer, cancelled]); }
        catch (error) {
          if (error instanceof OnboardingCancelled) throw error;
          if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new OnboardingCancelled();
          throw error;
        } finally { rejectPending = undefined; }
      },
    },
    close,
  };
}
