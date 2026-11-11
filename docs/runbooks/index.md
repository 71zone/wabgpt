# Runbooks

Operator procedures for running wabgpt after it is set up. Setup itself is in the [guides](../guides/index.md).

- [Operate, update, back up and reset](maintenance.md): start, stop and logs for each mode, updating wabgpt and BrowserOS, cold backups and restore, reset and uninstall, owner-token rotation and stale `bridge.lock` removal.
- [Troubleshoot](troubleshooting.md): terminal and Node problems, browser and ChatGPT sign-in, datacenter IP challenges and the desktop-BrowserOS alternative, Compose and host-networking failures, browser conflicts and lock errors.

Mode names used in both pages: native (`wabgpt`, `wabgpt serve`), managed Docker browser, bundled Docker (`compose.yaml`) and the host-browser override (`compose.host-browser.yaml`). Back up and handle every data directory and volume as a secret; see [SECURITY.md](../../SECURITY.md).
