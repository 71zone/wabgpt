import type { AssistantAdapter, IncomingMessage, Logger, MessagingAdapter } from './contracts.js';
import type { RoutingState } from './state.js';

/** User-facing provider names used in log lines and route errors. */
export interface ProviderNames { channelName: string; assistantName: string }

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
    try {
      this.logger(`Forwarding a message from ${route.name}.`);
      const response = await this.assistant.reply({
        conversationRef: route.conversationRef,
        projectRef: route.projectRef,
        text: message.text,
        onConversation: ref => this.store.conversation(contactId, ref),
        onSubmitted: async () => {
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
      });
      this.logger(`${assistantName} reply ready for ${route.name} after ${Math.round(performance.now() - started)}ms.`);
      await this.store.conversation(contactId, response.conversationRef);
      if (!response.text.trim()) throw new Error(`${assistantName} returned an empty response.`);
      if (!this.armed || !this.store.route(contactId)?.enabled) throw new Error(`Forwarding paused before reply delivery. Response remains in ${assistantName}.`);
      if (response.text.length > 60_000) throw new Error(`Response exceeds the ${channelName} text limit. Read it in ${assistantName}.`);
      const sendStarted = performance.now();
      this.logger(`Sending ${channelName} reply to ${route.name}.`);
      await this.channel.sendText(contactId, response.text);
      await this.store.finish(key, contactId, 'done');
      this.logger(`Reply sent to ${route.name}; ${channelName} send ${Math.round(performance.now() - sendStarted)}ms, total ${Math.round(performance.now() - started)}ms.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.store.pause(contactId, detail);
      await this.store.finish(key, contactId, 'failed');
      this.logger(`Paused ${route.name}: ${detail} Inspect ${channelName} and ${assistantName} before enabling again. No automatic replay.`);
    }
  }
}
