import { writeFile } from "node:fs/promises";
import type { Attachment, ReplyBlock } from "../../core/contracts.js";
import type { MediaStore } from "../../infrastructure/media.js";

export const MAX_TEXT_CHARS = 4000;
export const MAX_INLINE_CODE_CHARS = 12000;
export const MAX_GRID_WIDTH = 40;
export const MAX_GRID_ROWS = 30;
export const CSV_ROW_THRESHOLD = 8;

export type OutboundMessage =
  | { kind: "text"; text: string }
  | { kind: "media"; attachment: Attachment; caption?: string };

/** A message before any file exists on disk: generated files carry their content and are materialized by renderReply. */
export type PlannedMessage =
  | { kind: "text"; text: string }
  | { kind: "media"; attachment: Attachment; caption?: string }
  | { kind: "file"; fileName: string; mimeType: string; content: string };

const ZERO_WIDTH_SPACE = "\u200b";
const BOLD_MARK = "\uE000";
const ESCAPED: ReadonlyMap<string, string> = new Map([["*", "\uE001"], ["_", "\uE002"], ["~", "\uE003"]]);
const STASH_OPEN = "\uF000";
const STASH_CLOSE = "\uF001";
const FENCE_LINE = /^\s*(```|~~~)/;
const RESERVE_FOR_FENCES = 8;

const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["javascript", "js"], ["js", "js"], ["jsx", "jsx"], ["typescript", "ts"], ["ts", "ts"], ["tsx", "tsx"], ["python", "py"], ["py", "py"],
  ["json", "json"], ["bash", "sh"], ["sh", "sh"], ["shell", "sh"], ["zsh", "sh"], ["html", "html"], ["css", "css"], ["java", "java"],
  ["c", "c"], ["cpp", "cpp"], ["c++", "cpp"], ["csharp", "cs"], ["cs", "cs"], ["go", "go"], ["rust", "rs"], ["rs", "rs"], ["ruby", "rb"],
  ["rb", "rb"], ["php", "php"], ["sql", "sql"], ["yaml", "yaml"], ["yml", "yml"], ["xml", "xml"], ["markdown", "md"], ["md", "md"],
  ["kotlin", "kt"], ["swift", "swift"], ["toml", "toml"], ["lua", "lua"], ["r", "r"],
]);

export function extensionForLanguage(language: string | null): string {
  return EXTENSIONS.get((language ?? "").trim().toLowerCase()) ?? "txt";
}

function width(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function cutPoint(text: string, at: number): number {
  const previous = text.charCodeAt(at - 1);
  return previous >= 0xd800 && previous <= 0xdbff ? at - 1 : at;
}

/** Converts inline Markdown to WhatsApp syntax; code spans and URLs are shielded from the emphasis rules. */
export function inlineToWhatsApp(source: string): string {
  const stash: string[] = [];
  const keep = (text: string): string => {
    stash.push(text);
    return `${STASH_OPEN}${stash.length - 1}${STASH_CLOSE}`;
  };
  let text = source.replace(/(``[^\n]+?``|`[^`\n]+`)/g, keep);
  text = text.replace(/\\([*_~])/g, (_, char: string) => ESCAPED.get(char) ?? char);
  text = text.replace(/\\([\\`#>[\]()!+.-])/g, "$1");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_, label: string, url: string) =>
    label.trim() === url ? keep(url) : `${label.trim()} (${keep(url)})`);
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url: string) => keep(url));
  text = text.replace(/https?:\/\/[^\s)\]]+/g, keep);
  text = text.replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, `${BOLD_MARK}_$1_${BOLD_MARK}`);
  text = text.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, `${BOLD_MARK}$1${BOLD_MARK}`);
  text = text.replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, `${BOLD_MARK}$1${BOLD_MARK}`);
  text = text.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~");
  text = text.replace(/(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![*\w])/g, "_$1_");
  text = text.replaceAll(BOLD_MARK, "*");
  for (const [char, mark] of ESCAPED) text = text.replaceAll(mark, char);
  return text.replace(new RegExp(`${STASH_OPEN}(\\d+)${STASH_CLOSE}`, "g"), (_, index: string) => stash[Number(index)] ?? "");
}

const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Converts a Markdown document to WhatsApp formatting; fenced code passes through untouched. */
export function markdownToWhatsApp(markdown: string): string {
  const output: string[] = [];
  let fenced = false;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (FENCE_LINE.test(line)) {
      fenced = !fenced;
      output.push("```");
      continue;
    }
    if (fenced) {
      output.push(raw);
      continue;
    }
    if (HORIZONTAL_RULE.test(line)) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?$/.exec(line);
    if (heading) {
      const title = inlineToWhatsApp((heading[1] ?? "").replace(/\*\*|__/g, "").trim());
      if (title) output.push(`*${title}*`);
      continue;
    }
    const quote = /^\s{0,3}(?:>\s?)+(.*)$/.exec(line);
    if (quote) {
      output.push(`> ${inlineToWhatsApp(quote[1] ?? "")}`.trimEnd());
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      output.push(`${(bullet[1] ?? "").replaceAll("\t", "    ")}- ${inlineToWhatsApp(bullet[2] ?? "")}`);
      continue;
    }
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      output.push(`${(ordered[1] ?? "").replaceAll("\t", "    ")}${ordered[2]}. ${inlineToWhatsApp(ordered[3] ?? "")}`);
      continue;
    }
    output.push(inlineToWhatsApp(line));
  }
  if (fenced) output.push("```");
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

