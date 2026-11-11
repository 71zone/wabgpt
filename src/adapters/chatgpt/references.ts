import type { AssistantReferencePolicy } from '../../core/contracts.js';

// ChatGPT's reference format is its canonical URL: a project ref is https://chatgpt.com/g/g-p-<32 hex>, a conversation ref is /c/<id> optionally scoped by that project.
const origin = 'https://chatgpt.com';
const projectSegment = 'g-p-[0-9a-fA-F]{32}';
const slugSegment = '(?:-[A-Za-z0-9_%.~-]*)?';
const projectPath = new RegExp(`^/g/(${projectSegment})${slugSegment}(?:/project)?/?$`);
const conversationPath = new RegExp(`^(?:/g/(${projectSegment})${slugSegment})?/c/([A-Za-z0-9-]+)$`);

export interface Destination { conversationUrl: string | null; projectUrl: string | null }

function chatgptUrl(value: string, label: string): URL {
  const text = value.trim();
  if (/[\s\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} must be a single https://chatgpt.com URL.`);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${label} must be an https://chatgpt.com URL.`); }
  if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port || url.username || url.password) throw new Error(`${label} must be an https://chatgpt.com URL without credentials.`);
  return url;
}

function projectIdOf(projectUrl: string): string {
  const match = projectPath.exec(new URL(projectUrl).pathname);
  if (!match?.[1]) throw new Error('Invalid ChatGPT project URL.');
  return match[1].toLowerCase();
}

/** Canonicalizes a ChatGPT project URL to https://chatgpt.com/g/g-p-<32 hex>; throws on anything else. */
export function normalizeProjectUrl(value: string): string {
  const url = chatgptUrl(value, 'Project URL');
  const match = projectPath.exec(url.pathname);
  if (!match?.[1]) throw new Error('Project URL must look like https://chatgpt.com/g/g-p-<32 hex characters>.');
  return `${origin}/g/${match[1].toLowerCase()}`;
}

/**
 * Canonicalizes a ChatGPT conversation URL (query and hash dropped). Without a project only /c/<id> is accepted;
 * with a project only /g/<that project>/c/<id> is accepted.
 */
export function normalizeConversationUrl(value: string, projectUrl: string | null): string {
  const expected = projectUrl === null ? null : projectIdOf(normalizeProjectUrl(projectUrl));
  const url = chatgptUrl(value, 'Conversation URL');
  const match = conversationPath.exec(url.pathname);
  if (!match?.[2]) throw new Error('Conversation URL must look like https://chatgpt.com/c/<id> or https://chatgpt.com/g/g-p-<id>/c/<id>.');
  const scope = match[1]?.toLowerCase() ?? null;
  if (scope !== expected) throw new Error(expected ? 'Conversation does not belong to the assigned ChatGPT project.' : 'Conversation belongs to a ChatGPT project but this contact has none.');
  return `${origin}${scope ? `/g/${scope}` : ''}/c/${match[2]}`;
}

/** Pathname regex source a page must satisfy to count as the destination of a normalized target. */
export function destinationPathPattern(destination: Destination): string {
  const { conversationUrl, projectUrl } = destination;
  if (conversationUrl) {
    const match = conversationPath.exec(new URL(conversationUrl).pathname);
    if (!match?.[2]) throw new Error('Invalid ChatGPT conversation URL.');
    return match[1] ? `^/g/${match[1].toLowerCase()}${slugSegment}/c/${match[2]}$` : `^/c/${match[2]}$`;
  }
  if (projectUrl) return `^/g/${projectIdOf(projectUrl)}${slugSegment}(?:/project)?/?$`;
  return '^/$';
}

/** True when `url` is the saved conversation, the project's new-chat landing, or the ChatGPT home, per `destination`. */
export function isDestination(url: string, destination: Destination): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.origin === origin && new RegExp(destinationPathPattern(destination)).test(parsed.pathname);
}

/** True when `url` is a ChatGPT conversation page of any scope. */
export function isConversationPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && conversationPath.test(parsed.pathname);
  } catch { return false; }
}

/** Reference validation the core applies to persisted and user-supplied project and conversation references. */
export const chatgptReferences: AssistantReferencePolicy = {
  normalizeProject: normalizeProjectUrl,
  normalizeConversation: normalizeConversationUrl,
};
