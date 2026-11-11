import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { isExpiredSession, openMcp, reclaimTabGroup, runScript } from '../src/adapters/browseros/mcp.js';

const rpcSchema = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string(), params: z.object({ name: z.string().optional(), arguments: z.record(z.string(), z.unknown()).optional() }).passthrough().optional() });

/** `hang` holds every request of `method` open without answering; `aborted` counts those the client later abandoned at the HTTP level. */
interface Script { tools: unknown[]; call(name: string, args: Record<string, unknown>): unknown; expire?: boolean; hang?: { method: string; started: number; aborted: number } }

async function withServer(script: Script, run: (endpoint: URL) => Promise<void>): Promise<void> {
  const sessions = new Set<string>();
  let counter = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') { response.writeHead(405).end(); return; }
      if (request.method === 'DELETE') { response.writeHead(200).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const rpc = rpcSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      const header = request.headers['mcp-session-id'];
      const sessionId = typeof header === 'string' ? header : undefined;
      if (rpc.method !== 'initialize' && (!sessionId || !sessions.has(sessionId) || script.expire)) { response.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found: Session not found'); return; }
      if (rpc.id === undefined) { response.writeHead(202).end(); return; }
      if (script.hang?.method === rpc.method) {
        const hang = script.hang;
        hang.started++;
        response.once('close', () => { hang.aborted++; });
        return;
      }
      let result: unknown;
      if (rpc.method === 'initialize') {
        const id = `session-${++counter}`; sessions.add(id);
        response.setHeader('mcp-session-id', id);
        result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'browseros-neo', version: 'test' } };
      } else if (rpc.method === 'tools/list') result = { tools: script.tools };
      else if (rpc.method === 'tools/call') result = script.call(rpc.params?.name ?? '', rpc.params?.arguments ?? {});
      else throw new Error(`Unexpected method: ${rpc.method}`);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) { if (!response.destroyed) response.writeHead(500).end(error instanceof Error ? error.message : String(error)); }
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  try { await run(new URL(`http://127.0.0.1:${address.port}/mcp`)); }
  finally {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  }
}

const tool = (name: string, extra: Record<string, unknown> = {}): unknown => ({ name, description: name, inputSchema: { type: 'object', additionalProperties: true }, ...extra });

for (const name of ['run', 'browseros_neo_run', 'mcp__browseros_neo_run']) {
  test(`the BrowserOS Neo run tool is found under the name ${name}`, async () => {
    await withServer({ tools: [tool('unrelated'), tool(name)], call: () => ({}) }, async endpoint => {
      const connection = await openMcp(endpoint);
      try { assert.equal(connection.runName, name); } finally { await connection.client.close(); }
    });
  });
}

test('a server without the run tool is rejected and its client closed', async () => {
  await withServer({ tools: [tool('tabs')], call: () => ({}) }, async endpoint => {
    await assert.rejects(openMcp(endpoint), /does not expose BrowserOS Neo run/);
  });
});

test('run results are read from structured content, from JSON text content, and the reported task handle replaces the caller handle', async () => {
  const calls: Record<string, unknown>[] = [];
  await withServer({
    tools: [tool('run')],
    call: (_name, args) => {
      calls.push(args);
      if (args.code === 'structured') return { content: [], structuredContent: { ok: true, value: 41, session: 'task-1' } };
      if (args.code === 'text') return { content: [{ type: 'text', text: 'not json' }, { type: 'text', text: JSON.stringify({ ok: true, value: 'text value' }) }] };
      if (args.code === 'failed') return { content: [], structuredContent: { ok: false, error: 'boom' } };
      if (args.code === 'unsupported') return { content: [{ type: 'text', text: 'plain words' }] };
      return { content: [{ type: 'text', text: 'rejected' }], isError: true };
    },
  }, async endpoint => {
    const connection = await openMcp(endpoint);
    try {
      assert.deepEqual(await runScript(connection, 'structured', undefined), { value: 41, session: 'task-1' });
      assert.deepEqual(await runScript(connection, 'text', 'task-1'), { value: 'text value', session: 'task-1' });
      assert.equal(calls[0]?.session, undefined);
      assert.equal(calls[1]?.session, 'task-1');
      assert.equal(calls[0]?.timeout, 25000);
      assert.equal(calls[0]?.maxChars, 500000);
      await assert.rejects(runScript(connection, 'failed', undefined), /BrowserOS operation failed: "boom"/);
      await assert.rejects(runScript(connection, 'unsupported', undefined), /Unsupported BrowserOS run response/);
      await assert.rejects(runScript(connection, 'rejected', undefined), /BrowserOS tool rejected the operation/);
    } finally { await connection.client.close(); }
  });
});

