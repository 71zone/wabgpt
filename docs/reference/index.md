# Reference

Exact facts about how wabgpt is configured and behaves. For task-oriented steps see the [guides](../guides/index.md) and [runbooks](../runbooks/index.md); for why things work this way see the [concepts](../concepts/index.md).

- [Configuration and command line](configuration.md): `config.json`, defaults, path rules, the `server` block and the `wabgpt` commands.
- [Terminal dashboard](terminal.md): panels, keys, prompts, the project picker and pausing.
- [Owner dashboard and HTTP API](http-api.md): authentication, security rules, routes, state shape and the event stream of `wabgpt serve`.
- [Local data](local-data.md): what is stored, what survives a restart, state versions, identity aliases and the single-writer lock.
