import { isJidBroadcast, isJidGroup, isJidStatusBroadcast, isLidUser, isPnUser, normalizeMessageContent } from "@whiskeysockets/baileys";
import type { WAMessage } from "@whiskeysockets/baileys";

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function disconnectStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("output" in error)) {
    return undefined;
  }
  const { output } = error;
  if (typeof output !== "object" || output === null || !("statusCode" in output)) {
    return undefined;
  }
  return typeof output.statusCode === "number" ? output.statusCode : undefined;
}

/** Direct (phone or LID) user JIDs only; groups, broadcasts and status are never contacts. */
export function isOneToOneUserJid(jid: string): boolean {
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid)) {
    return false;
  }
  return Boolean(isPnUser(jid) || isLidUser(jid));
}

export function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function messageSeconds(message: WAMessage): number | undefined {
  const raw = message.messageTimestamp;
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const seconds = Number(raw.toString());
  return Number.isFinite(seconds) ? seconds : undefined;
}

export function extractText(message: WAMessage): string | undefined {
  const content = normalizeMessageContent(message.message);
  if (!content) {
    return undefined;
  }
  const text = content.conversation ?? content.extendedTextMessage?.text;
  return text && text.trim() ? text : undefined;
}
