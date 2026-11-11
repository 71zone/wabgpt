import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Directory } from '../src/adapters/whatsapp/directory.js';

test('ordered saves retain contact renames, LID mappings and the latest chat metadata', async () => {
  const authDir = await mkdtemp(join(tmpdir(), 'wa-directory-'));
  try {
    const directory = new Directory(authDir);
    const jid = '14155551234@s.whatsapp.net';
    directory.records.set(jid, { jid, name: 'First name' });
    directory.mappings.set('123456789@lid', jid);
    directory.chats.set(jid, { jid, name: 'First name', lastMessageAt: 1700000000, unread: 2, archived: false });
    const earlier = directory.save();
    directory.records.set(jid, { jid, name: 'Renamed contact' });
    directory.chats.set(jid, { jid, name: 'Renamed contact', lastMessageAt: 1700000020, unread: 0, archived: true });
    await Promise.all([earlier, directory.save()]);
    const restored = new Directory(authDir);
    assert.equal(restored.records.get(jid)?.name, 'Renamed contact');
    assert.equal(restored.mappings.get('123456789@lid'), jid);
    assert.deepEqual(restored.chats.get(jid), { jid, name: 'Renamed contact', lastMessageAt: 1700000020, unread: 0, archived: true });
  } finally { await rm(authDir, { recursive: true, force: true }); }
});

test('verified contact aliases retain the saved name and newest chat metadata', async () => {
  const authDir = await mkdtemp(join(tmpdir(), 'wa-directory-alias-'));
  try {
    const directory = new Directory(authDir);
    const pn = '14155551234@s.whatsapp.net';
    const lid = '123456789@lid';
    directory.records.set(lid, { jid: lid, name: 'Push name' });
    directory.records.set(pn, { jid: pn, name: 'Saved name' });
    directory.chats.set(lid, { jid: lid, name: 'Push name', lastMessageAt: 1700000020, unread: 3, archived: false });
    directory.chats.set(pn, { jid: pn, name: 'Saved name', lastMessageAt: 1700000000, unread: 1, archived: false });
    directory.link({ lid, pn }); await directory.save();
    const restored = new Directory(authDir);
    assert.deepEqual([...restored.records.values()], [{ jid: pn, name: 'Saved name' }]);
    assert.deepEqual([...restored.chats.values()], [{ jid: pn, name: 'Push name', lastMessageAt: 1700000020, unread: 3, archived: false }]);
  } finally { await rm(authDir, { recursive: true, force: true }); }
});

test('clear forgets every in-memory record without writing', async () => {
  const authDir = await mkdtemp(join(tmpdir(), 'wa-directory-clear-'));
  try {
    const directory = new Directory(authDir);
    const jid = '14155551234@s.whatsapp.net';
    directory.records.set(jid, { jid, name: 'Saved name' });
    directory.mappings.set('123456789@lid', jid);
    directory.chats.set(jid, { jid, name: 'Saved name', lastMessageAt: null, unread: 0, archived: false });
    directory.clear();
    assert.equal(directory.records.size + directory.mappings.size + directory.chats.size, 0);
  } finally { await rm(authDir, { recursive: true, force: true }); }
});
