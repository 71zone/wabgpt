import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";
import type { BaileysEventMap, WASocket } from "@whiskeysockets/baileys";
import { chmod, rm } from "node:fs/promises";
import { pino } from "pino";
import type { Logger } from "../../core/contracts.js";
import type { DirectorySaver } from "./autosave.js";
import type { Directory } from "./directory.js";
import type { DirectoryIngest } from "./ingestion.js";
import { describeError, disconnectStatusCode } from "./protocol.js";

const MAX_RECONNECT_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 30_000;

/** Live socket facts owned by the connection and read by the inbound pipeline and sender. */
export interface LinkState {
  socket: WASocket | null;
  open: boolean;
  startedAtSeconds: number;
}

export function createLinkState(): LinkState {
  return { socket: null, open: false, startedAtSeconds: 0 };
}

export interface ConnectionOptions {
  authDir: string;
  logger: Logger;
  link: LinkState;
  directory: Directory;
  ingest: DirectoryIngest;
  saver: DirectorySaver;
  /** Attaches the directory and message listeners to a new socket; returns the detach function. */
  attachListeners: (ev: WASocket["ev"]) => () => void;
  /** Waits for in-flight inbound messages during stop. */
  drainInbound: () => Promise<void>;
  onStatus: (status: string) => void;
  onQr: ((qr: string) => void) | undefined;
}

export interface Connection {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Baileys socket lifecycle: connect, bounded reconnect with backoff, QR/open notifications and logged-out cleanup. */
export function createConnection(options: ConnectionOptions): Connection {
  const { authDir, logger, link, directory, ingest, saver, onStatus } = options;
  const baileysLogger = pino({ level: "warn" }, { write: text => logger(`WhatsApp: ${text.trim()}`) });

  let detach: (() => void) | null = null;
  let started = false;
  let authCleanup: Promise<void> = Promise.resolve();
  let stopping = false;
  let finished = false;
  let everOpened = false;
  let attempts = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let identityLookup: Promise<void> = Promise.resolve();
  const pendingSaves = new Set<Promise<void>>();
  let ready: { resolve: () => void; reject: (error: Error) => void } | null = null;

  function settleReady(error?: Error): void {
    const current = ready;
    ready = null;
    if (!current) return;
    if (error) current.reject(error);
    else current.resolve();
  }

  function teardownSocket(): void {
    detach?.();
    detach = null;
    const old = link.socket;
    link.socket = null;
    link.open = false;
    if (old) {
      void old.end(undefined).catch((error: unknown) => {
        logger(`Error closing WhatsApp socket: ${describeError(error)}`);
      });
    }
  }

  function fail(error: Error): void {
    finished = true;
    teardownSocket();
    onStatus(`failed: ${error.message}`);
    settleReady(error);
  }

  function handleLoggedOut(): void {
    finished = true;
    teardownSocket();
    onStatus("logged-out");
    saver.cancel();
    // The stored credentials are dead; remove them so a later start() shows a fresh QR.
    authCleanup = Promise.allSettled([...pendingSaves, directory.idle()])
      .then(() => rm(authDir, { recursive: true, force: true }))
      .catch((rmError: unknown) => {
        logger(`Failed to clear stale WhatsApp auth in ${authDir}: ${describeError(rmError)}`);
      });
    directory.clear();
    const loggedOut = new Error("WhatsApp session was logged out; stored credentials cleared. Start again to log in with a new QR.");
    logger(loggedOut.message);
    settleReady(loggedOut);
  }

  function handleClose(error: unknown): void {
    if (stopping || finished) return;
    const code = disconnectStatusCode(error);
    if (code === DisconnectReason.loggedOut) {
      handleLoggedOut();
      return;
    }
    // After the QR scan WhatsApp requires one immediate restart; it is not a failure.
    const immediate = code === DisconnectReason.restartRequired;
    if (!immediate) attempts += 1;
    if (attempts > MAX_RECONNECT_ATTEMPTS) {
      fail(new Error(`WhatsApp connection lost (${describeError(error)}); gave up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts.`));
      return;
    }
    const delay = immediate ? 0 : Math.min(1000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    onStatus(`reconnecting (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS}, code ${code ?? "unknown"})`);
    logger(`WhatsApp disconnected (${describeError(error)}); reconnecting in ${delay}ms.`);
    teardownSocket();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((connectError: unknown) => {
        if (stopping || finished) return;
        fail(new Error(`WhatsApp reconnect failed: ${describeError(connectError)}`));
      });
    }, delay);
  }

  function handleOpen(current: WASocket): void {
    link.open = true;
    everOpened = true;
    attempts = 0;
    onStatus("open");
    options.onQr?.("");
    identityLookup = ingest.resolveCachedAliases(current, () => current === link.socket && !stopping)
      .catch(error => logger(`Could not resolve cached contact aliases: ${describeError(error)}`));
    settleReady();
  }

  function subscribe(current: WASocket, saveCreds: () => Promise<void>): () => void {
    const ev = current.ev;

    const onCreds = (): void => {
      const save = saveCreds()
        .catch((error: unknown) => {
          logger(`Failed to save WhatsApp credentials: ${describeError(error)}`);
        })
        .finally(() => {
          pendingSaves.delete(save);
        });
      pendingSaves.add(save);
    };

    const onConnection = (update: BaileysEventMap["connection.update"]): void => {
      if (current !== link.socket) return;
      if (update.qr) {
        onStatus("waiting-for-qr-scan");
        options.onQr?.(update.qr);
      }
      if (update.connection === "connecting") onStatus("connecting");
      if (update.connection === "open") handleOpen(current);
      if (update.connection === "close") {
        link.open = false;
        handleClose(update.lastDisconnect?.error);
      }
    };

    ev.on("creds.update", onCreds);
    ev.on("connection.update", onConnection);
    const detachListeners = options.attachListeners(ev);
    return () => {
      ev.off("creds.update", onCreds);
      ev.off("connection.update", onConnection);
      detachListeners();
    };
  }

  async function connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    await chmod(authDir, 0o700);
    if (stopping || finished) return;
    const current = makeWASocket({
      auth: state,
      logger: baileysLogger,
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
    });
    link.socket = current;
    detach = subscribe(current, saveCreds);
  }

  return {
    async start(): Promise<void> {
      if (started && !stopping && !finished) {
        throw new Error("WhatsApp adapter already running; call stop() before start()");
      }
      started = true;
      stopping = false;
      finished = false;
      everOpened = false;
      attempts = 0;
      link.startedAtSeconds = Math.floor(Date.now() / 1000);
      await authCleanup;
      if (stopping) {
        throw new Error("WhatsApp adapter stopped before the connection opened");
      }
      const { promise: opened, resolve, reject } = Promise.withResolvers<void>();
      ready = { resolve, reject };
      try {
        await connect();
      } catch (error) {
        const failure = new Error(`Failed to start WhatsApp: ${describeError(error)}`);
        finished = true;
        settleReady(failure);
        await opened.catch(() => undefined);
        throw failure;
      }
      await opened;
    },

    async stop(): Promise<void> {
      stopping = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      teardownSocket();
      settleReady(new Error("WhatsApp adapter stopped before the connection opened"));
      await options.drainInbound();
      await identityLookup;
      await Promise.allSettled([...pendingSaves]);
      await saver.flush();
      if (everOpened) onStatus("stopped");
    },
  };
}
