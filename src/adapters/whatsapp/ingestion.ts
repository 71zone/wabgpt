import { isLidUser, isPnUser, jidNormalizedUser } from "@whiskeysockets/baileys";
import type { BaileysEventMap, Chat as BaileysChat, Contact as BaileysContact, WASocket } from "@whiskeysockets/baileys";
import type { Contact, IdentityAlias } from "../../core/contracts.js";
import type { ContactRecord, Directory } from "./directory.js";
import { isOneToOneUserJid, nonEmpty } from "./protocol.js";

export interface DirectoryIngest {
  /** Canonical key for a user: phone JID whenever the mapping is known, otherwise the LID itself. */
  canonicalJid(jid: string): string;
  learnMapping(pnInput: string, lidInput: string): void;
  upsertRecord(jid: string, patch: { name?: string | undefined; notify?: string | undefined }): void;
  displayName(record: ContactRecord): string;
  toContact(record: ContactRecord): Contact;
  /** Learns phone numbers for cached LID-only records through the open socket. */
  resolveCachedAliases(socket: WASocket, stillCurrent: () => boolean): Promise<void>;
  /** Subscribes contact, chat, history and alias events; returns the detach function. */
  attach(ev: WASocket["ev"]): () => void;
}

/**
 * Turns Baileys contact/chat/history events into the persistent WhatsApp directory.
 * Message bodies never pass through here: history is only used to learn contacts and aliases.
 */
export function createDirectoryIngest(directory: Directory, hooks: { onIdentity: ((alias: IdentityAlias) => void) | undefined; changed: () => void }): DirectoryIngest {
  const { records, mappings: lidToPn } = directory;

  function canonicalJid(jid: string): string {
    const normalized = jidNormalizedUser(jid);
    return isLidUser(normalized) ? lidToPn.get(normalized) ?? normalized : normalized;
  }

  function upsertRecord(jid: string, patch: { name?: string | undefined; notify?: string | undefined }): void {
    const key = canonicalJid(jid);
    if (!isOneToOneUserJid(key)) return;
    const existing = records.get(key) ?? { jid: key };
    const name = nonEmpty(patch.name);
    const notify = nonEmpty(patch.notify);
    if (name !== undefined) existing.name = name;
    if (notify !== undefined) existing.notify = notify;
    records.set(key, existing);
  }

  function learnMapping(pnInput: string, lidInput: string): void {
    const pn = jidNormalizedUser(pnInput);
    const lid = jidNormalizedUser(lidInput);
    if (!isPnUser(pn) || !isLidUser(lid)) return;
    if (directory.link({ lid, pn })) hooks.onIdentity?.({ alias: lid, canonical: pn });
  }

  function ingestContact(contact: Partial<BaileysContact>): void {
    const { id, lid, phoneNumber } = contact;
    if (lid && phoneNumber) learnMapping(phoneNumber, lid);
    if (id && lid && isPnUser(id)) learnMapping(id, lid);
    if (id && phoneNumber && isLidUser(id)) learnMapping(phoneNumber, id);
    if (!id) return;
    upsertRecord(id, { name: contact.name, notify: contact.notify ?? contact.verifiedName });
  }

  function ingestChat(chat: Partial<BaileysChat>): void {
    if (!chat.id || !isOneToOneUserJid(chat.id)) return;
    const jid = canonicalJid(chat.id);
    const existing = directory.chats.get(jid);
    const timestamp = chat.conversationTimestamp == null ? existing?.lastMessageAt ?? null : Number(chat.conversationTimestamp.toString());
    directory.chats.set(jid, {
      jid, name: nonEmpty(chat.name) ?? existing?.name ?? jid.split("@")[0] ?? jid,
      lastMessageAt: timestamp,
      unread: chat.unreadCount ?? existing?.unread ?? 0,
      archived: chat.archived ?? existing?.archived ?? false,
    });
  }

  function displayName(record: ContactRecord): string {
    return record.name ?? record.notify ?? record.jid.split("@")[0] ?? record.jid;
  }

  return {
    canonicalJid,
    learnMapping,
    upsertRecord,
    displayName,
    toContact: record => ({ id: record.jid, name: displayName(record) }),

    async resolveCachedAliases(socket, stillCurrent): Promise<void> {
      const lids = [...records.keys()].filter(isLidUser);
      if (!lids.length) return;
      const mappings = await socket.signalRepository.lidMapping.getPNsForLIDs(lids);
      if (!stillCurrent()) return;
      for (const mapping of mappings ?? []) learnMapping(mapping.pn, mapping.lid);
      hooks.changed();
    },

    attach(ev): () => void {
      const onHistory = (history: BaileysEventMap["messaging-history.set"]): void => {
        // History is only used to learn contacts and LID mappings; messages are never forwarded.
        for (const mapping of history.lidPnMappings ?? []) learnMapping(mapping.pn, mapping.lid);
        for (const contact of history.contacts) ingestContact(contact);
        for (const chat of history.chats) ingestChat(chat);
        hooks.changed();
      };
      const onContacts = (contacts: BaileysEventMap["contacts.upsert"] | BaileysEventMap["contacts.update"]): void => {
        for (const contact of contacts) ingestContact(contact);
        hooks.changed();
      };
      const onLidMapping = (mapping: BaileysEventMap["lid-mapping.update"]): void => {
        learnMapping(mapping.pn, mapping.lid);
        hooks.changed();
      };
      const onChats = (chats: BaileysEventMap["chats.upsert"] | BaileysEventMap["chats.update"]): void => {
        for (const chat of chats) ingestChat(chat);
        hooks.changed();
      };
      const onChatsDelete = (jids: BaileysEventMap["chats.delete"]): void => {
        for (const jid of jids) directory.chats.delete(canonicalJid(jid));
        hooks.changed();
      };

      ev.on("messaging-history.set", onHistory);
      ev.on("contacts.upsert", onContacts);
      ev.on("contacts.update", onContacts);
      ev.on("chats.upsert", onChats);
      ev.on("chats.update", onChats);
      ev.on("chats.delete", onChatsDelete);
      ev.on("lid-mapping.update", onLidMapping);
      return () => {
        ev.off("messaging-history.set", onHistory);
        ev.off("contacts.upsert", onContacts);
        ev.off("contacts.update", onContacts);
        ev.off("chats.upsert", onChats);
        ev.off("chats.update", onChats);
        ev.off("chats.delete", onChatsDelete);
        ev.off("lid-mapping.update", onLidMapping);
      };
    },
  };
}
