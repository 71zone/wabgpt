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

The bridge checks the MCP connection before submitting each prompt and when you press B. If BrowserOS rejects an expired session with HTTP 404, the bridge creates a new MCP session and reuses its recorded tab and group instead of opening a duplicate ChatGPT tab, with at most one recovery attempt per message. If expiry happens after submission, it resumes observation only when the conversation URL is known. An uncertain submission is never automatically repeated.

## Errors and pausing

If generation or delivery fails, the affected session pauses. Inspect both conversations before enabling it again. Failed messages are not automatically replayed, because a remote service may have accepted a message before the connection failed. Interrupted deliveries are quarantined on restart. The bridge cannot promise exactly-once delivery across two remote services.

Pausing prevents any pending WhatsApp reply from being sent but cannot retract a prompt already submitted to ChatGPT. Quitting disarms forwarding and waits for an in-progress browser operation to finish before closing.

Login expiry, rate limits and verification challenges require manual attention in BrowserOS; the app does not bypass them or switch silently to an API. Browser automation can break when ChatGPT changes its UI. See [Troubleshooting](../runbooks/troubleshooting.md) and the [motivation and policy notice](motivation.md).

## Identity aliases

WhatsApp can identify one account by both a LID and a phone number. Verified mappings combine those directory entries, recent chats, forwarding settings and delivery IDs under one canonical identity, so the same message is not delivered twice across aliases. The existing ChatGPT conversation is retained; if both aliases already have different ChatGPT conversations, the bridge refuses to discard either silently. Contacts that merely share a name are not merged. Storage: [Local data](../reference/local-data.md#identity-aliases).

## Observability

Activity logs show elapsed times for ChatGPT acceptance, reply readiness and WhatsApp delivery. Dependency console output is routed into the dashboard, and structured objects are redacted to avoid exposing session keys. Message bodies are not logged.
