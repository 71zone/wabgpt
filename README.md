# wabgpt

ChatGPT through WhatsApp. A self-hosted bridge that forwards selected contacts' messages to ChatGPT web through BrowserOS Neo and sends the replies back.

Built for one owner, with a terminal dashboard and an optional owner-only web dashboard. It uses the unofficial Baileys WhatsApp library, not the WhatsApp Business API or OpenAI API.

## Motivation

I built wabgpt for my wife. Her workplace's website allowlist blocks ChatGPT while WhatsApp remains available. I wanted her to ask questions through WhatsApp without another app, my password or API-key setup. Reusing my existing ChatGPT subscription was part of the goal.

**Browser automation is not a policy exception.** OpenAI's [terms](https://openai.com/policies/terms-of-use/) restrict making an account available to others and automatically extracting output. wabgpt does not claim approved subscription sharing, policy compliance, or free or unlimited ChatGPT. Read [Motivation and approach](docs/concepts/motivation.md) before using it.

## Quick start

Requires **Node.js 24+** and either BrowserOS Neo or an installed, running Docker engine. Repository access is required while this repo is private.

```sh
git clone https://github.com/71zone/wabgpt.git
cd wabgpt
npm install
npm link
wabgpt
```

The first run guides you through choosing native or managed Docker BrowserOS, signing into ChatGPT yourself, linking WhatsApp by QR, and optionally configuring a contact's project and chat lifetime. Automatic replies require an explicit opt-in. No environment variables or Compose commands are needed for this path.

Setup resumes after interruption. Existing configured installations open the terminal dashboard directly. To run setup again:

```sh
wabgpt setup
```

Rerunning setup pauses forwarding. Recipients use WhatsApp; the owner handles installation, browser login and configuration.

## Documentation

The detailed docs form an [Open Knowledge Format v0.2 bundle](docs/index.md).

- [Getting started](docs/guides/getting-started.md) and [managed Docker browser](docs/guides/managed-browser.md)
- [Projects, memory and conversation lifetimes](docs/concepts/conversations.md)
- [Terminal controls](docs/reference/terminal.md) and [configuration](docs/reference/configuration.md)
- [Headless server](docs/guides/server.md), [Docker Compose](docs/guides/docker-compose.md) and [native browser override](docs/guides/host-browser.md)
- [HTTP interface](docs/reference/http-api.md), [maintenance](docs/runbooks/maintenance.md) and [troubleshooting](docs/runbooks/troubleshooting.md)
- [Architecture and extension contracts](docs/guides/extending.md) and [contributing](CONTRIBUTING.md)

## Before enabling replies

Only enable contacts whose messages you are authorized to share. Browser UI changes, expired logins, account restrictions and verification challenges can interrupt delivery. WhatsApp may restrict accounts using unofficial clients. See [delivery behavior](docs/concepts/delivery.md), [saved data](docs/reference/local-data.md) and [security](SECURITY.md).

A dedicated project per contact is recommended. Set project-only memory in ChatGPT yourself; wabgpt cannot verify that setting. Chat lifetimes do not promise token, latency or cost savings.

## License

Original code is [MIT-licensed](LICENSE). Dependencies keep their own licenses, including GPL/AGPL components. Redistribution of combined builds has not been legally reviewed; see [third-party notices](THIRD_PARTY_NOTICES.md). Nothing is published to npm or a container registry.
