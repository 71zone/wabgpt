import type { ReplyBlock } from '../../core/contracts.js';

/** Letters and digits only, so Markdown syntax, link targets, whitespace and bullet characters never decide a comparison. */
const SIGNIFICANT = /[\p{L}\p{N}]/gu;

function textOf(block: ReplyBlock): string {
  switch (block.type) {
    case 'markdown': return block.text;
    case 'draft': return `${block.title ?? ''} ${block.text}`;
    case 'code': return block.code;
    case 'table': return [block.header, ...block.rows].flat().join(' ');
    case 'attachment': return '';
  }
}

/**
 * True when the structured blocks carry clearly less text than the reply's plain text, which means the page script skipped something it did not
 * understand (a widget, a card). The plain text is then the more faithful copy. Generated files are outside the prose and never count.
 */
export function lostContent(blocks: ReplyBlock[], plain: string, threshold = 0.7): boolean {
  const expected = plain.match(SIGNIFICANT)?.length ?? 0;
  const kept = blocks.map(textOf).join(' ').match(SIGNIFICANT)?.length ?? 0;
  return expected > 0 && kept < expected * threshold;
}
