export type Logger = (message: string) => void;
export interface Contact { id: string; name: string }
export interface RecentChat extends Contact { lastMessageAt: number | null; unread: number; archived: boolean }
export interface IdentityAlias { alias: string; canonical: string }
export type AttachmentKind = 'image' | 'video' | 'audio' | 'document';
/** A file on the local disk (inside the MediaStore directory) that travels between the messaging provider and the assistant. */
export interface Attachment { kind: AttachmentKind; path: string; fileName: string; mimeType: string }
/**
 * Provider-neutral content of an assistant reply, in display order. The assistant adapter extracts it from the assistant's UI; the messaging adapter
 * decides how to render each block for its own medium. `markdown` is standard Markdown prose (emphasis, inline code, links, lists, headings, quotes).
 */
export type ReplyBlock =
  | { type: 'markdown'; text: string }
  /** A draft the user is meant to copy and send (an email or message); delivered as its own message, Markdown formatted, without the card's label. */
  | { type: 'draft'; text: string }
  | { type: 'code'; language: string | null; code: string }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'attachment'; attachment: Attachment };
export interface IncomingMessage {
  id: string;
  contact: Contact;
  /** Message text or media caption; empty when the message is attachments only. */
  text: string;
  /** Downloaded media (for example photos) sent with the message; already saved under the MediaStore directory. */
  attachments: Attachment[];
  /** Marks the message as read in the messaging provider. Closes over provider-owned receipt data only. */
  acknowledge: () => Promise<void>;
}
export interface MessagingAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  contacts(): Contact[];
  chats(): RecentChat[];
  identities(): IdentityAlias[];
  hasSavedSession(): boolean;
  /** Resolves user input (for example a phone number) to a direct contact; throws a user-readable error for unusable input. */
  resolveContact(input: string): Contact;
  /**
   * Delivers a rendered reply as one or more messages, in order. Throws NotSentError only when nothing at all was sent; once any part has
   * gone out, failures are reported as other errors because repeating the call would duplicate that part.
   */
  sendReply(contactId: string, blocks: ReplyBlock[]): Promise<void>;
}
export interface Project { name: string; ref: string }
/** Provider-owned validation of opaque references. Core stores the returned canonical strings and never parses them. */
export interface AssistantReferencePolicy {
  normalizeProject(ref: string): string;
  normalizeConversation(ref: string, projectRef: string | null): string;
}
export interface AssistantAdapter {
  readonly references: AssistantReferencePolicy;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Complete, sorted, unique project catalog read independently of delivery; throws instead of returning a partial or falsely empty list.
   * `signal` cancels the read: implementations abort their in-flight transport and waits, finish bounded cleanup of anything they opened, then reject.
   */
  listProjects(signal?: AbortSignal): Promise<Project[]>;
  reply(input: {
    conversationRef: string | null;
    projectRef: string | null;
    text: string;
    /** Files to attach to the prompt (for example photos the contact sent). */
    attachments: Attachment[];
    onConversation: (ref: string) => Promise<void>;
    onSubmitted: () => Promise<void>;
  }): Promise<{ conversationRef: string; text: string; blocks?: ReplyBlock[] }>;
}
/**
 * Thrown by an adapter when it can prove the provider never received the message (not connected, page not ready). Only this error lets
 * the bridge retry on its own: any other failure may have reached the provider, and repeating it could duplicate the message.
 */
export class NotSentError extends Error {}
