---
type: Concept
title: Delivery behavior
description: What wabgpt forwards, how it avoids duplicates, why failed messages are never replayed, and how read receipts and reconnects work.
---

# Delivery behavior

How an incoming WhatsApp message becomes a ChatGPT prompt and a WhatsApp reply. The bridge favors avoiding duplicates over guaranteed delivery. Source: [`src/core/bridge.ts`](../../src/core/bridge.ts), [`src/core/state.ts`](../../src/core/state.ts), [`src/adapters/whatsapp/inbound.ts`](../../src/adapters/whatsapp/inbound.ts), [`src/adapters/whatsapp/ingestion.ts`](../../src/adapters/whatsapp/ingestion.ts), [`src/adapters/chatgpt/chatgpt.ts`](../../src/adapters/chatgpt/chatgpt.ts), [`src/adapters/browseros/mcp.ts`](../../src/adapters/browseros/mcp.ts).

## What is forwarded

Only incoming direct text and extended-text messages are forwarded. Groups, statuses, your outgoing messages, history sync, attachments and voice notes are not forwarded. History sync can update the saved directory without sending old messages to ChatGPT. Messages sent before this listener started are ignored. Only contacts you have enabled are forwarded; see [Terminal dashboard](../reference/terminal.md#enabling-a-contact) and [Conversations](conversations.md).

## Queue and journal

Messages are processed serially. The bridge saves each message ID in a delivery journal before submitting it, so duplicate events are not resent after restart. The journal and sessions live in `state.json` and hold no message or reply bodies ([Local data](../reference/local-data.md)). Replies use the selected ChatGPT web model and the existing conversation's context.

## Read receipts

After the new prompt appears in its saved ChatGPT conversation, the bridge marks the original WhatsApp message as read. It does not wait for the assistant's response to finish and does not mark failed or unconfirmed submissions as read. This uses WhatsApp's normal read-receipt API and respects your account's read-receipt privacy setting. Receipt delivery runs independently: a slow or failed receipt does not delay the WhatsApp reply. Failures are reported in Activity without resending the prompt.

## Reading the reply

The response reader matches stable user and assistant message IDs within the same completed turn, then extracts only the assistant message body. It does not depend on rendered message counts, which can shrink as ChatGPT virtualizes older turns. It does not send headings or action labels. Browser readiness alone does not prove response extraction still matches the current ChatGPT UI. Replies longer than 60,000 characters are not sent; read them in the saved ChatGPT conversation.

## Reconnects and uncertain acceptance

A linked WhatsApp device reconnects on its own after network drops, sleep or VPN changes. It retries with backoff that grows to one attempt every 30 seconds and keeps going until the connection returns, so forwarding stays active and resumes without pressing R. The bridge stops retrying only when reconnecting cannot help: the device was logged out, another client replaced this session, or WhatsApp refused the device. Before the first QR pairing completes, it gives up after 8 attempts.

The bridge checks the MCP connection before submitting each prompt and when you press B. If BrowserOS rejects an expired session with HTTP 404, the bridge creates a new MCP session and reuses its recorded tab and group instead of opening a duplicate ChatGPT tab, with at most one recovery attempt per message. If expiry happens after submission, it resumes observation only when the conversation URL is known. An uncertain submission is never automatically repeated.

## Photos and rich replies

**Photos in.** A photo a contact sends (with or without a caption) is downloaded and attached to the ChatGPT prompt; the caption becomes the prompt text. Videos, voice notes, stickers and non-image documents are still ignored. A photo that cannot be downloaded or exceeds 64 MiB is logged and not forwarded, so ChatGPT never answers a half-message. Several photos sent together arrive as separate prompts.

**Replies out.** The bridge reads the finished ChatGPT answer as structured blocks instead of flat text, then renders each block for WhatsApp so it reads well on a phone and copies cleanly:

| ChatGPT content | On WhatsApp |
|---|---|
| Prose, headings, lists, quotes, links | WhatsApp formatting (`*bold*`, `_italic_`, `~strike~`, `- ` lists), split into messages of at most 4000 characters |
| Code block | Its own message holding only the fenced code, so long-press copy gives clean code. Over 12000 characters it is sent as a `snippet.<ext>` document |
| Writing card (a draft email or message in a bordered card with a Copy button) | Its own WhatsApp-formatted message holding only the draft, without the card label, so long-press copy gives the draft alone. An email card arrives as three messages: an italic `_Subject_` label, the subject text alone, and the email body alone. The prose before and after the card stay separate messages, in order |
| Table | Its own message with an aligned monospace grid when it fits a phone (at most 40 characters wide and 30 rows); otherwise one record per row. Tables with more than 8 rows or that do not fit also arrive as `table.csv`, which opens in Excel or Sheets |
| Generated image or file | Native WhatsApp image or document, in its position in the reply |

If extracting the rich content fails, the plain text of the reply is sent instead, so a finished reply is never lost. Files in transit live in `media/` under the data directory and are deleted after 24 hours.

## Self-healing and errors

The bridge repairs itself rather than waiting for you to press R or re-enable a session.

- **Not yet sent:** if ChatGPT is not ready before the prompt is submitted (BrowserOS down, tab or composer missing, conversation still generating), or WhatsApp is offline when the reply is ready, the same message is retried with backoff up to 30 seconds for up to 30 minutes. Between attempts the bridge reconnects BrowserOS. This is safe because the provider provably never received the message.
- **Slow replies:** the bridge keeps waiting while ChatGPT is generating or the text is changing. It gives up only after 5 minutes without progress or 60 minutes in total, and retries lost BrowserOS connections the whole time.
- **Stopped forwarding:** while the saved running flag is on, a watchdog resumes forwarding whenever it becomes disarmed (BrowserOS unreachable at launch, channel failure, an unexpected bridge error), with backoff from 15 seconds to 5 minutes. A logged-out WhatsApp device still needs a QR scan.
- **After acceptance:** if ChatGPT accepted the prompt but no reply could be read or sent, the prompt is never replayed, because that could duplicate it. The session stays enabled and later messages flow. The answer may still be in the saved ChatGPT conversation.
- **Unknown failures before acceptance:** the session pauses, and you inspect both conversations before enabling it again. Interrupted deliveries are quarantined on restart. The bridge cannot promise exactly-once delivery across two remote services.

Pausing prevents any pending WhatsApp reply from being sent but cannot retract a prompt already submitted to ChatGPT. Quitting disarms forwarding and waits for an in-progress browser operation to finish before closing.

Login expiry, rate limits and verification challenges require manual attention in BrowserOS; the app does not bypass them or switch silently to an API. Browser automation can break when ChatGPT changes its UI. See [Troubleshooting](../runbooks/troubleshooting.md) and the [motivation and policy notice](motivation.md).

## Identity aliases

WhatsApp can identify one account by both a LID and a phone number. Verified mappings combine those directory entries, recent chats, forwarding settings and delivery IDs under one canonical identity, so the same message is not delivered twice across aliases. The existing ChatGPT conversation is retained; if both aliases already have different ChatGPT conversations, the bridge refuses to discard either silently. Contacts that merely share a name are not merged. Storage: [Local data](../reference/local-data.md#identity-aliases).

## Observability

Activity logs show elapsed times for ChatGPT acceptance, reply readiness and WhatsApp delivery. Dependency console output is routed into the dashboard, and structured objects are redacted to avoid exposing session keys. Message bodies are not logged.
