import { open, rm } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import type { Attachment, AttachmentKind, Logger, ReplyBlock } from '../../core/contracts.js';
import { MAX_MEDIA_BYTES, type MediaStore } from '../../infrastructure/media.js';
import type { Extraction } from './extract.js';

/** Most images and files delivered for one reply; further ones are logged, reported in the reply and skipped. */
export const MAX_REPLY_ASSETS = 6;
/** Raw bytes moved per BrowserOS call. Base64 inflates it by a third, which must stay under the 500000-character result cap of runScript. */
const CHUNK_BYTES = 256 * 1024;

/**
 * Page script that stages one stamped asset (see chatgptExtractionScript) as a Blob in `window.__wabAssets`. An image is fetched from its own
 * URL (blob:, data: or chatgpt.com, with the page's cookies). A file is produced by pressing ChatGPT's own "Download file" button while
 * HTMLAnchorElement.click is intercepted: ChatGPT authenticates the download itself and then clicks a hidden `<a download href="blob:...">`; the
 * interception reads that blob and swallows the click, so nothing is saved to the user's Downloads folder. page.download() is not used: it never
 * returns for these blob downloads (the browser saves the file but the call hangs), and its path would not be readable when the browser runs
 * in another container.
 */
const stageAssetScript = String.raw`async (id) => {
  try {
    const el = document.querySelector('[data-wab-asset="' + id + '"]');
    if (!el) return { error: 'The asset is no longer on the page.' };
    let blob;
    let name = null;
    if (el.tagName === 'IMG') {
      const response = await fetch(el.currentSrc || el.src, { credentials: 'include' });
      if (!response.ok) return { error: 'HTTP ' + response.status };
      blob = await response.blob();
    } else {
      const { promise, resolve, reject } = Promise.withResolvers();
      const proto = HTMLAnchorElement.prototype;
      const original = proto.click;
      const timer = setTimeout(() => { proto.click = original; reject(new Error('The download did not start.')); }, 15000);
      proto.click = function () {
        if (!this.hasAttribute('download') || !this.href) return original.apply(this, arguments);
        clearTimeout(timer);
        proto.click = original;
        resolve({ response: fetch(this.href), name: this.getAttribute('download') });
      };
      el.click();
      const captured = await promise;
      const response = await captured.response;
      if (!response.ok) return { error: 'HTTP ' + response.status };
      blob = await response.blob();
      name = captured.name;
    }
    (window.__wabAssets = window.__wabAssets || {})[id] = blob;
    return { size: blob.size, mime: blob.type, name };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
}`;

/** Page script returning one base64 slice of a staged asset. */
const readChunkScript = String.raw`async ({ id, offset, length }) => {
  try {
    const blob = window.__wabAssets && window.__wabAssets[id];
    if (!blob) return { error: 'The staged asset is gone.' };
    const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    return { data: btoa(binary) };
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
}`;

const releaseScript = String.raw`(id) => { if (window.__wabAssets) delete window.__wabAssets[id]; return true; }`;

const failure = z.object({ error: z.string() });
const staged = z.union([failure, z.object({ size: z.number(), mime: z.string(), name: z.string().nullable() })]);
const chunk = z.union([failure, z.object({ data: z.string() })]);

const mimeByExtension: Record<string, string> = {
  csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', md: 'text/markdown', json: 'application/json', html: 'text/html', xml: 'application/xml',
  pdf: 'application/pdf', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime',
};
const extensionByMime: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function mimeOf(fileName: string, reported: string): string {
  const declared = (reported.split(';')[0] ?? '').trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;
  return mimeByExtension[extname(fileName).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

function kindOf(mimeType: string): AttachmentKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

export interface AssetContext {
  /** Runs one BrowserOS script on the shared session and returns its value. */
  run: (code: string) => Promise<unknown>;
  pageId: number;
  media: MediaStore;
  logger: Logger;
}

const inPage = (context: AssetContext, script: string, argument: unknown): string => `const result=await browser.page(${context.pageId}).evaluateInPage(${script},${JSON.stringify(argument)}); return result.value;`;

async function fetchAsset(asset: Extraction['assets'][number], context: AssetContext): Promise<Attachment> {
  const result = staged.parse(await context.run(inPage(context, stageAssetScript, asset.id)));
  if ('error' in result) throw new Error(result.error);
  if (result.size === 0) throw new Error('the file is empty');
  if (result.size > MAX_MEDIA_BYTES) throw new Error(`the file is ${result.size} bytes, over the ${MAX_MEDIA_BYTES} byte limit`);
  const named = result.name ?? asset.name;
  const reported = result.mime;
  const fileName = extname(named) || !extensionByMime[reported] ? named : `${named}.${extensionByMime[reported]}`;
  const mimeType = mimeOf(fileName, reported);
  const path = await context.media.allocate(fileName);
  const handle = await open(path, 'w');
  let written = 0;
  try {
    for (let offset = 0; offset < result.size; offset += CHUNK_BYTES) {
      const piece = chunk.parse(await context.run(inPage(context, readChunkScript, { id: asset.id, offset, length: CHUNK_BYTES })));
      if ('error' in piece) throw new Error(piece.error);
      const bytes = Buffer.from(piece.data, 'base64');
      if (bytes.length === 0) throw new Error('ChatGPT returned an empty slice of the file');
      await handle.write(bytes);
      written += bytes.length;
    }
    if (written !== result.size) throw new Error(`received ${written} of ${result.size} bytes`);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  return { kind: kindOf(mimeType), path, fileName: basename(path), mimeType };
}

/**
 * Turns an extraction into deliverable blocks: every `asset` placeholder is fetched into the media store and becomes an `attachment` block at its place.
 * An asset that cannot be fetched (or is over the size or count limits) stays visible as a `(could not retrieve <name>)` note and the rest is kept.
 */
export async function resolveBlocks(extracted: Extraction, context: AssetContext): Promise<ReplyBlock[]> {
  const assets = new Map(extracted.assets.map(asset => [asset.id, asset]));
  const blocks: ReplyBlock[] = [];
  let attempted = 0;
  for (const block of extracted.blocks) {
    if (block.type !== 'asset') { blocks.push(block); continue; }
    const asset = assets.get(block.id);
    if (!asset) continue;
    if (attempted >= MAX_REPLY_ASSETS) {
      context.logger(`Skipped ${asset.name}: ChatGPT returned more than ${MAX_REPLY_ASSETS} images or files in one reply.`);
      blocks.push({ type: 'markdown', text: `(skipped ${asset.name}: more than ${MAX_REPLY_ASSETS} files in one reply)` });
      continue;
    }
    attempted++;
    try {
      blocks.push({ type: 'attachment', attachment: await fetchAsset(asset, context) });
    } catch (error) {
      context.logger(`Could not retrieve ${asset.name} from ChatGPT: ${error instanceof Error ? error.message : String(error)}`);
      blocks.push({ type: 'markdown', text: `(could not retrieve ${asset.name})` });
    } finally {
      await context.run(inPage(context, releaseScript, asset.id)).catch(() => undefined);
    }
  }
  return blocks;
}
