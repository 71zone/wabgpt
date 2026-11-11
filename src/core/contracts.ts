export type Logger = (message: string) => void;
export interface Contact { id: string; name: string }
export interface RecentChat extends Contact { lastMessageAt: number | null; unread: number; archived: boolean }
export interface IdentityAlias { alias: string; canonical: string }
export interface IncomingMessage {
  id: string;
  contact: Contact;
  text: string;
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
  sendText(contactId: string, text: string): Promise<void>;
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
    onConversation: (ref: string) => Promise<void>;
    onSubmitted: () => Promise<void>;
  }): Promise<{ conversationRef: string; text: string }>;
}
