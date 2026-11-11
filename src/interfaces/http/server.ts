import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Application } from '../../core/application.js';
import type { Contact } from '../../core/contracts.js';
import { parseConversationTtl } from '../../core/duration.js';
import { FailureLimiter, SessionStore, createTokenVerifier, readOrCreateOwnerToken, safeEqual, type Closable, type Session } from './auth.js';
import { OriginPolicy, PRIVATE_HEADERS, crossOrigin, sendJson, type HttpServerSettings, type RequestOrigin } from './policy.js';
import { buildProjects, buildState, publicMessage, type ActivityEntry, type StateView } from './view.js';

export type { HttpServerSettings } from './policy.js';

export interface HttpLimits {
  /** Absolute lifetime of a login session. */
  sessionTtlMs: number;
  maxSessions: number;
  /** Failed logins allowed per remote address within the window; the whole server tolerates ten times as many. */
  loginMaxFailures: number;
  loginWindowMs: number;
  heartbeatMs: number;
  activityEntries: number;
  streamsPerSession: number;
  maxStreams: number;
}

const DEFAULT_LIMITS: HttpLimits = {
  sessionTtlMs: 12 * 60 * 60_000,
  maxSessions: 8,
  loginMaxFailures: 5,
  loginWindowMs: 60_000,
  heartbeatMs: 25_000,
  activityEntries: 200,
  streamsPerSession: 4,
  maxStreams: 16,
};

export interface HttpServerOptions {
  application: Application;
  settings: HttpServerSettings;
  /** Overrides for the built-in limits. Mainly for tests. */
  limits?: Partial<HttpLimits>;
}

export interface HttpServer {
  /** Local URL the server listens on. */
  url: string;
  /** Stops serving, closes every event stream and removes all Application listeners. Idempotent. Does not close the Application. */
  close(): Promise<void>;
}

const WEB_ROOT = new URL('../../../web/', import.meta.url);
const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

const LOGIN_BODY_LIMIT = 4 * 1024;
const BODY_LIMIT = 8 * 1024;
const STREAM_BACKLOG_LIMIT = 1024 * 1024;
const contactId = z.string().min(1).max(512);
const noBody = z.strictObject({});
const loginBody = z.strictObject({ token: z.string().min(1).max(256) });
const addBody = z.strictObject({ input: z.string().trim().min(1).max(128) });
const enabledBody = z.strictObject({ contactId, enabled: z.boolean() });
const projectBody = z.strictObject({ contactId, projectRef: z.string().min(1).max(2048).nullable() });
const ttlBody = z.strictObject({ contactId, ttl: z.string().max(32) });

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Record<string, string> = {}) { super(message); }
}

interface Stream extends Closable { response: ServerResponse; session: Session }

