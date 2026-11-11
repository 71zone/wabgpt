import { readFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readOrCreateOwnerToken } from '../../src/interfaces/http/auth.js';
import { startHttpServer, type HttpLimits, type HttpServer } from '../../src/interfaces/http/server.js';
import { Application } from '../../src/core/application.js';
import type { AssistantAdapter, Contact, MessagingAdapter, RecentChat } from '../../src/core/contracts.js';
import type { PersistedState } from '../../src/core/state.js';
import type { ActivityEntry, ProjectView, StateView } from '../../src/interfaces/http/view.js';
import { fakeAssistant, fakeChannel, loadState, opaqueReferences, providerNames, withDirectory } from './core-fixtures.js';

export interface Reply { status: number; headers: IncomingHttpHeaders; text: string; json: unknown }
export interface StreamEvent { event: string; data: unknown }
export type StateJson = StateView & { qr: string | null; activity?: ActivityEntry[] };
export interface ErrorJson { error: string; message: string }
export interface Session { cookie: string; csrf: string }
export interface RequestOptions { headers?: Record<string, string | undefined>; body?: string | Buffer; chunks?: Buffer[] }

export interface EventStream {
  status: number;
  events: Array<StreamEvent>;
  waitFor(predicate: (event: StreamEvent) => boolean, ms?: number): Promise<StreamEvent>;
  /** Resolves when the server ends the stream (or the connection drops). */
  ended: Promise<void>;
  close(): void;
}

export interface Harness {
  directory: string;
  application: Application;
  server: HttpServer;
  port: number;
  token: string;
  contacts: Contact[];
  chats: RecentChat[];
  calls: { channelStart: number; assistantStart: number; sent: string[] };
  origin: string;
  request(method: string, path: string, options?: RequestOptions): Promise<Reply>;
  login(token?: string, headers?: Record<string, string | undefined>): Promise<Reply>;
  signIn(): Promise<Session>;
  api(session: Session, method: string, path: string, body?: unknown, headers?: Record<string, string | undefined>): Promise<Reply>;
  events(session: Session | null, headers?: Record<string, string | undefined>): Promise<EventStream>;
  persisted(): Promise<PersistedState>;
}

export interface HarnessOptions {
  channel?: Partial<MessagingAdapter>;
  assistant?: Partial<AssistantAdapter>;
  limits?: Partial<HttpLimits>;
  publicOrigin?: string;
}

// Test-only views over JSON the server just produced; the shapes are the server's own exported types.
export const asState = (value: unknown): StateJson => value as StateJson;
/** The state returned by a successful command. */
export const commandState = (reply: Reply): StateJson => asState((reply.json as { state: unknown }).state);
export const sessionInfo = (reply: Reply): { authenticated: boolean; csrfToken?: string } => reply.json as { authenticated: boolean; csrfToken?: string };
export const activityMessage = (event: StreamEvent): string => (event.data as ActivityEntry).message;
export const asError = (reply: Reply): ErrorJson => reply.json as ErrorJson;
export const asProjects = (reply: Reply): ProjectView[] => (reply.json as { projects: ProjectView[] }).projects;

export function sessionOf(reply: Reply): Session {
  const raw = reply.headers['set-cookie']?.[0] ?? '';
  return { cookie: raw.split(';')[0] ?? '', csrf: (reply.json as { csrfToken?: string }).csrfToken ?? '' };
}

