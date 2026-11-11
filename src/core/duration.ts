import { DEFAULT_CONVERSATION_TTL_MINUTES } from './state.js';

const MAX_MINUTES = 3650 * 1440;

/** Minutes, or null for "never". Accepts 90, 90m, 12h, 3d and never; an empty answer means the 24 h default. */
export function parseConversationTtl(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return DEFAULT_CONVERSATION_TTL_MINUTES;
  if (text === 'never') return null;
  const match = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/.exec(text);
  if (!match) throw new Error('Enter a lifetime like 90m, 12h, 3d or never. A bare number means minutes; empty means 24h.');
  const unit = match[2]?.[0] ?? 'm';
  const minutes = Number(match[1]) * (unit === 'd' ? 1440 : unit === 'h' ? 60 : 1);
  if (!Number.isFinite(minutes) || Math.abs(minutes - Math.round(minutes)) > 1e-9 || Math.round(minutes) < 1 || Math.round(minutes) > MAX_MINUTES) {
    throw new Error('Lifetime must be a whole number of minutes between 1 minute and 3650 days, or never.');
  }
  return Math.round(minutes);
}

/** Single-unit text that parseConversationTtl accepts back: never, 90m, 24h, 3d. */
export function formatConversationTtl(minutes: number | null): string {
  if (minutes === null) return 'never';
  if (minutes > 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
