import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Contact, IdentityAlias, IncomingMessage, Logger, MessagingAdapter, RecentChat } from "../../core/contracts.js";
import type { MediaStore } from "../../infrastructure/media.js";
import { createDirectorySaver } from "./autosave.js";
import { createConnection, createLinkState } from "./connection.js";
import { Directory } from "./directory.js";
import { createInbound } from "./inbound.js";
import { createDirectoryIngest } from "./ingestion.js";
import { createOutbound, type OutboundTiming } from "./outbound.js";

export interface WhatsAppOptions {
  authDir: string;
  logger: Logger;
  onMessage: (message: IncomingMessage) => void;
  onStatus: (status: string) => void;
  onUpdate?: () => void;
  /** Raw Baileys QR payload to render in the UI; an empty string clears it. */
  onQr?: (qr: string) => void;
  onIdentity?: (alias: IdentityAlias) => void;
  /** Forward messages sent at or after this Unix second, so ones queued during a restart are not mistaken for history. */
  notBeforeSeconds?: number;
  /** Scratch store for downloaded photos and generated files (snippets, CSV tables). */
  media: MediaStore;
  /** Overrides pacing and connection waits for replies; tests use it to avoid real delays. */
  outboundTiming?: Partial<OutboundTiming>;
}

const DIRECT_NUMBER = /^[1-9]\d{6,14}@s\.whatsapp\.net$/;
const DIRECT_LID = /^\d+@lid$/;

export function createWhatsApp(options: WhatsAppOptions): MessagingAdapter {
  const { authDir, logger, onMessage, onStatus } = options;
  const directory = new Directory(authDir);
  const saver = createDirectorySaver(directory, logger, options.onUpdate);
  const ingest = createDirectoryIngest(directory, { onIdentity: options.onIdentity, changed: saver.schedule });
  const link = createLinkState();
  const inbound = createInbound({ directory, ingest, saver, link, logger, onMessage, media: options.media });
  const sendReply = createOutbound({ link, media: options.media, logger, timing: options.outboundTiming });
  const connection = createConnection({
    authDir, logger, link, directory, ingest, saver, onStatus, onQr: options.onQr, notBeforeSeconds: options.notBeforeSeconds,
    attachListeners: ev => {
      const detachDirectory = ingest.attach(ev);
      const detachInbound = inbound.attach(ev);
      return () => { detachDirectory(); detachInbound(); };
    },
    drainInbound: inbound.drain,
  });

  function chatName(jid: string, stored: string): string {
    const record = directory.records.get(jid);
    return record ? ingest.displayName(record) : stored;
  }

  return {
    start: connection.start,
    stop: connection.stop,

    contacts(): Contact[] {
      return [...directory.records.values()]
        .map(ingest.toContact)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
    },

    identities(): IdentityAlias[] {
      return [...directory.mappings].map(([alias, canonical]) => ({ alias, canonical }));
    },

    chats(): RecentChat[] {
      return [...directory.chats.values()]
        .map(chat => ({ id: chat.jid, name: chatName(chat.jid, chat.name), lastMessageAt: chat.lastMessageAt, unread: chat.unread, archived: chat.archived }))
        .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
    },

    hasSavedSession(): boolean {
      return existsSync(join(authDir, "creds.json"));
    },

    resolveContact(input: string): Contact {
      const digits = input.replace(/[\s()+.-]/g, "");
      const jid = /^[1-9]\d{6,14}$/.test(digits) ? `${digits}@s.whatsapp.net` : input.trim();
      if (!DIRECT_NUMBER.test(jid) && !DIRECT_LID.test(jid)) {
        throw new Error("Enter a full international number with country code, or a direct-contact JID.");
      }
      const canonical = ingest.canonicalJid(jid);
      const record = directory.records.get(canonical);
      if (record) return ingest.toContact(record);
      const chat = directory.chats.get(canonical);
      return { id: canonical, name: chat?.name ?? `+${canonical.split("@")[0]}` };
    },

    sendReply,
  };
}
