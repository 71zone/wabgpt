---
type: Concept
title: Motivation and approach
description: Why wabgpt started as a family WhatsApp bridge, and the limits of using ChatGPT through a browser.
tags: [motivation, family, browser, policy]
sources:
  - id: maintainer-interview
    resource: "Maintainer interview about wabgpt, 2026-11-11"
    title: Why wabgpt was built
  - id: openai-terms
    resource: https://openai.com/policies/terms-of-use/
    title: OpenAI Terms of Use
---

# Motivation and approach

## Built for my wife

I built wabgpt for my wife. Her workplace's website allowlist blocks the ChatGPT site while WhatsApp remains available. My understanding is that there is no separate policy prohibiting AI use.[^maintainer-interview]

She mainly wants help reasoning through problems and getting spreadsheet advice. Since she can already use WhatsApp, I made it the chat interface. She does not need a separate web app, my ChatGPT password, or API keys, and I could reuse the ChatGPT subscription I already had.[^maintainer-interview]

This describes a network-access constraint, not employer approval. Permission to send work or confidential information to ChatGPT is a separate question. Subscription reuse also remains subject to the OpenAI terms discussed below.

## Put setup on the owner's side

The recipient uses WhatsApp. The owner installs wabgpt, signs into ChatGPT in BrowserOS, links WhatsApp, and chooses which contacts may receive automatic replies. Recipients do not receive the owner's ChatGPT credentials.

The owner still has work to do: keep the machine and browser available, renew expired logins, and understand where the selected contacts' messages are sent. Forwarding is an explicit opt-in, not a background default. See [first-run setup](../guides/getting-started.md).

## Keep each person's context separate

Each enabled contact has a separate saved ChatGPT conversation. A contact can also have a dedicated ChatGPT project and a fixed conversation lifetime. The owner must set project-only memory in ChatGPT; wabgpt cannot verify or change that setting. See [projects and conversation lifetimes](conversations.md).

## Why a browser bridge

Using BrowserOS lets wabgpt interact with ChatGPT's existing web interface and projects. It does not use the OpenAI API or require a separate API key.

The tradeoff is dependence on that interface. UI changes, login expiry, verification challenges and account limits can interrupt the bridge. Native BrowserOS and an isolated managed Docker browser are both supported; neither removes those limitations. See [browser setup](../guides/getting-started.md) and [delivery behavior](delivery.md).

## Browser control is not a policy exception

Avoiding a policy violation was part of the original motivation. Agent-controlled access is not evidence that the approach is permitted.

OpenAI's Terms of Use restrict both making an account available to anyone else and automatically or programmatically extracting data or output. These restrictions are directly relevant to a bridge that forwards other people's prompts and extracts replies from ChatGPT web.[^openai-terms]

Keeping a password private, using the tool only with family, or controlling the browser through an agent does not establish an exception. This project does not claim OpenAI approval or policy compliance. Check the applicable terms and obtain clarification from OpenAI before relying on subscription sharing. It is not marketed as free or unlimited ChatGPT, a family subscription plan, or a way around access restrictions.

[^maintainer-interview]: The maintainer's account of the original use case, the website allowlist at his wife's workplace, the absence of a known AI prohibition, and the subscription-reuse goal. This is not independently verified employer policy and is not a policy interpretation.
[^openai-terms]: [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/), "Registration and access" and "Using our Services," effective January 1, 2026.