interface Atom { text: string; before: string }

function hardWrap(line: string, limit: number): Atom[] {
  const pieces: Atom[] = [];
  let rest = line;
  let before = "";
  while (rest.length > limit) {
    const space = rest.lastIndexOf(" ", limit);
    if (space > limit / 2) {
      pieces.push({ text: rest.slice(0, space), before });
      rest = rest.slice(space + 1);
      before = " ";
    } else {
      const cut = cutPoint(rest, limit);
      pieces.push({ text: rest.slice(0, cut), before });
      rest = rest.slice(cut);
      before = "";
    }
  }
  pieces.push({ text: rest, before });
  return pieces;
}

function balanceFences(chunks: string[]): string[] {
  let open = false;
  return chunks.map(chunk => {
    let text = open ? `\`\`\`\n${chunk}` : chunk;
    for (const line of chunk.split("\n")) if (/^```/.test(line)) open = !open;
    if (open) text += "\n```";
    return text;
  });
}

/** Splits text into messages of at most `max` characters, preferring paragraph then line boundaries and keeping code fences balanced. */
export function splitText(text: string, max = MAX_TEXT_CHARS): string[] {
  if (text.length <= max) return text ? [text] : [];
  const limit = max - RESERVE_FOR_FENCES;
  const atoms: Atom[] = [];
  text.split("\n\n").forEach((paragraph, index) => {
    const before = index === 0 ? "" : "\n\n";
    if (paragraph.length <= limit) {
      atoms.push({ text: paragraph, before });
      return;
    }
    paragraph.split("\n").forEach((line, lineIndex) => {
      const lineBefore = lineIndex === 0 ? before : "\n";
      const pieces = line.length <= limit ? [{ text: line, before: "" }] : hardWrap(line, limit);
      pieces.forEach((piece, pieceIndex) => atoms.push({ text: piece.text, before: pieceIndex === 0 ? lineBefore : piece.before }));
    });
  });
  const chunks: string[] = [];
  let current = "";
  let started = false;
  for (const atom of atoms) {
    const candidate = started ? current + atom.before + atom.text : atom.text;
    if (started && candidate.length > limit) {
      chunks.push(current);
      current = atom.text;
    } else {
      current = candidate;
    }
    started = true;
  }
  if (started) chunks.push(current);
  return balanceFences(chunks.map(chunk => chunk.trim()).filter(Boolean));
}

function fence(code: string): string {
  return `\`\`\`\n${code.replaceAll("```", `\`\`${ZERO_WIDTH_SPACE}\``)}\n\`\`\``;
}

function planCode(block: Extract<ReplyBlock, { type: "code" }>): PlannedMessage[] {
  const code = block.code.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
  if (!code.trim()) return [];
  if (code.length > MAX_INLINE_CODE_CHARS) {
    return [{ kind: "file", fileName: `snippet.${extensionForLanguage(block.language)}`, mimeType: "text/plain", content: code }];
  }
  return [{ kind: "text", text: fence(code) }];
}

function cleanCell(cell: string): string {
  return cell.replace(/\s*[\r\n]+\s*/g, " ").replace(/\t/g, " ").trim();
}

function normalizeTable(header: string[], rows: string[][]): { header: string[]; rows: string[][] } {
  const columns = Math.max(header.length, ...rows.map(row => row.length));
  const pad = (row: string[]): string[] => Array.from({ length: columns }, (_, index) => row[index] ?? "");
  return { header: pad(header), rows: rows.map(pad) };
}

export function tableToCsv(header: string[], rows: string[][]): string {
  const { header: head, rows: body } = normalizeTable(header, rows);
  const field = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return `\uFEFF${[head, ...body].map(row => row.map(field).join(",")).join("\r\n")}\r\n`;
}

/** Aligned monospace grid, or null when it would be wider than `maxWidth` or taller than `maxRows`. */
export function tableToGrid(header: string[], rows: string[][], maxWidth = MAX_GRID_WIDTH, maxRows = MAX_GRID_ROWS): string | null {
  if (rows.length > maxRows) return null;
  const table = normalizeTable(header.map(cleanCell), rows.map(row => row.map(cleanCell)));
  const widths = table.header.map((_, column) => Math.max(width(table.header[column] ?? ""), ...table.rows.map(row => width(row[column] ?? ""))));
  const render = (row: string[]): string =>
    row.map((cell, column) => cell + " ".repeat((widths[column] ?? 0) - width(cell))).join(" | ").trimEnd();
  const rule = widths.map(size => "-".repeat(Math.max(size, 1))).join("-+-");
  const lines = [render(table.header), rule, ...table.rows.map(render)];
  if (lines.some(line => width(line) > maxWidth)) return null;
  return lines.join("\n");
}

/** Row-per-record layout: bold first cell, then `Header: value` lines. Output is already in WhatsApp syntax. */
export function tableToRecords(header: string[], rows: string[][]): string {
  const table = normalizeTable(header.map(cleanCell), rows.map(row => row.map(cleanCell)));
  if (table.rows.length === 0) return table.header.filter(Boolean).map(title => `- ${inlineToWhatsApp(title)}`).join("\n");
  return table.rows
    .map((row, index) => {
      const first = inlineToWhatsApp((row[0] ?? "").replace(/\*\*|__/g, "")) || `Row ${index + 1}`;
      const lines = [`*${first}*`];
      row.slice(1).forEach((value, offset) => {
        if (!value) return;
        const title = table.header[offset + 1];
        lines.push(title ? `${inlineToWhatsApp(title.replace(/\*\*|__/g, ""))}: ${inlineToWhatsApp(value)}` : inlineToWhatsApp(value));
      });
      return lines.join("\n");
    })
    .join("\n\n");
}

function planTable(block: Extract<ReplyBlock, { type: "table" }>): PlannedMessage[] {
  const { header, rows } = block;
  if (header.every(cell => !cell.trim()) && rows.every(row => row.every(cell => !cell.trim()))) return [];
  const grid = tableToGrid(header, rows);
  const planned: PlannedMessage[] = grid
    ? [{ kind: "text", text: fence(grid) }]
    : splitText(tableToRecords(header, rows)).map(text => ({ kind: "text", text }) satisfies PlannedMessage);
  if (!grid || rows.length > CSV_ROW_THRESHOLD) {
    planned.push({ kind: "file", fileName: "table.csv", mimeType: "text/csv", content: tableToCsv(header, rows) });
  }
  return planned;
}

/** A draft is plain WhatsApp-formatted text in messages of its own, so long-press copy yields the draft alone. */
function planDraft(block: Extract<ReplyBlock, { type: "draft" }>): PlannedMessage[] {
  return splitText(markdownToWhatsApp(block.text)).map((text) => ({ kind: "text", text }));
}

/** Pure planning step: turns reply blocks into ordered WhatsApp messages without touching the disk. */
export function planReply(blocks: ReplyBlock[]): PlannedMessage[] {
  const planned: PlannedMessage[] = [];
  let prose: string[] = [];
  const flushProse = (): void => {
    const converted = markdownToWhatsApp(prose.join("\n\n"));
    prose = [];
    for (const text of splitText(converted)) planned.push({ kind: "text", text });
  };
  for (const block of blocks) {
    if (block.type === "markdown") {
      prose.push(block.text);
      continue;
    }
    flushProse();
    if (block.type === "code") planned.push(...planCode(block));
    else if (block.type === "table") planned.push(...planTable(block));
    else if (block.type === "draft") planned.push(...planDraft(block));
    else planned.push({ kind: "media", attachment: block.attachment });
  }
  flushProse();
  return planned;
}

/** Plans the reply and writes generated files (snippets, CSV) through the media store. */
export async function renderReply(blocks: ReplyBlock[], media: MediaStore): Promise<OutboundMessage[]> {
  const messages: OutboundMessage[] = [];
  for (const message of planReply(blocks)) {
    if (message.kind !== "file") {
      messages.push(message);
      continue;
    }
    const path = await media.allocate(message.fileName);
    await writeFile(path, message.content, { encoding: "utf8", mode: 0o600 });
    messages.push({ kind: "media", attachment: { kind: "document", path, fileName: message.fileName, mimeType: message.mimeType } });
  }
  return messages;
}
