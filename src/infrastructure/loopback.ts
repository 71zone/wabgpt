const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

export function isLoopbackHost(hostname: string): boolean {
  return loopbackHosts.includes(hostname);
}

/** Parses a BrowserOS MCP endpoint: HTTP(S) on a loopback host without embedded credentials. */
export function parseLocalMcpEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('BrowserOS MCP URL must be a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHost(url.hostname)) throw new Error('BrowserOS MCP URL must point to a local HTTP server');
  if (url.username || url.password) throw new Error('BrowserOS MCP URL must not contain credentials.');
  return url;
}
