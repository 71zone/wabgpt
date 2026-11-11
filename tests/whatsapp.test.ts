import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import type { IdentityAlias, IncomingMessage } from '../src/core/contracts.js';
import { createWhatsApp } from '../src/adapters/whatsapp/whatsapp.js';
import { createDirectorySaver } from '../src/adapters/whatsapp/autosave.js';
import { createLinkState } from '../src/adapters/whatsapp/connection.js';
import { Directory } from '../src/adapters/whatsapp/directory.js';
import { createInbound } from '../src/adapters/whatsapp/inbound.js';
import { createDirectoryIngest } from '../src/adapters/whatsapp/ingestion.js';

const PN = '14155551234@s.whatsapp.net';
const LID = '123456789@lid';

async function withAuthDir(prefix: string, run: (authDir: string) => Promise<void>): Promise<void> {
  const authDir = await mkdtemp(join(tmpdir(), prefix));
  try { await run(authDir); } finally { await rm(authDir, { recursive: true, force: true }); }
}

function idleOptions(authDir: string) {
  return { authDir, logger: () => {}, onMessage: () => {}, onStatus: () => {} };
}

test('a restarted adapter lists saved contacts before connecting or receiving another history sync', async () => {
  await withAuthDir('wa-contacts-', async authDir => {
    await writeFile(join(authDir, 'contacts.json'), JSON.stringify({
      version: 1,
      contacts: [{ jid: PN, name: 'Saved contact' }],
      mappings: [{ lid: LID, pn: PN }],
      chats: [{ jid: PN, name: '14155551234', lastMessageAt: 1700000000, unread: 2, archived: false }],
    }));
    const first = createWhatsApp(idleOptions(authDir));
    assert.deepEqual(first.contacts(), [{ id: PN, name: 'Saved contact' }]);
    await first.stop();
    const restarted = createWhatsApp(idleOptions(authDir));
    assert.deepEqual(restarted.contacts(), [{ id: PN, name: 'Saved contact' }]);
    assert.deepEqual(restarted.chats(), [{ id: PN, name: 'Saved contact', lastMessageAt: 1700000000, unread: 2, archived: false }]);
    assert.deepEqual(restarted.identities(), [{ alias: LID, canonical: PN }]);
    await restarted.stop();
  });
});

test('verified LID aliases collapse on restart without combining contacts that only share a name', async () => {
  await withAuthDir('wa-identities-', async authDir => {
    await writeFile(join(authDir, 'contacts.json'), JSON.stringify({
      version: 1,
      contacts: [
        { jid: LID, name: 'Same name' },
        { jid: PN, name: 'Same name' },
        { jid: '14155559876@s.whatsapp.net', name: 'Same name' },
      ],
      mappings: [{ lid: LID, pn: PN }],
      chats: [],
    }));
    const adapter = createWhatsApp(idleOptions(authDir));
    assert.deepEqual(adapter.contacts(), [
      { id: PN, name: 'Same name' },
      { id: '14155559876@s.whatsapp.net', name: 'Same name' },
    ]);
    await adapter.stop();
  });
});

test('hasSavedSession reflects the stored credentials only', async () => {
  await withAuthDir('wa-session-', async authDir => {
    const adapter = createWhatsApp(idleOptions(authDir));
    assert.equal(adapter.hasSavedSession(), false);
    await writeFile(join(authDir, 'contacts.json'), JSON.stringify({ version: 1, contacts: [], mappings: [], chats: [] }));
    assert.equal(adapter.hasSavedSession(), false);
    await writeFile(join(authDir, 'creds.json'), '{}');
    assert.equal(adapter.hasSavedSession(), true);
    await adapter.stop();
  });
});

