import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import type { IncomingMessage } from '../src/core/contracts.js';
import { createDirectorySaver } from '../src/adapters/whatsapp/autosave.js';
import { createLinkState } from '../src/adapters/whatsapp/connection.js';
import { Directory } from '../src/adapters/whatsapp/directory.js';
import { createInbound } from '../src/adapters/whatsapp/inbound.js';
import { createDirectoryIngest } from '../src/adapters/whatsapp/ingestion.js';
import { createMediaStore, MAX_MEDIA_BYTES } from '../src/infrastructure/media.js';

const PN = '14155551234@s.whatsapp.net';
const STARTED = 1_700_000_000;
const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

interface Harness {
  received: IncomingMessage[];
  logs: string[];
  downloads: string[];
  mediaDir: string;
  emit(...messages: WAMessage[]): Promise<void>;
}

async function withInbound(download: (message: WAMessage) => Promise<Buffer>, run: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'wa-inbound-media-'));
  try {
    const directory = new Directory(root);
    const saver = createDirectorySaver(directory, () => {}, undefined);
    const ingest = createDirectoryIngest(directory, { onIdentity: () => {}, changed: saver.schedule });
    const link = createLinkState();
    link.socket = { readMessages: async () => {} } as unknown as WASocket;
    link.open = true;
    link.startedAtSeconds = STARTED;
    const received: IncomingMessage[] = [];
    const logs: string[] = [];
    const downloads: string[] = [];
    const mediaDir = join(root, 'media');
    const inbound = createInbound({
      directory, ingest, saver, link, logger: line => logs.push(line), media: createMediaStore(mediaDir),
      onMessage: message => received.push(message),
      download: async message => { downloads.push(message.key.id ?? ''); return download(message); },
    });
    const ev = new EventEmitter();
    inbound.attach(ev as unknown as WASocket['ev']);
    await run({
      received, logs, downloads, mediaDir,
      async emit(...messages) {
        ev.emit('messages.upsert', { type: 'notify', messages });
        await inbound.drain();
      },
    });
    await saver.flush();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function message(id: string, content: WAMessage['message'], extra: { fromMe?: boolean; messageTimestamp?: number } = {}): WAMessage {
  return { key: { id, remoteJid: PN, fromMe: extra.fromMe ?? false }, message: content, messageTimestamp: extra.messageTimestamp ?? STARTED + 100, pushName: 'Push' } as WAMessage;
}

test('a captioned photo is downloaded into the media store and forwarded with its caption as text', async () => {
  await withInbound(async () => PHOTO, async h => {
    await h.emit(message('IMG1', { imageMessage: { caption: 'what is this?', mimetype: 'image/jpeg', fileLength: 7 } }));
    assert.equal(h.received.length, 1);
    const [received] = h.received;
    assert.equal(received?.text, 'what is this?');
    assert.equal(received?.attachments.length, 1);
    const [attachment] = received?.attachments ?? [];
    assert.equal(attachment?.kind, 'image');
    assert.equal(attachment?.mimeType, 'image/jpeg');
    assert.equal(attachment?.fileName, 'IMG1.jpg');
    assert.ok(attachment && !relative(h.mediaDir, attachment.path).startsWith('..'));
    assert.ok(attachment?.path.endsWith('IMG1.jpg'));
    assert.deepEqual(await readFile(attachment?.path ?? ''), PHOTO);
    assert.deepEqual(h.logs, []);
  });
});

test('a photo without caption is forwarded with empty text, and the mime type picks the extension', async () => {
  await withInbound(async () => PHOTO, async h => {
    await h.emit(message('IMG2', { imageMessage: { mimetype: 'image/png' } }), message('IMG3', { imageMessage: { mimetype: 'image/webp' } }));
    assert.deepEqual(h.received.map(m => [m.id, m.text, m.attachments[0]?.fileName, m.attachments[0]?.mimeType]), [
      ['IMG2', '', 'IMG2.png', 'image/png'],
      ['IMG3', '', 'IMG3.webp', 'image/webp'],
    ]);
  });
});

test('a view-once photo and an image sent as a document are unwrapped and forwarded', async () => {
  await withInbound(async () => PHOTO, async h => {
    await h.emit(
      message('ONCE', { viewOnceMessage: { message: { imageMessage: { caption: 'secret', mimetype: 'image/jpeg' } } } }),
      message('DOC', { documentMessage: { caption: 'as file', mimetype: 'image/heic', fileName: 'x.heic' } }),
      message('PDF', { documentMessage: { mimetype: 'application/pdf', fileName: 'x.pdf' } }),
    );
    assert.deepEqual(h.received.map(m => [m.id, m.text, m.attachments[0]?.fileName, m.attachments[0]?.mimeType]), [
      ['ONCE', 'secret', 'ONCE.jpg', 'image/jpeg'],
      ['DOC', 'as file', 'DOC.heic', 'image/heic'],
    ]);
    assert.deepEqual(h.downloads, ['ONCE', 'DOC']);
  });
});

test('an image whose declared size exceeds the media limit is skipped with a log line and never downloaded', async () => {
  await withInbound(async () => PHOTO, async h => {
    await h.emit(message('BIG', { imageMessage: { caption: 'huge', mimetype: 'image/jpeg', fileLength: MAX_MEDIA_BYTES + 1 } }));
    assert.deepEqual(h.received, []);
    assert.deepEqual(h.downloads, []);
    assert.equal(h.logs.length, 1);
    assert.match(h.logs[0] ?? '', /Skipped a photo from Push/);
  });
});

test('a failed download is logged and the photo is not forwarded, even with a caption', async () => {
  await withInbound(async () => { throw new Error('media expired'); }, async h => {
    await h.emit(message('GONE', { imageMessage: { caption: 'please read', mimetype: 'image/jpeg' } }));
    assert.deepEqual(h.received, []);
    assert.deepEqual(h.logs, ['Could not download the photo from Push: media expired']);
  });
});

test('text stays text-only, other media stays ignored, and own or historical photos are not downloaded', async () => {
  await withInbound(async () => PHOTO, async h => {
    await h.emit(
      message('TXT', { conversation: 'hello' }),
      message('VID', { videoMessage: { mimetype: 'video/mp4' } }),
      message('AUD', { audioMessage: { mimetype: 'audio/ogg', ptt: true } }),
      message('STK', { stickerMessage: { mimetype: 'image/webp' } }),
      message('OWN', { imageMessage: { mimetype: 'image/jpeg' } }, { fromMe: true }),
      message('OLD', { imageMessage: { mimetype: 'image/jpeg' } }, { messageTimestamp: STARTED - 1000 }),
    );
    assert.deepEqual(h.received.map(m => [m.id, m.text, m.attachments]), [['TXT', 'hello', []]]);
    assert.deepEqual(h.downloads, []);
    assert.deepEqual(h.logs, []);
  });
});
