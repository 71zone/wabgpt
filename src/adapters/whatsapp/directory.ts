import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const contactSchema = z.object({ jid: z.string(), name: z.string().optional(), notify: z.string().optional() });
const chatSchema = z.object({ jid: z.string(), name: z.string(), lastMessageAt: z.number().nullable(), unread: z.number(), archived: z.boolean() });
const directorySchema = z.object({
  version: z.literal(1),
  contacts: z.array(contactSchema),
  mappings: z.array(z.object({ lid: z.string().regex(/^\d+@lid$/), pn: z.string().regex(/^\d+@s\.whatsapp\.net$/) })),
  chats: z.array(chatSchema).default([]),
});
export type ContactRecord = z.infer<typeof contactSchema>;
/** Private persisted chat shape; `jid` is the WhatsApp-native field of the stored contacts.json format. */
export type StoredChat = z.infer<typeof chatSchema>;
/** Private persisted LID to phone-number mapping. */
export interface IdentityMapping { lid: string; pn: string }

export class Directory {
  readonly records = new Map<string, ContactRecord>();
  readonly mappings = new Map<string, string>();
  readonly chats = new Map<string, StoredChat>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly authDir: string) {
    const path = join(authDir, 'contacts.json');
    let text: string;
    try { text = readFileSync(path, 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    let saved;
    try { saved = directorySchema.parse(JSON.parse(text)); }
    catch (error) { throw new Error(`Cannot load saved WhatsApp directory ${path}: ${error instanceof Error ? error.message : String(error)}`); }
    for (const contact of saved.contacts) this.records.set(contact.jid, contact);
    for (const { lid, pn } of saved.mappings) this.mappings.set(lid, pn);
    for (const chat of saved.chats) this.chats.set(chat.jid, chat);
    for (const [lid, pn] of this.mappings) this.link({ lid, pn });
  }
  link({ lid, pn }: IdentityMapping): boolean {
    const changed = this.mappings.get(lid) !== pn || this.records.has(lid) || this.chats.has(lid);
    this.mappings.set(lid, pn);
    const contact = this.records.get(lid);
    if (contact) {
      this.records.set(pn, { ...contact, ...this.records.get(pn), jid: pn });
      this.records.delete(lid);
    }
    const chat = this.chats.get(lid);
    if (chat) {
      const phoneChat = this.chats.get(pn);
      this.chats.set(pn, { ...(phoneChat && (phoneChat.lastMessageAt ?? 0) >= (chat.lastMessageAt ?? 0) ? phoneChat : chat), jid: pn });
      this.chats.delete(lid);
    }
    return changed;
  }
  save(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, contacts: [...this.records.values()], mappings: [...this.mappings].map(([lid, pn]) => ({ lid, pn })), chats: [...this.chats.values()] }, null, 2) + '\n';
    const next = this.writes.then(async () => {
      await mkdir(this.authDir, { recursive: true, mode: 0o700 });
      const temporary = join(this.authDir, 'contacts.json.tmp');
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, join(this.authDir, 'contacts.json'));
    });
    this.writes = next.catch(() => undefined);
    return next;
  }
  idle(): Promise<void> { return this.writes; }
  /** Drops every in-memory record after the stored session was invalidated; files are removed by the caller. */
  clear(): void { this.records.clear(); this.mappings.clear(); this.chats.clear(); }
}
