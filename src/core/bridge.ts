import { setTimeout as sleep } from 'node:timers/promises';
import { NotSentError, type AssistantAdapter, type IncomingMessage, type Logger, type MessagingAdapter } from './contracts.js';
import type { RoutingState } from './state.js';

/** User-facing provider names used in log lines and route errors. */
export interface ProviderNames { channelName: string; assistantName: string }

/** How long one message keeps being retried while its provider provably has not received it (ChatGPT not ready, WhatsApp offline). */
const RETRY_WINDOW_MS = 30 * 60_000;
const MAX_RETRY_DELAY_MS = 30_000;

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class Bridge {
  private queue: Promise<void> = Promise.resolve();
  private armed = false;
  private readonly pendingReceipts = new Set<Promise<void>>();
  constructor(private readonly store: RoutingState, private readonly assistant: AssistantAdapter, private readonly channel: MessagingAdapter, private readonly logger: Logger, private readonly names: ProviderNames) {}
  arm(): void { this.armed = true; }
  disarm(): void { this.armed = false; }
  isArmed(): boolean { return this.armed; }
  async idle(): Promise<void> {
    await this.queue;
    await Promise.allSettled([...this.pendingReceipts]);
  }
  receive(message: IncomingMessage): void {
    if (!this.armed || !this.store.route(message.contact.id)?.enabled) return;
    if (!message.text.trim() && message.attachments.length === 0) return;
    this.queue = this.queue.then(() => this.forward(message)).catch(error => {
      this.disarm();
      this.logger(`Bridge stopped forwarding: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  private async forward(message: IncomingMessage): Promise<void> {
    const { channelName, assistantName } = this.names;
    const contactId = message.contact.id;
    if (!this.armed || !this.store.route(contactId)?.enabled) return;
    const key = `${contactId}:${message.id}`;
    if (!await this.store.claim(key, contactId)) return;
    const route = await this.store.refreshConversation(contactId);
    if (!this.armed || !route?.enabled) { await this.store.finish(key, contactId, 'failed'); return; }
    const started = performance.now();
    let accepted = false;
    try {
      this.logger(`Forwarding a message from ${route.name}.`);
      const response = await this.retryUnsent(route.name, assistantName, () => this.assistant.reply({
        conversationRef: route.conversationRef,
        projectRef: route.projectRef,
        text: message.text,
        attachments: message.attachments,
        onConversation: ref => this.store.conversation(contactId, ref),
        onSubmitted: async () => {
          accepted = true;
          const receiptStarted = performance.now();
          this.logger(`${assistantName} accepted the message from ${route.name} after ${Math.round(receiptStarted - started)}ms; sending ${channelName} read receipt.`);
          const receipt = (async () => {
            try {
              await message.acknowledge();
              this.logger(`${channelName} read receipt sent for ${route.name} in ${Math.round(performance.now() - receiptStarted)}ms.`);
            } catch (error) {
              this.logger(`${channelName} read receipt failed for ${route.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
          })();
          this.pendingReceipts.add(receipt);
          void receipt.then(() => this.pendingReceipts.delete(receipt), () => this.pendingReceipts.delete(receipt));
        },
      }), () => this.assistant.start());
      this.logger(`${assistantName} reply ready for ${route.name} after ${Math.round(performance.now() - started)}ms.`);
      await this.store.conversation(contactId, response.conversationRef);
      const blocks = response.blocks ?? [{ type: 'markdown' as const, text: response.text }];
      if (!response.text.trim() && !blocks.some(block => block.type === 'attachment')) throw new Error(`${assistantName} returned an empty response.`);
      if (!this.armed || !this.store.route(contactId)?.enabled) throw new Error(`Forwarding paused before reply delivery. Response remains in ${assistantName}.`);
      const sendStarted = performance.now();
      this.logger(`Sending ${channelName} reply to ${route.name}.`);
      await this.retryUnsent(route.name, channelName, () => this.channel.sendReply(contactId, blocks));
      await this.store.finish(key, contactId, 'done');
      this.logger(`Reply sent to ${route.name}; ${channelName} send ${Math.round(performance.now() - sendStarted)}ms, total ${Math.round(performance.now() - started)}ms.`);
    } catch (error) {
      const detail = describe(error);
      await this.store.finish(key, contactId, 'failed');
      if (accepted) {
        // The prompt is already in the assistant, so replaying it could duplicate it, but the session itself is healthy: later messages still flow.
        this.logger(`No reply was delivered to ${route.name}: ${detail} The ${assistantName} conversation may still hold the answer; the message was not replayed and ${route.name} stays enabled.`);
        return;
      }
      await this.store.pause(contactId, detail);
      this.logger(`Paused ${route.name}: ${detail} Inspect ${channelName} and ${assistantName} before enabling again. No automatic replay.`);
    }
  }
  /**
   * Runs `operation`, repeating it while it fails with NotSentError (the provider provably never got the message), backing off up to 30s and
   * running `repair` between attempts. Any other failure, a disarmed bridge or an expired retry window ends the loop with the last error.
   */
  private async retryUnsent<T>(contact: string, provider: string, operation: () => Promise<T>, repair?: () => Promise<void>): Promise<T> {
    const began = Date.now();
    for (let attempt = 1; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (!(error instanceof NotSentError) || !this.armed || Date.now() - began >= RETRY_WINDOW_MS) throw error;
        if (attempt === 1 || attempt % 5 === 0) this.logger(`${provider} is not ready (${describe(error)}); retrying the message for ${contact} on its own. Nothing was sent yet.`);
        await sleep(Math.min(2000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS));
        if (repair) {
          try { await repair(); }
          catch (repairError) { if (attempt === 1 || attempt % 5 === 0) this.logger(`${provider} repair attempt failed: ${describe(repairError)}`); }
        }
      }
    }
  }
}
