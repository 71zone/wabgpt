import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, setBrowserMcpUrl } from '../src/infrastructure/config.js';
import { parseLocalMcpEndpoint } from '../src/infrastructure/loopback.js';

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'wa-config-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('relative data paths resolve beside the config and saved settings override initial settings', () => withDirectory(async directory => {
  const path = join(directory, 'config.json');
  await loadConfig(path);
  await writeFile(path, JSON.stringify({ browserMcpUrl: 'http://localhost:9300/mcp', dataDir: 'account' }));
  const config = await loadConfig(path);
  assert.equal(config.browserMcpUrl, 'http://localhost:9300/mcp');
  assert.equal(config.dataDir, join(directory, 'account'));
}));

test('old config files without a server section get loopback server defaults inside the data directory', () => withDirectory(async directory => {
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify({ browserMcpUrl: 'http://127.0.0.1:9010/mcp', dataDir: 'account' }));
  const { server, dataDir } = await loadConfig(path);
  assert.deepEqual(server, { host: '127.0.0.1', port: 8788, tokenFile: join(dataDir, 'server-token') });
}));

test('server settings resolve beside the config and a public origin is normalized', () => withDirectory(async directory => {
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify({
    browserMcpUrl: 'http://127.0.0.1:9010/mcp', dataDir: 'account',
    server: { host: '0.0.0.0', port: 9000, tokenFile: 'secrets/token', publicOrigin: 'https://Bridge.example.com/' },
  }));
  const { server } = await loadConfig(path);
  assert.deepEqual(server, { host: '0.0.0.0', port: 9000, tokenFile: join(directory, 'secrets', 'token'), publicOrigin: 'https://bridge.example.com' });
}));

test('invalid saved config fails without replacing it or connecting to an external server', () => withDirectory(async directory => {
  const path = join(directory, 'config.json');
  const text = JSON.stringify({ browserMcpUrl: 'https://example.com/mcp', dataDir: 'account' });
  await writeFile(path, text);
  await assert.rejects(loadConfig(path), /Invalid configuration.*config.json/);
  assert.equal(await readFile(path, 'utf8'), text);
}));

test('endpoint credentials, unknown keys and unsafe server settings are rejected', () => withDirectory(async directory => {
  const path = join(directory, 'config.json');
  const base = { browserMcpUrl: 'http://127.0.0.1:9010/mcp', dataDir: 'account' };
  const bad: unknown[] = [
    { ...base, browserMcpUrl: 'http://user:secret@127.0.0.1:9010/mcp' },
    { ...base, browserMcpUrl: 'http://127.0.0.1.example.com/mcp' },
    { ...base, extra: true },
    { ...base, server: { port: 0 } },
    { ...base, server: { port: 70000 } },
    { ...base, server: { unknown: 1 } },
    { ...base, server: { publicOrigin: 'http://bridge.example.com' } },
    { ...base, server: { publicOrigin: 'https://bridge.example.com/app' } },
    { ...base, server: { publicOrigin: 'https://user@bridge.example.com' } },
    { ...base, server: { publicOrigin: 'not a url' } },
  ];
  for (const value of bad) {
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(loadConfig(path), /Invalid configuration/, JSON.stringify(value));
  }
  await writeFile(path, JSON.stringify({ ...base, server: { publicOrigin: 'http://localhost:8788' } }));
  assert.equal((await loadConfig(path)).server.publicOrigin, 'http://localhost:8788');
}));

test('setBrowserMcpUrl changes only the endpoint, keeps the rest of the file and stays private', () => withDirectory(async directory => {
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify({ browserMcpUrl: 'http://127.0.0.1:9010/mcp', dataDir: 'account', server: { port: 9000, publicOrigin: 'https://bridge.example.com' } }));
  await setBrowserMcpUrl(await loadConfig(path), 'http://127.0.0.1:49152/mcp');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    browserMcpUrl: 'http://127.0.0.1:49152/mcp', dataDir: 'account', server: { port: 9000, publicOrigin: 'https://bridge.example.com' },
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await loadConfig(path)).browserMcpUrl, 'http://127.0.0.1:49152/mcp');
  assert.deepEqual(await readdir(directory), ['config.json']);
}));

test('setBrowserMcpUrl refuses non-loopback endpoints and unreadable configs without touching the file', () => withDirectory(async directory => {
  const path = join(directory, 'config.json');
  const text = JSON.stringify({ browserMcpUrl: 'http://127.0.0.1:9010/mcp', dataDir: 'account' });
  await writeFile(path, text);
  const config = await loadConfig(path);
  for (const endpoint of ['https://example.com/mcp', 'http://user:pw@127.0.0.1:1/mcp', 'nonsense']) {
    await assert.rejects(setBrowserMcpUrl(config, endpoint), /Cannot save browser endpoint/, endpoint);
  }
  assert.equal(await readFile(path, 'utf8'), text);
  await writeFile(path, '{ broken');
  await assert.rejects(setBrowserMcpUrl(config, 'http://127.0.0.1:49152/mcp'), /Invalid configuration/);
  assert.equal(await readFile(path, 'utf8'), '{ broken');
  assert.deepEqual(await readdir(directory), ['config.json']);
}));

test('parseLocalMcpEndpoint accepts only credential-free loopback HTTP(S) URLs', () => {
  for (const value of ['http://127.0.0.1:9010/mcp', 'https://localhost/mcp', 'http://[::1]:9010/mcp']) assert.equal(parseLocalMcpEndpoint(value).href, new URL(value).href);
  for (const value of ['', 'nonsense', 'ftp://127.0.0.1/mcp', 'http://0.0.0.0:9010/mcp', 'http://10.0.0.5/mcp', 'http://user@127.0.0.1/mcp', 'http://:pw@localhost/mcp']) {
    assert.throws(() => parseLocalMcpEndpoint(value), Error, value);
  }
});
