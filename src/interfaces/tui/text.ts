import blessed from 'blessed';
import qrcode from 'qrcode-terminal';
import { stripVTControlCharacters } from 'node:util';

/** Untrusted text made safe for a blessed box with tags enabled: no escape sequences, no control characters, tags escaped. */
export function clean(text: string): string {
  return blessed.escape(stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''));
}

/** One visible line of text, no control characters. */
export function plain(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cellWidth(code: number): number {
  if (code === 0x200d || (code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)) return 2;
  return 1;
}

export function textWidth(text: string): number {
  let total = 0;
  for (const char of text) total += cellWidth(char.codePointAt(0) ?? 0);
  return total;
}

/** Truncates to at most `max` terminal cells, ending in an ellipsis when something was cut. Never splits a code point. */
export function fit(text: string, max: number): string {
  if (max <= 0) return '';
  if (textWidth(text) <= max) return text;
  let out = ''; let used = 0;
  for (const char of text) {
    const next = cellWidth(char.codePointAt(0) ?? 0);
    if (used + next > max - 1) break;
    out += char; used += next;
  }
  return `${out}…`;
}

export function wrap(text: string, max: number, maxLines: number): string[] {
  const lines: string[] = []; let line = '';
  for (const word of text.split(' ')) {
    const piece = line ? `${line} ${word}` : word;
    if (textWidth(piece) <= max) line = piece;
    else { if (line) lines.push(line); line = fit(word, max); }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = fit(`${lines[maxLines - 1]}…`, max); }
  return lines;
}

/** Renders a raw QR payload as terminal block characters. */
export function renderQr(payload: string): string {
  let rendered = '';
  qrcode.generate(payload, { small: true }, (output: string) => { rendered = output; });
  return rendered;
}
