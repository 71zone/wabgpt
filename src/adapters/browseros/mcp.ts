import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { Ajv } from 'ajv';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const runResult = z.object({ ok: z.boolean(), value: z.unknown().optional(), error: z.unknown().optional() });

export interface McpConnection { client: Client; tools: Tool[]; runName: string }

/** BrowserOS Neo advertises each tool under one of these names depending on how the server is mounted. */
const toolNames = (base: 'run' | 'tabs'): string[] => [base, `browseros_neo_${base}`, `mcp__browseros_neo_${base}`];

function findTool(tools: Tool[], base: 'run' | 'tabs'): Tool | undefined {
  const names = toolNames(base);
  return tools.find(tool => names.includes(tool.name));
}

/**
 * BrowserOS script prelude defining `listPages()`: browser.pages.list() with every page's `groupId` filled in.
 * Desktop BrowserOS reports `groupId` on each page record; the official Docker image does not, and exposes membership only through
 * browser.tabGroups({action:'list'}) as {groups:[{groupId,pageIds}]}. Pages that report a string groupId are kept as is; the group
 * listing is consulted only when some page lacks one, and an ungrouped page (or a server without tabGroups) gets groupId null.
 */
export const listPagesPrelude = `const listPages=async()=>{const pages=await browser.pages.list();if(pages.every(page=>typeof page.groupId==='string'))return pages;const membership=new Map();try{const listed=await browser.tabGroups({action:'list'});for(const group of listed.groups??[])for(const id of group.pageIds??[])membership.set(id,group.groupId);}catch{}return pages.map(page=>typeof page.groupId==='string'?page:{...page,groupId:membership.get(page.pageId)??null});};`;

/** True when the MCP server no longer knows this client's session (HTTP 404), the one failure that reconnecting can repair. */
export function isExpiredSession(error: unknown): boolean { return error instanceof StreamableHTTPError && error.code === 404; }

/**
 * Opens an MCP client whose tool schemas tolerate BrowserOS's uint formats and locates the BrowserOS Neo `run` tool; closes the client on failure.
 * `signal` cancels the handshake and tool listing; the failure is then the signal's reason. Closing the returned client is what aborts any HTTP request still in flight.
 */
export async function openMcp(endpoint: URL, signal?: AbortSignal): Promise<McpConnection> {
  signal?.throwIfAborted();
  const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true });
  for (const [name, format] of Object.entries(fullFormats)) ajv.addFormat(name, format);
  ajv.addFormat('uint', { type: 'number', validate: value => Number.isSafeInteger(value) && value >= 0 });
  ajv.addFormat('uint32', { type: 'number', validate: value => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff });
  ajv.addFormat('uint64', { type: 'number', validate: value => Number.isSafeInteger(value) && value >= 0 });
  const client = new Client({ name: 'whatsapp-chatgpt-bridge', version: '1.0.0' }, { jsonSchemaValidator: new AjvJsonSchemaValidator(ajv) });
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint), { timeout: 10000, signal });
    const { tools } = await client.listTools(undefined, { signal });
    const found = findTool(tools, 'run');
    if (!found) throw new Error('The MCP server does not expose BrowserOS Neo run.');
    return { client, tools, runName: found.name };
  } catch (error) { await client.close().catch(() => undefined); throw signal?.aborted ? signal.reason : error; }
}

/**
 * Runs one BrowserOS script; returns its value and the logical task handle the server reported, if any.
 * `signal` cancels the wait and rejects with the signal's reason. The SDK only abandons the request: the underlying HTTP exchange ends when the caller closes the client.
 */
export async function runScript(connection: Pick<McpConnection, 'client' | 'runName'>, code: string, session: string | undefined, signal?: AbortSignal): Promise<{ value: unknown; session: string | undefined }> {
  signal?.throwIfAborted();
  const result = await connection.client.callTool({ name: connection.runName, arguments: { code, timeout: 25000, maxChars: 500000, ...(session ? { session } : {}) } }, undefined, { timeout: 35000, signal })
    .catch((error: unknown) => { throw signal?.aborted ? signal.reason : error; });
  if (result.isError) throw new Error('BrowserOS tool rejected the operation. Inspect its connection and browser.');
  let raw: unknown = result.structuredContent;
  if (!raw) {
    const contents = z.array(z.object({ type: z.string(), text: z.string().optional() })).parse(result.content);
    for (const content of contents) {
      if (content.type !== 'text' || content.text === undefined) continue;
      try { raw = JSON.parse(content.text); break; } catch { continue; }
    }
  }
  const parsed = runResult.safeParse(raw);
  if (!parsed.success) throw new Error('Unsupported BrowserOS run response. Update BrowserOS Neo and check the MCP endpoint.');
  const next = typeof raw === 'object' && raw !== null && 'session' in raw && typeof raw.session === 'string' ? raw.session : session;
  if (!parsed.data.ok) throw new Error(`BrowserOS operation failed: ${JSON.stringify(parsed.data.error ?? 'unknown error')}`);
  return { value: parsed.data.value, session: next };
}

/** Re-attaches a fresh MCP session to an existing app-owned tab group by opening a blank tab in it, which makes the group's pages ours again. */
export async function reclaimTabGroup(connection: Pick<McpConnection, 'client' | 'tools'>, groupId: string): Promise<void> {
  const tabs = findTool(connection.tools, 'tabs');
  if (!tabs) throw new Error('BrowserOS does not expose tab-group recovery.');
  const reclaimed = await connection.client.callTool({ name: tabs.name, arguments: { action: 'new', groupId, url: 'about:blank' } }, undefined, { timeout: 15000 });
  if (reclaimed.isError) throw new Error('Could not reclaim the app-owned BrowserOS tab group.');
}