test('tool output schemas using the BrowserOS uint, uint32 and uint64 formats validate, and violations are still rejected', async () => {
  const output = (value: number, big: number, bytes: number): unknown => ({ content: [], structuredContent: { ok: true, value, big, bytes } });
  await withServer({
    tools: [tool('run', { outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, value: { type: 'number', format: 'uint' }, big: { type: 'number', format: 'uint32' }, bytes: { type: 'number', format: 'uint64' } } } })],
    call: (_name, args) => args.code === 'negative' ? output(-1, 1, 1) : args.code === 'too-big' ? output(1, 2 ** 32, 1) : args.code === 'negative-bytes' ? output(1, 1, -1) : args.code === 'fractional-bytes' ? output(1, 1, 1.5) : output(7, 0xffff_ffff, Number.MAX_SAFE_INTEGER),
  }, async endpoint => {
    const connection = await openMcp(endpoint);
    try {
      assert.deepEqual(await runScript(connection, 'positive', undefined), { value: 7, session: undefined });
      for (const code of ['negative', 'too-big', 'negative-bytes', 'fractional-bytes']) await assert.rejects(runScript(connection, code, undefined), code);
    } finally { await connection.client.close(); }
  });
});

test('an expired MCP session is distinguishable from other failures', async () => {
  const script: Script = { tools: [tool('run')], call: () => ({ content: [], structuredContent: { ok: true, value: 1 } }) };
  await withServer(script, async endpoint => {
    const connection = await openMcp(endpoint);
    try {
      script.expire = true;
      const error = await runScript(connection, 'any', undefined).then(() => null, (caught: unknown) => caught);
      assert.ok(isExpiredSession(error));
      assert.ok(!isExpiredSession(new Error('Not Found')));
    } finally { await connection.client.close().catch(() => undefined); }
  });
});

test('tab-group recovery uses whichever tabs tool name the server advertises and requires it to exist', async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  await withServer({ tools: [tool('run'), tool('mcp__browseros_neo_tabs')], call: (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: 'ok' }] }; } }, async endpoint => {
    const connection = await openMcp(endpoint);
    try {
      await reclaimTabGroup(connection, 'group-1');
      assert.deepEqual(calls, [{ name: 'mcp__browseros_neo_tabs', args: { action: 'new', groupId: 'group-1', url: 'about:blank' } }]);
    } finally { await connection.client.close(); }
  });
  await withServer({ tools: [tool('run')], call: () => ({}) }, async endpoint => {
    const connection = await openMcp(endpoint);
    try { await assert.rejects(reclaimTabGroup(connection, 'group-1'), /does not expose tab-group recovery/); } finally { await connection.client.close(); }
  });
  await withServer({ tools: [tool('run'), tool('tabs')], call: () => ({ content: [{ type: 'text', text: 'no' }], isError: true }) }, async endpoint => {
    const connection = await openMcp(endpoint);
    try { await assert.rejects(reclaimTabGroup(connection, 'group-1'), /Could not reclaim the app-owned BrowserOS tab group/); } finally { await connection.client.close(); }
  });
});

async function settle(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for the server to observe the abort');
    await sleep(10);
  }
}

test('an aborted handshake rejects with the signal reason and the abandoned HTTP exchange ends', { timeout: 10_000 }, async () => {
  const hang = { method: 'initialize', started: 0, aborted: 0 };
  await withServer({ tools: [tool('run')], call: () => ({}), hang }, async endpoint => {
    const controller = new AbortController();
    const reason = new Error('setup cancelled');
    const opening = assert.rejects(openMcp(endpoint, controller.signal), error => error === reason);
    await settle(() => hang.started === 1);
    controller.abort(reason);
    await opening;
    await settle(() => hang.aborted === 1);
  });
});

test('an aborted run request rejects with the signal reason promptly and ends when its client closes, while other requests on the client still work', { timeout: 10_000 }, async () => {
  const hang = { method: 'tools/call', started: 0, aborted: 0 };
  await withServer({ tools: [tool('run'), tool('tabs')], call: () => ({}), hang }, async endpoint => {
    const connection = await openMcp(endpoint);
    try {
      const controller = new AbortController();
      const reason = new Error('setup cancelled');
      const running = assert.rejects(runScript(connection, 'return 1;', undefined, controller.signal), error => error === reason);
      await settle(() => hang.started === 1);
      controller.abort(reason);
      await running;
      // The request was abandoned but its HTTP exchange is still open until the client closes.
      assert.equal(hang.aborted, 0);
      assert.equal((await connection.client.listTools(undefined, { timeout: 2000 })).tools.length, 2);
    } finally { await connection.client.close(); }
    await settle(() => hang.aborted === 1);
  });
});

test('an already aborted signal never reaches the server', async () => {
  const hang = { method: 'initialize', started: 0, aborted: 0 };
  await withServer({ tools: [tool('run')], call: () => ({}), hang }, async endpoint => {
    await assert.rejects(openMcp(endpoint, AbortSignal.abort(new Error('not started'))), /not started/);
    assert.equal(hang.started, 0);
  });
});
