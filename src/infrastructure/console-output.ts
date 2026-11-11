import type { Logger } from '../core/contracts.js';

export function routeConsoleOutput(logger: Logger): () => void {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] satisfies Array<keyof Console>;
  const originals = methods.map(method => ({ method, original: console[method] }));
  for (const { method } of originals) {
    console[method] = (...values: unknown[]): void => {
      const message = values.map(value => {
        if (value instanceof Error) return value.message;
        if (value !== null && typeof value === 'object') return '[structured details redacted]';
        return String(value);
      }).join(' ');
      logger(`[dependency/${method}] ${message}`);
    };
  }
  return () => { for (const { method, original } of originals) console[method] = original; };
}
