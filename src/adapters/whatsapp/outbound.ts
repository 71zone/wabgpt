import type { AnyMessageContent } from "@whiskeysockets/baileys";
import { stat } from "node:fs/promises";
import { NotSentError, type Attachment, type Logger, type ReplyBlock } from "../../core/contracts.js";
import { MAX_MEDIA_BYTES, type MediaStore } from "../../infrastructure/media.js";
import type { LinkState } from "./connection.js";
import { renderReply, type OutboundMessage } from "./render.js";

export interface OutboundTiming {
  /** Pause between consecutive messages so they arrive in order and do not trip rate limits. */
  gapMs: number;
  /** How long the first message waits for the link before the reply is reported as not sent. */
  firstConnectWaitMs: number;
  /** How long a later message waits for the link to come back before the reply is abandoned. */
  resumeConnectWaitMs: number;
  pollMs: number;
}

export const DEFAULT_OUTBOUND_TIMING: OutboundTiming = { gapMs: 300, firstConnectWaitMs: 60_000, resumeConnectWaitMs: 5 * 60_000, pollMs: 250 };

export interface OutboundOptions {
  link: LinkState;
  media: MediaStore;
  logger: Logger;
  timing?: Partial<OutboundTiming>;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function content(attachment: Attachment, caption: string | undefined): AnyMessageContent {
  const source = { url: attachment.path };
  switch (attachment.kind) {
    case "image": return { image: source, mimetype: attachment.mimeType, caption };
    case "video": return { video: source, mimetype: attachment.mimeType, caption };
    case "audio": return { audio: source, mimetype: attachment.mimeType };
    case "document": return { document: source, mimetype: attachment.mimeType, fileName: attachment.fileName, caption };
  }
}

async function unsendableReason(attachment: Attachment): Promise<string | null> {
  const info = await stat(attachment.path).catch(() => null);
  if (!info?.isFile()) return "the file is missing";
  if (info.size > MAX_MEDIA_BYTES) return "the file is too large";
  return null;
}

/** Renders a reply and delivers it message by message, strictly in order. */
export function createOutbound(options: OutboundOptions): (contactId: string, blocks: ReplyBlock[]) => Promise<void> {
  const { link, media, logger } = options;
  const timing = { ...DEFAULT_OUTBOUND_TIMING, ...options.timing };

  async function waitForLink(maxMs: number): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (!(link.socket && link.open)) {
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(timing.pollMs, Math.max(deadline - Date.now(), 1)));
    }
    return true;
  }

  async function prepare(message: OutboundMessage): Promise<AnyMessageContent> {
    if (message.kind === "text") return { text: message.text };
    const reason = await unsendableReason(message.attachment);
    if (!reason) return content(message.attachment, message.caption);
    logger(`Skipping ${message.attachment.fileName}: ${reason}`);
    return { text: `(Could not send ${message.attachment.fileName}: ${reason}.)` };
  }

  return async (contactId, blocks) => {
    const messages = await renderReply(blocks, media);
    let delivered = 0;
    for (const message of messages) {
      const first = delivered === 0;
      if (!first) await sleep(timing.gapMs);
      const prepared = await prepare(message);
      await waitForLink(first ? timing.firstConnectWaitMs : timing.resumeConnectWaitMs);
      const socket = link.open ? link.socket : null;
      if (!socket) {
        if (first) throw new NotSentError("WhatsApp is not connected");
        throw new Error(`WhatsApp connection was lost: ${delivered} of ${messages.length} messages were delivered`);
      }
      try {
        await socket.sendMessage(contactId, prepared);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`WhatsApp delivered ${delivered} of ${messages.length} messages before failing: ${reason}`, { cause: error });
      }
      delivered++;
    }
  };
}