export async function startHttpServer({ application, settings, limits: overrides }: HttpServerOptions): Promise<HttpServer> {
  const limits: HttpLimits = { ...DEFAULT_LIMITS, ...overrides };
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const { file, type } of Object.values(ASSETS)) {
    if (!assets.has(file)) assets.set(file, { body: await readFile(new URL(file, WEB_ROOT)), type });
  }
  const verifyToken = createTokenVerifier(await readOrCreateOwnerToken(settings.tokenFile));
  const policy = new OriginPolicy(settings);
  const sessions = new SessionStore({ ttlMs: limits.sessionTtlMs, maxSessions: limits.maxSessions });
  const addressFailures = new FailureLimiter(limits.loginMaxFailures, limits.loginWindowMs);
  const globalFailures = new FailureLimiter(limits.loginMaxFailures * 10, limits.loginWindowMs, 1);
  const streams = new Set<Stream>();
  const activity: ActivityEntry[] = [];
  let nextActivity = 1;
  let qrImage: string | null = null;
  let qrVersion = 0;
  let flushTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const state = (): StateView & { qr: string | null } => ({ ...buildState(application), qr: qrImage });
  const write = (stream: Stream, event: string, data: unknown): void => {
    stream.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (stream.response.writableLength > STREAM_BACKLOG_LIMIT) stream.close();
  };
  const broadcast = (event: string, data: unknown): void => { for (const stream of [...streams]) write(stream, event, data); };
  const remember = (message: string): void => {
    const entry: ActivityEntry = { id: nextActivity++, at: Date.now(), message: publicMessage(message, '') };
    if (!entry.message) return;
    activity.push(entry);
    if (activity.length > limits.activityEntries) activity.splice(0, activity.length - limits.activityEntries);
    broadcast('activity', entry);
  };
  const scheduleFlush = (): void => {
    if (closed || flushTimer || streams.size === 0) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (streams.size === 0) return;
      try { broadcast('state', state()); } catch (error) { remember(`Dashboard update failed: ${publicMessage(error, 'unknown error')}`); }
    }, 25);
  };
  const onLog = (message: string): void => remember(message);
  const onQr = (raw: string): void => {
    const version = ++qrVersion;
    if (!raw) { qrImage = null; scheduleFlush(); return; }
    QRCode.toDataURL(raw, { errorCorrectionLevel: 'M', margin: 2, width: 320 }).then(image => {
      if (version === qrVersion && !closed) { qrImage = image; scheduleFlush(); }
    }, () => {
      if (version !== qrVersion || closed) return;
      qrImage = null; scheduleFlush();
      remember('The pairing QR code could not be rendered.');
    });
  };
  application.on('log', onLog);
  application.on('change', scheduleFlush);
  application.on('qr', onQr);
  const unsubscribe = (): void => {
    application.off('log', onLog);
    application.off('change', scheduleFlush);
    application.off('qr', onQr);
  };

  const cookieName = (origin: RequestOrigin): string => (origin.secure ? '__Host-wabgpt_session' : 'wabgpt_session');
  const cookieValue = (request: IncomingMessage, name: string): string | undefined => {
    for (const part of (request.headers.cookie ?? '').split(';')) {
      const index = part.indexOf('=');
      if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
    }
    return undefined;
  };
  const sessionCookie = (origin: RequestOrigin, value: string, maxAgeSeconds: number): string =>
    `${cookieName(origin)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${origin.secure ? '; Secure' : ''}`;
  const sessionOf = (request: IncomingMessage, origin: RequestOrigin): Session | undefined => sessions.get(cookieValue(request, cookieName(origin)));

  function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
    const tooLarge = (): HttpError => new HttpError(413, 'body_too_large', 'Request body is too large.', { Connection: 'close' });
    const declared = Number(request.headers['content-length'] ?? 0);
    if (!Number.isFinite(declared) || declared > limit) return Promise.reject(tooLarge());
    const done = Promise.withResolvers<unknown>();
    const chunks: Buffer[] = [];
    let total = 0;
    const finish = (): void => { request.off('data', onData); request.off('end', onEnd); request.off('error', onAbort); request.off('close', onAbort); };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > limit) { finish(); done.reject(tooLarge()); return; }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      finish();
      if (total === 0) { done.resolve({}); return; }
      try { done.resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { done.reject(new HttpError(400, 'invalid_json', 'Request body must be valid JSON.')); }
    };
    const onAbort = (): void => { finish(); done.reject(new HttpError(400, 'aborted', 'The request ended early.', { Connection: 'close' })); };
    request.on('data', onData); request.on('end', onEnd); request.on('error', onAbort); request.on('close', onAbort);
    return done.promise;
  }

  async function parse<T extends z.ZodType>(request: IncomingMessage, schema: T, limit = BODY_LIMIT): Promise<z.infer<T>> {
    const result = schema.safeParse(await readJson(request, limit));
    if (!result.success) throw new HttpError(400, 'invalid_request', 'Request fields are missing or not allowed.');
    return result.data;
  }

  function findContact(id: string): Contact {
    const contact = application.snapshot().directory.find(item => item.id === id);
    if (!contact) throw new HttpError(404, 'unknown_contact', 'That contact is not in the directory.');
    return { id: contact.id, name: contact.name };
  }

  /** Runs one Application operation; any failure becomes a bounded, URL-free message. */
  async function run(response: ServerResponse, status: number, fallback: string, operation: () => Promise<unknown>): Promise<void> {
    try { await operation(); }
    catch (error) { throw new HttpError(status, 'command_failed', publicMessage(error, fallback)); }
    sendJson(response, 200, { ok: true, state: state() });
  }

  async function login(request: IncomingMessage, response: ServerResponse, origin: RequestOrigin): Promise<void> {
    const address = request.socket.remoteAddress ?? 'unknown';
    const wait = Math.max(addressFailures.retryAfter(address), globalFailures.retryAfter('*'));
    if (wait > 0) throw new HttpError(429, 'too_many_attempts', 'Too many failed sign-in attempts. Wait and try again.', { 'Retry-After': String(Math.ceil(wait / 1000)) });
    const { token } = await parse(request, loginBody, LOGIN_BODY_LIMIT);
    if (!verifyToken(token)) {
      addressFailures.fail(address); globalFailures.fail('*');
      throw new HttpError(401, 'invalid_token', 'The owner token is not valid.');
    }
    addressFailures.clear(address);
    const previous = sessionOf(request, origin);
    if (previous) sessions.revoke(previous);
    const { id, session } = sessions.create();
    sendJson(response, 200, { csrfToken: session.csrfToken, expiresAt: session.expiresAt, app: buildState(application).app },
      { 'Set-Cookie': sessionCookie(origin, id, Math.floor(limits.sessionTtlMs / 1000)) });
  }

  function openStream(request: IncomingMessage, response: ServerResponse, session: Session): void {
    if (session.streams.size >= limits.streamsPerSession || streams.size >= limits.maxStreams) throw new HttpError(429, 'too_many_streams', 'Too many open event streams.');
    response.writeHead(200, { ...PRIVATE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const stream: Stream = {
      response, session,
      close: () => { cleanup(); response.end(); },
    };
    const heartbeat = setInterval(() => { response.write(': keep-alive\n\n'); }, limits.heartbeatMs);
    function cleanup(): void {
      clearInterval(heartbeat);
      streams.delete(stream);
      session.streams.delete(stream);
    }
    streams.add(stream); session.streams.add(stream);
    response.on('close', cleanup);
    response.write('retry: 3000\n\n');
    write(stream, 'snapshot', { ...state(), activity });
  }

  function serveAsset(request: IncomingMessage, response: ServerResponse, path: string): void {
    const entry = ASSETS[path];
    const asset = entry && assets.get(entry.file);
    if (!asset) throw new HttpError(404, 'not_found', 'Not found.');
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.', { Allow: 'GET, HEAD' });
    response.writeHead(200, { ...PRIVATE_HEADERS, 'Cache-Control': 'no-cache', 'Content-Type': asset.type, 'Content-Length': asset.body.length });
    response.end(request.method === 'HEAD' ? undefined : asset.body);
  }

  async function api(request: IncomingMessage, response: ServerResponse, path: string, origin: RequestOrigin): Promise<void> {
    if (crossOrigin(request, origin)) throw new HttpError(403, 'cross_origin', 'Cross-origin requests are not allowed.');
    const method = request.method ?? 'GET';
    const get = (): void => { if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.', { Allow: 'GET' }); };
    const post = (): void => {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.', { Allow: 'POST' });
      if (request.headers.origin !== origin.origin) throw new HttpError(403, 'cross_origin', 'A same-origin Origin header is required.');
      if (!/^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
    };
    const authorized = (mutating: boolean): Session => {
      const session = sessionOf(request, origin);
      if (!session) throw new HttpError(401, 'unauthenticated', 'Sign in with the owner token.');
      if (mutating) {
        const supplied = request.headers['x-csrf-token'];
        if (typeof supplied !== 'string' || !safeEqual(supplied, session.csrfToken)) throw new HttpError(403, 'csrf', 'The CSRF token is missing or invalid.');
      }
      return session;
    };

    switch (path) {
      case '/api/session': {
        get();
        const session = sessionOf(request, origin);
        sendJson(response, 200, session ? { authenticated: true, csrfToken: session.csrfToken, expiresAt: session.expiresAt, app: buildState(application).app } : { authenticated: false });
        return;
      }
      case '/api/login': post(); return login(request, response, origin);
      case '/api/logout': {
        post();
        const session = authorized(true);
        await parse(request, noBody);
        sessions.revoke(session);
        sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie(origin, '', 0) });
        return;
      }
      case '/api/state': get(); authorized(false); sendJson(response, 200, { ...state(), activity }); return;
      case '/api/events': get(); openStream(request, response, authorized(false)); return;
      case '/api/projects': {
        get(); authorized(false);
        try { sendJson(response, 200, { projects: await buildProjects(application) }); }
        catch (error) { throw new HttpError(502, 'projects_unavailable', publicMessage(error, 'The project list could not be read. Check the browser connection.')); }
        return;
      }
      case '/api/channel/connect':
        post(); authorized(true); await parse(request, noBody);
        return run(response, 409, 'Could not start the connection.', async () => { application.login(); });
      case '/api/browser/check':
        post(); authorized(true); await parse(request, noBody);
        return run(response, 502, 'The browser check failed.', () => application.checkBrowser());
      case '/api/forwarding/resume':
        post(); authorized(true); await parse(request, noBody);
        return run(response, 409, 'Forwarding could not be resumed.', () => application.resume());
      case '/api/forwarding/pause':
        post(); authorized(true); await parse(request, noBody);
        return run(response, 409, 'Forwarding could not be paused.', () => application.pause());
      case '/api/contacts': {
        post(); authorized(true);
        const { input } = await parse(request, addBody);
        return run(response, 422, 'That contact could not be added.', () => application.addContact(input));
      }
      case '/api/contacts/enabled': {
        post(); authorized(true);
        const body = await parse(request, enabledBody);
        const contact = findContact(body.contactId);
        return run(response, 409, 'The change could not be applied.', () => application.setContactEnabled(contact, body.enabled));
      }
      case '/api/contacts/project': {
        post(); authorized(true);
        const body = await parse(request, projectBody);
        const contact = findContact(body.contactId);
        return run(response, 409, 'The project could not be assigned.', () => application.setProject(contact, body.projectRef));
      }
      case '/api/contacts/ttl': {
        post(); authorized(true);
        const body = await parse(request, ttlBody);
        const contact = findContact(body.contactId);
        let minutes: number | null;
        try { minutes = parseConversationTtl(body.ttl); }
        catch (error) { throw new HttpError(400, 'invalid_ttl', publicMessage(error, 'Enter a lifetime like 90m, 12h, 3d or never.')); }
        return run(response, 409, 'The lifetime could not be saved.', () => application.setConversationTtl(contact, minutes));
      }
      default: throw new HttpError(404, 'not_found', 'Not found.');
    }
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        const origin = policy.resolve(request);
        if (!origin) throw new HttpError(421, 'unexpected_host', 'This Host is not accepted by the server.');
        const target = request.url && /^\/(?![/\\])/.test(request.url) ? new URL(request.url, origin.origin) : null;
        if (!target) throw new HttpError(400, 'bad_request', 'Bad request.');
        if (target.pathname.startsWith('/api/')) await api(request, response, target.pathname, origin);
        else serveAsset(request, response, target.pathname);
      } catch (error) {
        if (error instanceof HttpError) {
          if (error.headers.Connection === 'close') response.once('finish', () => request.destroy());
          sendJson(response, error.status, { error: error.code, message: error.message }, error.headers);
        } else {
          remember(`A dashboard request failed: ${publicMessage(error, 'unknown error')}`);
          sendJson(response, 500, { error: 'internal', message: 'The server could not complete the request.' });
        }
      }
    })();
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.maxConnections = 128;
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); });

  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(settings.port, settings.host, () => listening.resolve());
  try { await listening.promise; }
  catch (error) { unsubscribe(); sessions.closeAll(); throw error; }
  server.off('error', listening.reject);
  server.on('error', error => remember(`The dashboard server reported an error: ${publicMessage(error, 'unknown error')}`));

  const { address, port } = server.address() as AddressInfo;
  const host = address === '0.0.0.0' || address === '::' ? '127.0.0.1' : address.includes(':') ? `[${address}]` : address;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host}:${port}`,
    close: () => closing ??= (async () => {
      closed = true;
      unsubscribe();
      clearTimeout(flushTimer ?? undefined);
      sessions.closeAll();
      for (const stream of [...streams]) stream.close();
      const stopped = Promise.withResolvers<void>();
      server.close(() => stopped.resolve());
      server.closeIdleConnections();
      const force = setTimeout(() => server.closeAllConnections(), 1000);
      await stopped.promise;
      clearTimeout(force);
    })(),
  };
}
