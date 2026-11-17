import { downloadMediaMessage, isLidUser, isPnUser, jidNormalizedUser } from "@whiskeysockets/baileys";
import type { BaileysEventMap, WAMessage, WAMessageKey, WASocket } from "@whiskeysockets/baileys";
import { writeFile } from "node:fs/promises";
import { pino } from "pino";
import type { Attachment, IncomingMessage, Logger } from "../../core/contracts.js";
import { MAX_MEDIA_BYTES } from "../../infrastructure/media.js";
import type { MediaStore } from "../../infrastructure/media.js";
import type { DirectorySaver } from "./autosave.js";
import type { LinkState } from "./connection.js";
import type { Directory } from "./directory.js";
import type { DirectoryIngest } from "./ingestion.js";
import { describeError, extractImage, extractText, imageExtension, isOneToOneUserJid, messageSeconds } from "./protocol.js";
import type { ImageContent } from "./protocol.js";

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
  media: MediaStore;
  onMessage: (message: IncomingMessage) => void;
  /** Fetches and decrypts the bytes of a media message; defaults to Baileys' download through the live socket. */
  download?: (message: WAMessage) => Promise<Buffer>;
}

/**
 * Live-only forwarding policy: only `notify` upserts that arrived after this start, from direct contacts, with text or a photo
 * and not authored by this account, reach `onMessage`. Photos are downloaded into the media store first; a photo that cannot be
 * downloaded is dropped with a log line rather than forwarded without its image.
 * Every direct message (including own and historical ones) still refreshes the chat directory.
 */
export function createInbound(options: InboundOptions): Inbound {
  const { directory, ingest, saver, link, logger, media, onMessage } = options;
  const baileysLogger = pino({ level: "warn" }, { write: text => logger(`WhatsApp: ${text.trim()}`) });
  const download = options.download ?? (async (message: WAMessage): Promise<Buffer> => {
    const socket = link.socket;
    if (!socket || !link.open) throw new Error("WhatsApp is not connected");
    return downloadMediaMessage(message, "buffer", {}, { logger: baileysLogger, reuploadRequest: socket.updateMediaMessage });
  });
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
    if (sentAt === undefined || sentAt < link.startedAtSeconds) return;
    const contact = ingest.toContact(directory.records.get(jid) ?? { jid });
    const image = extractImage(message);
    if (image) {
      const attachments = await downloadPhoto(message, id, contact.name, image);
      if (!attachments) return;
      onMessage({ id, contact, text: image.caption, attachments, acknowledge: receiptFor({ ...message.key, id, remoteJid }) });
      return;
    }
    const text = extractText(message);
    if (text === undefined) return;
    onMessage({ id, contact, text, attachments: [], acknowledge: receiptFor({ ...message.key, id, remoteJid }) });
  }

  /** Saves the photo under the media store; returns undefined (after logging why) when it must not be forwarded. */
  async function downloadPhoto(message: WAMessage, id: string, contactName: string, image: ImageContent): Promise<Attachment[] | undefined> {
    if (image.declaredBytes !== undefined && image.declaredBytes > MAX_MEDIA_BYTES) {
      logger(`Skipped a photo from ${contactName}: ${image.declaredBytes} bytes exceeds the ${MAX_MEDIA_BYTES} byte limit.`);
      return undefined;
    }
    try {
      const bytes = await download(message);
      if (bytes.length > MAX_MEDIA_BYTES) {
        logger(`Skipped a photo from ${contactName}: ${bytes.length} bytes exceeds the ${MAX_MEDIA_BYTES} byte limit.`);
        return undefined;
      }
      const fileName = `${id}.${imageExtension(image.mimeType)}`;
      const path = await media.allocate(fileName);
      await writeFile(path, bytes);
      return [{ kind: "image", path, fileName, mimeType: image.mimeType }];
    } catch (error) {
      logger(`Could not download the photo from ${contactName}: ${describeError(error)}`);
      return undefined;
    }
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
