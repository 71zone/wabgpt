import { OnboardingCancelled } from './cancelled.js';
import type { SetupIO } from './terminal.js';

/** Untrusted text (contact and project names, error details) made safe to print: no control, escape or bidi characters. */
export function clean(text: string, max = 80): string {
  const plain = text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim();
  const characters = Array.from(plain);
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : plain;
}

export function errorText(error: unknown): string {
  return clean(error instanceof Error ? error.message : String(error), 300) || 'Unknown error.';
}

/** Rejects with OnboardingCancelled as soon as the signal aborts, without waiting for `work`. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { work.catch(() => undefined); throw new OnboardingCancelled(); }
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => reject(new OnboardingCancelled());
  signal.addEventListener('abort', onAbort, { once: true });
  work.catch(() => undefined);
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** One trimmed answer. */
export async function ask(io: SetupIO, prompt: string): Promise<string> {
  return (await io.ask(prompt)).trim();
}

/** A yes/no question; an empty answer returns `fallback`, anything unrecognised asks again. */
export async function askYesNo(io: SetupIO, prompt: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await ask(io, `${prompt} ${fallback ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
    if (!answer) return fallback;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    io.write('Please answer y or n.\n');
  }
}
