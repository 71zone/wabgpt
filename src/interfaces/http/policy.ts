import type { IncomingMessage, ServerResponse } from 'node:http';

export interface HttpServerSettings {
  host: string;
  port: number;
  tokenFile: string;
  /** Trusted external origin when a TLS reverse proxy fronts the server, for example https://wabgpt.example.com. */
  publicOrigin?: string;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::', '[::]']);

export interface RequestOrigin {
  /** Origin the browser must report for this request. */
  origin: string;
  /** True when the request arrived through the trusted HTTPS public origin. */
  secure: boolean;
}

/**
 * Host and Origin policy. Loopback names are always accepted so SSH forwards and published loopback ports work, together
 * with the specific bind address and the configured public origin. Any other Host is refused, which blocks DNS rebinding.
 */
export class OriginPolicy {
  private readonly names = new Set(LOOPBACK_NAMES);
  private readonly publicOrigin: URL | null;

  constructor(settings: HttpServerSettings) {
    const bind = settings.host.trim().toLowerCase();
    if (!WILDCARD_HOSTS.has(bind)) this.names.add(bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind);
    this.publicOrigin = settings.publicOrigin ? new URL(settings.publicOrigin) : null;
  }

  /** The origin this request is entitled to, or null when its Host header is not trusted. */
  resolve(request: IncomingMessage): RequestOrigin | null {
    const header = request.headers.host;
    if (typeof header !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,255}$/.test(header)) return null;
    if (this.publicOrigin) {
      const external = hostOf(this.publicOrigin.protocol, header);
      if (external === this.publicOrigin.host) return { origin: this.publicOrigin.origin, secure: this.publicOrigin.protocol === 'https:' };
    }
    const parsed = parseUrl(`http://${header}`);
    if (!parsed || parsed.host === '' || !this.names.has(parsed.hostname)) return null;
    return { origin: `http://${parsed.host}`, secure: false };
  }
}

function parseUrl(text: string): URL | null {
  try { return new URL(text); } catch { return null; }
}

function hostOf(protocol: string, header: string): string | null {
  return parseUrl(`${protocol}//${header}`)?.host ?? null;
}

/** Browser-supplied cross-origin signals for an API request. Absent headers are legitimate for same-origin GET. */
export function crossOrigin(request: IncomingMessage, expected: RequestOrigin): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== expected.origin) return true;
  const site = request.headers['sec-fetch-site'];
  return site !== undefined && site !== 'same-origin' && site !== 'none';
}

export const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
} as const;

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  if (response.headersSent) { response.end(); return; }
  const text = JSON.stringify(body);
  response.writeHead(status, { ...PRIVATE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
  response.end(text);
}