test('resolveContact accepts international numbers and direct JIDs, preferring saved names and verified aliases', async () => {
  await withAuthDir('wa-resolve-', async authDir => {
    await writeFile(join(authDir, 'contacts.json'), JSON.stringify({
      version: 1,
      contacts: [{ jid: PN, name: 'Saved contact' }],
      mappings: [{ lid: LID, pn: PN }],
      chats: [{ jid: '14155559876@s.whatsapp.net', name: 'Chat only', lastMessageAt: null, unread: 0, archived: false }],
    }));
    const adapter = createWhatsApp(idleOptions(authDir));
    assert.deepEqual(adapter.resolveContact('+1 (415) 555-1234'), { id: PN, name: 'Saved contact' });
    assert.deepEqual(adapter.resolveContact(PN), { id: PN, name: 'Saved contact' });
    assert.deepEqual(adapter.resolveContact(LID), { id: PN, name: 'Saved contact' });
    assert.deepEqual(adapter.resolveContact('14155559876'), { id: '14155559876@s.whatsapp.net', name: 'Chat only' });
    assert.deepEqual(adapter.resolveContact('44 20 7946 0958'), { id: '442079460958@s.whatsapp.net', name: '+442079460958' });
    assert.deepEqual(adapter.resolveContact('987654321@lid'), { id: '987654321@lid', name: '+987654321' });
    for (const bad of ['', '12345', 'not a number', '120363000000000000@g.us', 'status@broadcast', '0123456789']) {
      assert.throws(() => adapter.resolveContact(bad), /international number with country code/, bad);
    }
    await adapter.stop();
  });
});

test('sending requires an open connection', async () => {
  await withAuthDir('wa-send-', async authDir => {
    const adapter = createWhatsApp(idleOptions(authDir));
    await assert.rejects(adapter.sendText(PN, 'hello'), /WhatsApp is not connected/);
    await adapter.stop();
  });
});

test('live inbound policy forwards only fresh direct notify text and keeps receipts private to acknowledge', async () => {
  await withAuthDir('wa-inbound-', async authDir => {
    const directory = new Directory(authDir);
    const saver = createDirectorySaver(directory, () => {}, undefined);
    const aliases: IdentityAlias[] = [];
    const ingest = createDirectoryIngest(directory, { onIdentity: alias => aliases.push(alias), changed: saver.schedule });
    const link = createLinkState();
    const receipts: unknown[] = [];
    link.socket = {
      readMessages: async (keys: unknown[]) => { receipts.push(...keys); },
      signalRepository: { lidMapping: { getPNForLID: async () => null } },
    } as unknown as WASocket;
    link.open = true;
    link.startedAtSeconds = 1_700_000_000;
    const received: IncomingMessage[] = [];
    const inbound = createInbound({ directory, ingest, saver, link, logger: () => {}, onMessage: message => received.push(message) });
    const ev = new EventEmitter();
    const detach = inbound.attach(ev as unknown as WASocket['ev']);

    const text = (id: string, remoteJid: string, extra: Partial<WAMessage> & { fromMe?: boolean; remoteJidAlt?: string } = {}): WAMessage => {
      const { fromMe = false, remoteJidAlt, ...rest } = extra;
      return { key: { id, remoteJid, fromMe, ...(remoteJidAlt ? { remoteJidAlt } : {}) }, message: { conversation: `body ${id}` }, messageTimestamp: 1_700_000_100, pushName: 'Push', ...rest } as WAMessage;
    };

    ev.emit('messages.upsert', { type: 'append', messages: [text('appended', PN)] });
    ev.emit('messages.upsert', { type: 'notify', messages: [
      text('group', '120363000000000000@g.us'),
      text('broadcast', 'status@broadcast'),
      text('own', PN, { fromMe: true }),
      text('old', PN, { messageTimestamp: 1_699_999_000 }),
      text('empty', PN, { message: { conversation: '   ' } }),
      text('fresh', LID, { remoteJidAlt: PN }),
    ] });
    await inbound.drain();

    assert.deepEqual(received.map(message => [message.id, message.contact, message.text]), [['fresh', { id: PN, name: 'Push' }, 'body fresh']]);
    assert.deepEqual(aliases, [{ alias: LID, canonical: PN }]);
    assert.equal('receiptKey' in (received[0] ?? {}), false);
    // Own and historical messages still refresh the chat directory without being forwarded.
    assert.equal(directory.chats.get(PN)?.lastMessageAt, 1_700_000_100);

    await received[0]?.acknowledge();
    assert.deepEqual(receipts, [{ id: 'fresh', remoteJid: LID, remoteJidAlt: PN, fromMe: false }]);
    link.open = false;
    await assert.rejects(received[0]?.acknowledge() ?? Promise.resolve(), /WhatsApp is not connected/);

    detach();
    ev.emit('messages.upsert', { type: 'notify', messages: [text('detached', PN)] });
    await inbound.drain();
    assert.equal(received.length, 1);
    await saver.flush();
  });
});