/** Real RoutingState (JSON persistence), real Application, real HTTP server on an ephemeral loopback port; synthetic adapters only. */
export async function withServer(run: (harness: Harness) => Promise<void>, options: HarnessOptions = {}): Promise<void> {
  await withDirectory(async directory => {
    const contacts: Contact[] = [{ id: '14155550101@s.whatsapp.net', name: 'Ada Example' }, { id: '14155550102@s.whatsapp.net', name: 'Bob <b>Example</b>' }];
    const chats: RecentChat[] = [];
    const calls = { channelStart: 0, assistantStart: 0, sent: [] as string[] };
    // Custom start hooks still run, but every start attempt is counted first.
    const { start: channelStart, ...channelOverrides } = options.channel ?? {};
    const { start: assistantStart, ...assistantOverrides } = options.assistant ?? {};
    const channel = fakeChannel({
      contacts: () => contacts,
      chats: () => chats,
      resolveContact: input => {
        const digits = input.replace(/[\s()+.-]/g, '');
        if (!/^[1-9]\d{6,14}$/.test(digits)) throw new Error('Enter a full international number with country code.');
        return { id: `${digits}@s.whatsapp.net`, name: `+${digits}` };
      },
      sendText: async (_id, text) => { calls.sent.push(text); },
      ...channelOverrides,
      start: async () => { calls.channelStart++; await channelStart?.(); },
    });
    const assistant = fakeAssistant({
      references: opaqueReferences,
      listProjects: async () => [{ name: 'Alpha', ref: 'ws:alpha' }, { name: 'Beta', ref: 'ws:beta' }],
      ...assistantOverrides,
      start: async () => { calls.assistantStart++; await assistantStart?.(); },
    });
    const dataDir = join(directory, 'data');
    const application = new Application({ configPath: join(directory, 'config.json'), ...providerNames }, await loadState(dataDir, undefined, opaqueReferences), channel, assistant);
    const tokenFile = join(directory, 'server-token');
    const server = await startHttpServer({
      application, limits: options.limits,
      settings: { host: '127.0.0.1', port: 0, tokenFile, ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}) },
    });
    const port = Number(new URL(server.url).port);
    const origin = `http://127.0.0.1:${port}`;
    const token = await readOrCreateOwnerToken(tokenFile);

    const request: Harness['request'] = (method, path, { headers = {}, body, chunks } = {}) => {
      const done = Promise.withResolvers<Reply>();
      const merged: Record<string, string> = { host: `127.0.0.1:${port}` };
      for (const [name, value] of Object.entries(headers)) { if (value === undefined) delete merged[name.toLowerCase()]; else merged[name.toLowerCase()] = value; }
      const outgoing = httpRequest({ host: '127.0.0.1', port, method, path, headers: merged, agent: false }, response => {
        const parts: Buffer[] = [];
        response.on('data', (part: Buffer) => parts.push(part));
        response.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let json: unknown;
          try { json = JSON.parse(text); } catch { json = undefined; }
          done.resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
        });
      });
      outgoing.on('error', error => done.reject(error));
      if (chunks) for (const chunk of chunks) outgoing.write(chunk);
      outgoing.end(body);
      return done.promise;
    };
    const json = (body: unknown, extra: Record<string, string | undefined> = {}): RequestOptions => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin, ...extra } });
    const harness: Harness = {
      directory, application, server, port, token, contacts, chats, calls, origin, request,
      login: (candidate = token, headers) => request('POST', '/api/login', json({ token: candidate }, headers)),
      signIn: async () => {
        const reply = await harness.login();
        if (reply.status !== 200) throw new Error(`Login failed with ${reply.status}`);
        return sessionOf(reply);
      },
      api: (session, method, path, body, headers) => request(method, path, method === 'GET'
        ? { headers: { cookie: session.cookie, ...headers } }
        : json(body ?? {}, { cookie: session.cookie, 'x-csrf-token': session.csrf, ...headers })),
      events: (session, headers) => openEvents(port, session ? { cookie: session.cookie, ...headers } : headers ?? {}),
      persisted: async () => JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')) as PersistedState,
    };
    try { await run(harness); }
    finally {
      await server.close();
      await application.close();
    }
  }, 'wabgpt-http-');
}

function openEvents(port: number, headers: Record<string, string | undefined>): Promise<EventStream> {
  const ready = Promise.withResolvers<EventStream>();
  const merged: Record<string, string> = { host: `127.0.0.1:${port}` };
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) merged[name.toLowerCase()] = value;
  const events: EventStream['events'] = [];
  const ended = Promise.withResolvers<void>();
  let wake = Promise.withResolvers<void>();
  const outgoing = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers: merged, agent: false }, response => {
    const status = response.statusCode ?? 0;
    let buffer = '';
    const stream: EventStream = {
      status, events, ended: ended.promise,
      close: () => outgoing.destroy(),
      waitFor: async (predicate, ms = 3000) => {
        const deadline = Date.now() + ms;
        for (;;) {
          const found = events.find(predicate);
          if (found) return found;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error(`Timed out waiting for an event; saw ${events.map(item => item.event).join(', ')}`);
          await Promise.race([wake.promise, sleep(remaining)]);
        }
      },
    };
    response.setEncoding('utf8');
    response.on('data', (text: string) => {
      buffer += text;
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        let event = 'message'; let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data) { events.push({ event, data: JSON.parse(data) as unknown }); wake.resolve(); wake = Promise.withResolvers<void>(); }
      }
    });
    response.on('end', () => ended.resolve());
    response.on('close', () => ended.resolve());
    response.on('error', () => ended.resolve());
    ready.resolve(stream);
  });
  outgoing.on('error', error => { ended.resolve(); ready.reject(error); });
  outgoing.end();
  return ready.promise;
}
