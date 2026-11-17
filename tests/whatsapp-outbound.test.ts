import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AnyMessageContent, WASocket } from '@whiskeysockets/baileys';
import { NotSentError, type ReplyBlock } from '../src/core/contracts.js';
import { createMediaStore } from '../src/infrastructure/media.js';
import { createLinkState } from '../src/adapters/whatsapp/connection.js';
import { createOutbound } from '../src/adapters/whatsapp/outbound.js';

const PN = '14155551234@s.whatsapp.net';
const TIMING = { gapMs: 0, firstConnectWaitMs: 30, resumeConnectWaitMs: 30, pollMs: 5 };

function fakeSocket(onSend: (jid: string, content: AnyMessageContent) => Promise<void>): WASocket {
  return { sendMessage: async (jid: string, content: AnyMessageContent) => { await onSend(jid, content); return undefined; } } as unknown as WASocket;
}

async function withMedia(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'wa-outbound-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('messages go out in block order with native media payloads', async () => {
  await withMedia(async dir => {
    const photo = join(dir, 'p.png');
    await writeFile(photo, 'png');
    const sent: Array<[string, AnyMessageContent]> = [];
    const link = createLinkState();
    link.socket = fakeSocket(async (jid, content) => { sent.push([jid, content]); });
    link.open = true;
    const send = createOutbound({ link, media: createMediaStore(join(dir, 'media')), logger: () => {}, timing: TIMING });
    await send(PN, [
      { type: 'markdown', text: 'Hi **there**' },
      { type: 'attachment', attachment: { kind: 'image', path: photo, fileName: 'p.png', mimeType: 'image/png' } },
      { type: 'attachment', attachment: { kind: 'document', path: photo, fileName: 'p.pdf', mimeType: 'application/pdf' } },
      { type: 'code', language: 'js', code: 'run()' },
    ]);
    assert.deepEqual(sent.map(([jid]) => jid), [PN, PN, PN, PN]);
    assert.deepEqual(sent.map(([, content]) => content), [
      { text: 'Hi *there*' },
      { image: { url: photo }, mimetype: 'image/png', caption: undefined },
      { document: { url: photo }, mimetype: 'application/pdf', fileName: 'p.pdf', caption: undefined },
      { text: '```\nrun()\n```' },
    ]);
  });
});

test('a missing media file is replaced by a note instead of failing the reply', async () => {
  await withMedia(async dir => {
    const sent: AnyMessageContent[] = [];
    const link = createLinkState();
    link.socket = fakeSocket(async (_jid, content) => { sent.push(content); });
    link.open = true;
    const send = createOutbound({ link, media: createMediaStore(dir), logger: () => {}, timing: TIMING });
    await send(PN, [{ type: 'attachment', attachment: { kind: 'image', path: join(dir, 'gone.png'), fileName: 'gone.png', mimeType: 'image/png' } }]);
    assert.deepEqual(sent, [{ text: '(Could not send gone.png: the file is missing.)' }]);
  });
});

test('offline before the first message throws NotSentError and sends nothing', async () => {
  await withMedia(async dir => {
    const link = createLinkState();
    const send = createOutbound({ link, media: createMediaStore(dir), logger: () => {}, timing: TIMING });
    await assert.rejects(send(PN, [{ type: 'markdown', text: 'hi' }]), error => error instanceof NotSentError && /not connected/.test(error.message));
  });
});

test('the first message waits for the link to open', async () => {
  await withMedia(async dir => {
    const sent: AnyMessageContent[] = [];
    const link = createLinkState();
    const send = createOutbound({ link, media: createMediaStore(dir), logger: () => {}, timing: { ...TIMING, firstConnectWaitMs: 1000 } });
    const pending = send(PN, [{ type: 'markdown', text: 'late' }]);
    setTimeout(() => { link.socket = fakeSocket(async (_jid, content) => { sent.push(content); }); link.open = true; }, 20);
    await pending;
    assert.deepEqual(sent, [{ text: 'late' }]);
  });
});

test('losing the connection mid-reply reports how many messages were delivered, never NotSentError', async () => {
  await withMedia(async dir => {
    const link = createLinkState();
    let count = 0;
    link.socket = fakeSocket(async () => { if (++count === 2) link.open = false; });
    link.open = true;
    const send = createOutbound({ link, media: createMediaStore(dir), logger: () => {}, timing: TIMING });
    const blocks: ReplyBlock[] = [{ type: 'markdown', text: 'a' }, { type: 'code', language: null, code: 'b' }, { type: 'code', language: null, code: 'c' }];
    await assert.rejects(send(PN, blocks), error => !(error instanceof NotSentError) && error instanceof Error && /2 of 3 messages were delivered/.test(error.message));
    assert.equal(count, 2);
  });
});

test('a failing send reports the delivered count and keeps the cause', async () => {
  await withMedia(async dir => {
    const link = createLinkState();
    let count = 0;
    link.socket = fakeSocket(async () => { if (++count === 2) throw new Error('boom'); });
    link.open = true;
    const send = createOutbound({ link, media: createMediaStore(dir), logger: () => {}, timing: TIMING });
    await assert.rejects(
      send(PN, [{ type: 'markdown', text: 'a' }, { type: 'code', language: null, code: 'b' }]),
      error => !(error instanceof NotSentError) && error instanceof Error && /delivered 1 of 2 messages before failing: boom/.test(error.message),
    );
  });
});
