import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveBlocks, type AssetContext } from '../src/adapters/chatgpt/assets.js';
import type { Extraction } from '../src/adapters/chatgpt/extract.js';
import { MAX_MEDIA_BYTES, createMediaStore } from '../src/infrastructure/media.js';

type Source = { mime: string; name: string | null; bytes: Buffer; reportedSize?: number; failChunkAt?: number; shortChunk?: boolean } | { error: string };

const argument = z.object({ id: z.number(), offset: z.number(), length: z.number() });
const tail = /,(\d+|\{"id":\d+,"offset":\d+,"length":\d+\})\); return result\.value;$/;

/** A BrowserOS session whose page serves `sources` through the same staging, chunk and release scripts the adapter sends. */
function fakePage(sources: Map<number, Source>): { context: AssetContext; calls: string[]; released: number[]; allocated: string[]; directory: string } {
  const directory = join(tmpdir(), `wabgpt-assets-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const store = createMediaStore(directory);
  const allocated: string[] = [];
  const calls: string[] = [];
  const released: number[] = [];
  const run = async (code: string): Promise<unknown> => {
    const raw: unknown = JSON.parse(tail.exec(code)?.[1] ?? 'null');
    if (code.includes('data-wab-asset')) {
      calls.push('stage');
      const source = sources.get(z.number().parse(raw));
      if (!source) return { error: 'The asset is no longer on the page.' };
      return 'error' in source ? source : { size: source.reportedSize ?? source.bytes.length, mime: source.mime, name: source.name };
    }
    if (code.includes('arrayBuffer')) {
      calls.push('chunk');
      const { id, offset, length } = argument.parse(raw);
      const source = sources.get(id);
      if (!source || 'error' in source) return { error: 'The staged asset is gone.' };
      if (source.failChunkAt === offset) return { error: 'page navigated away' };
      const end = source.shortChunk ? offset + Math.floor(source.bytes.length / 2) : offset + length;
      return { data: source.bytes.subarray(offset, end).toString('base64') };
    }
    calls.push('release'); released.push(z.number().parse(raw));
    return true;
  };
  const context: AssetContext = { run, pageId: 7, logger: message => { calls.push(`log:${message}`); }, media: { directory, allocate: async name => { const path = await store.allocate(name); allocated.push(path); return path; } } };
  return { context, calls, released, allocated, directory };
}

const extractionOf = (assets: Extraction['assets']): Extraction => ({ url: 'https://chatgpt.com/c/x', text: '', blocks: assets.map(asset => ({ type: 'asset', id: asset.id })), assets });

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

test('a file larger than one transfer slice arrives intact through several slices and its bytes are verified', async () => {
  const bytes = randomBytes(256 * 1024 * 2 + 1234);
  const page = fakePage(new Map([[1, { mime: 'application/octet-stream', name: 'report.xlsx', bytes }]]));
  try {
    const blocks = await resolveBlocks(extractionOf([{ id: 1, kind: 'file', name: 'file' }]), page.context);
    assert.equal(blocks.length, 1);
    const [block] = blocks;
    assert.equal(block?.type, 'attachment');
    if (block?.type !== 'attachment') return;
    assert.deepEqual(await readFile(block.attachment.path), bytes);
    assert.deepEqual({ kind: block.attachment.kind, fileName: block.attachment.fileName, mimeType: block.attachment.mimeType }, { kind: 'document', fileName: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    assert.equal(page.calls.filter(call => call === 'chunk').length, 3);
    assert.deepEqual(page.released, [1]);
  } finally { await rm(page.context.media.directory, { recursive: true, force: true }); }
});

test('an image without a file name gets one from its alt text and mime type', async () => {
  const page = fakePage(new Map([[1, { mime: 'image/webp', name: null, bytes: Buffer.from('webp') }]]));
  try {
    const [block] = await resolveBlocks(extractionOf([{ id: 1, kind: 'image', name: 'Generated image 2' }]), page.context);
    assert.equal(block?.type, 'attachment');
    if (block?.type !== 'attachment') return;
    assert.deepEqual({ kind: block.attachment.kind, fileName: block.attachment.fileName, mimeType: block.attachment.mimeType }, { kind: 'image', fileName: 'Generated image 2.webp', mimeType: 'image/webp' });
  } finally { await rm(page.context.media.directory, { recursive: true, force: true }); }
});

for (const [name, source, reason] of [
  ['is over the size limit', { mime: 'application/zip', name: 'huge.zip', bytes: Buffer.from('x'), reportedSize: MAX_MEDIA_BYTES + 1 }, /over the \d+ byte limit/],
  ['is empty', { mime: 'text/plain', name: 'empty.txt', bytes: Buffer.alloc(0) }, /empty/],
  ['cannot be staged by the page', { error: 'HTTP 403' }, /HTTP 403/],
  ['loses the page halfway', { mime: 'text/plain', name: 'half.txt', bytes: randomBytes(256 * 1024 + 10), failChunkAt: 256 * 1024 }, /page navigated away/],
  ['arrives truncated', { mime: 'text/plain', name: 'short.txt', bytes: Buffer.from('0123456789'), shortChunk: true }, /received 5 of 10 bytes/],
] as const satisfies readonly (readonly [string, Source, RegExp])[]) {
  test(`an asset that ${name} stays visible as a note, leaves nothing behind and does not stop the other assets`, async () => {
    const good = { mime: 'text/plain', name: 'good.txt', bytes: Buffer.from('good') };
    const page = fakePage(new Map<number, Source>([[1, source], [2, good]]));
    try {
      const blocks = await resolveBlocks(extractionOf([{ id: 1, kind: 'file', name: 'wanted.bin' }, { id: 2, kind: 'file', name: 'good.txt' }]), page.context);
      assert.deepEqual(blocks[0], { type: 'markdown', text: '(could not retrieve wanted.bin)' });
      assert.equal(blocks[1]?.type, 'attachment');
      assert.equal(blocks.length, 2);
      assert.ok(page.calls.some(call => call.startsWith('log:Could not retrieve wanted.bin') && reason.test(call)), page.calls.join('\n'));
      assert.deepEqual(page.released, [1, 2]);
      for (const path of page.allocated.slice(0, page.allocated.length - 1)) assert.equal(await exists(path), false, 'a failed transfer leaves no partial file');
    } finally { await rm(page.context.media.directory, { recursive: true, force: true }); }
  });
}

test('placeholders for assets the page no longer lists are dropped', async () => {
  const page = fakePage(new Map());
  try {
    assert.deepEqual(await resolveBlocks({ url: 'https://chatgpt.com/c/x', text: '', blocks: [{ type: 'markdown', text: 'kept' }, { type: 'asset', id: 9 }], assets: [] }, page.context), [{ type: 'markdown', text: 'kept' }]);
  } finally { await rm(page.context.media.directory, { recursive: true, force: true }); }
});
