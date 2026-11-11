import { isLidUser, isPnUser, jidNormalizedUser } from "@whiskeysockets/baileys";
import type { BaileysEventMap, WAMessage, WAMessageKey, WASocket } from "@whiskeysockets/baileys";
import type { IncomingMessage, Logger } from "../../core/contracts.js";
import type { DirectorySaver } from "./autosave.js";
import type { LinkState } from "./connection.js";
import type { Directory } from "./directory.js";
import type { DirectoryIngest } from "./ingestion.js";
import { describeError, extractText, isOneToOneUserJid, messageSeconds } from "./protocol.js";

export interface Inbound {
  /** Subscribes live message upserts; returns the detach function. */
  attach(ev: WASocket["ev"]): () => void;
  /** Resolves once every message already queued has been handled. */
  drain(): Promise<void>;
}

export interface InboundOptions {
  directory: Directory;
  ingest: DirectoryIngest;
  saver: DirectorySaver;
  link: LinkState;
  logger: Logger;
  onMessage: (message: IncomingMessage) => void;
}

/**
 * Live-only forwarding policy: only `notify` upserts that arrived after this start,
 * from direct contacts, with plain text and not authored by this account, reach `onMessage`.
 * Every direct message (including own and historical ones) still refreshes the chat directory.
 */
export function createInbound(options: InboundOptions): Inbound {
  const { directory, ingest, saver, link, logger, onMessage } = options;
  let queue: Promise<void> = Promise.resolve();

  async function resolveIncomingJid(message: WAMessage): Promise<string | null> {
    const remote = message.key.remoteJid;
    if (!remote || !isOneToOneUserJid(remote)) return null;
    const normalized = jidNormalizedUser(remote);
    if (!isLidUser(normalized)) return ingest.canonicalJid(normalized);
    const alt = message.key.remoteJidAlt;
    if (alt && isPnUser(alt)) ingest.learnMapping(alt, normalized);
    if (!directory.mappings.has(normalized) && link.socket) {
      try {
        const pn = await link.socket.signalRepository.lidMapping.getPNForLID(normalized);
        if (pn) ingest.learnMapping(pn, normalized);
      } catch (error) {
        logger(`LID lookup failed for ${normalized}: ${describeError(error)}`);
      }
    }
    return ingest.canonicalJid(normalized);
  }

  /** Read receipt for one message; the Baileys key never leaves this closure. */
  function receiptFor(key: WAMessageKey & { id: string; remoteJid: string }): () => Promise<void> {
    const receiptKey = { ...key, fromMe: false };
    return async () => {
      if (!link.socket || !link.open) throw new Error("WhatsApp is not connected");
      await link.socket.readMessages([receiptKey]);
    };
  }

  async function handleLiveMessage(message: WAMessage): Promise<void> {
    const jid = await resolveIncomingJid(message);
    if (!jid) return;
    const sentAt = messageSeconds(message);
    const existing = directory.chats.get(jid);
    if (!message.key.fromMe) ingest.upsertRecord(jid, { notify: message.pushName ?? undefined });
    directory.chats.set(jid, {
      jid, name: existing?.name ?? directory.records.get(jid)?.name ?? message.pushName ?? jid,
      lastMessageAt: sentAt ?? existing?.lastMessageAt ?? null,
      unread: existing?.unread ?? 0, archived: existing?.archived ?? false,
    });
    saver.schedule();
    const { id, remoteJid } = message.key;
    if (message.key.fromMe || !id || !remoteJid) return;
    const text = extractText(message);
    if (text === undefined || sentAt === undefined || sentAt < link.startedAtSeconds) return;
    onMessage({
      id, contact: ingest.toContact(directory.records.get(jid) ?? { jid }), text,
      acknowledge: receiptFor({ ...message.key, id, remoteJid }),
    });
  }

  function enqueue(messages: WAMessage[]): void {
    queue = queue.then(async () => {
      for (const message of messages) {
        try {
          await handleLiveMessage(message);
        } catch (error) {
          logger(`Failed to handle WhatsApp message ${message.key.id ?? "?"}: ${describeError(error)}`);
        }
      }
    });
  }

  return {
    attach(ev): () => void {
      const onUpsert = (upsert: BaileysEventMap["messages.upsert"]): void => {
        if (upsert.type === "notify") enqueue(upsert.messages);
      };
      ev.on("messages.upsert", onUpsert);
      return () => { ev.off("messages.upsert", onUpsert); };
    },
    async drain(): Promise<void> {
      await queue.catch(() => undefined);
    },
  };
}
