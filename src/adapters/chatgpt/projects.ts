import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import type { Logger, Project } from '../../core/contracts.js';
import { normalizeProjectUrl } from './references.js';

/**
 * Page script (runs through BrowserOS evaluateInPage in the ChatGPT home page) that reads the sidebar Projects section.
 * 'read' only observes. 'expand' clicks the section's own show-more control (never the per-project chat "Show more"). 'toggle' clicks the section's collapse toggle.
 */
export const projectSidebarScript = String.raw`(mode) => {
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const label = element => clean(element.getAttribute('aria-label') || element.textContent);
  const rows = Array.from(document.querySelectorAll('[data-app-action-sidebar-project-id]'));
  const projects = rows.map(row => {
    const labelled = (row.getAttribute('aria-labelledby') || '').split(/\s+/)[0];
    const named = labelled ? document.getElementById(labelled) : null;
    return { id: row.getAttribute('data-app-action-sidebar-project-id') || '', name: clean(row.getAttribute('data-app-action-sidebar-project-label') || (named && named.textContent)) };
  });
  const section = (rows[0] && rows[0].closest('section[data-app-action-sidebar-section-heading]')) || document.querySelector('section[data-app-action-sidebar-section-heading="Projects"]');
  const header = section ? section.querySelector('[data-app-action-sidebar-section-toggle]') : null;
  const more = section ? Array.from(section.querySelectorAll('button,[role="button"],a')).filter(control =>
    !control.closest('[data-sidebar-project-kind]') && !control.hasAttribute('data-app-action-sidebar-section-toggle') && /^(show more|see more|show all|view all)$/i.test(label(control))) : [];
  if (mode === 'expand') { const target = more[0]; if (target) target.click(); return { clicked: !!target }; }
  if (mode === 'toggle') { if (header) header.click(); return { clicked: !!header }; }
  const loginControl = Array.from(document.querySelectorAll('a,button')).some(control => control.getAttribute('data-testid') === 'login-button' || /^(log in|sign in|sign up|sign up for free)$/i.test(label(control)));
  const challenge = /just a moment|verify you are human/i.test(document.title || '') || !!document.querySelector('#challenge-form,iframe[src*="challenges.cloudflare.com"]');
  return {
    url: location.href,
    loginRequired: loginControl || /\/auth\/|auth\.openai\.com|\/log-?in\b/.test(location.href),
    challenge,
    sidebar: !!document.querySelector('nav'),
    header: header ? { expanded: header.getAttribute('aria-expanded') === 'true' } : null,
    sectionKnown: rows.length === 0 || (!!section && rows.every(row => section.contains(row))),
    more: more.length,
    projects,
  };
}`;

const sidebarSchema = z.object({
  url: z.string(),
  loginRequired: z.boolean(),
  challenge: z.boolean(),
  sidebar: z.boolean(),
  header: z.object({ expanded: z.boolean() }).nullable(),
  sectionKnown: z.boolean(),
  more: z.number(),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
});
type SidebarProbe = z.infer<typeof sidebarSchema>;

/** Page script for ChatGPT's /projects explorer: counts real project rows (they carry several action buttons; the "Locked chats" row has one). */
export const projectExplorerScript = String.raw`() => {
  const clean = value => (value || '').replace(/\s+/g, ' ').trim();
  const label = element => clean(element.getAttribute('aria-label') || element.textContent);
  const rows = Array.from(document.querySelectorAll('[data-project-row]'));
  const last = rows[rows.length - 1];
  if (last && last.scrollIntoView) last.scrollIntoView({ block: 'end' });
  const loginControl = Array.from(document.querySelectorAll('a,button')).some(control => control.getAttribute('data-testid') === 'login-button' || /^(log in|sign in|sign up|sign up for free)$/i.test(label(control)));
  const challenge = /just a moment|verify you are human/i.test(document.title || '') || !!document.querySelector('#challenge-form,iframe[src*="challenges.cloudflare.com"]');
  return {
    loginRequired: loginControl || /\/auth\/|auth\.openai\.com|\/log-?in\b/.test(location.href),
    challenge,
    ready: !!document.querySelector('[data-projects-rows]') && Array.from(document.querySelectorAll('h1')).some(heading => /^projects$/i.test(clean(heading.textContent))),
    projects: rows.filter(row => row.querySelectorAll('button').length > 1).length,
  };
}`;
const explorerSchema = z.object({ loginRequired: z.boolean(), challenge: z.boolean(), ready: z.boolean(), projects: z.number() });
type ExplorerProbe = z.infer<typeof explorerSchema>;
const evaluated = z.object({ value: z.unknown() });

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Canonicalizes sidebar rows into the sorted, unique catalog; throws on rows it cannot name or address rather than dropping them. */
export function mergeProjects(rows: { id: string; name: string }[]): Project[] {
  const byRef = new Map<string, Project>();
  for (const row of rows) {
    const name = row.name.replace(/\s+/g, ' ').trim();
    let ref: string;
    try { ref = normalizeProjectUrl(`https://chatgpt.com/g/${row.id}`); }
    catch { throw new Error(`ChatGPT's project list contains an entry with an unrecognised id (${JSON.stringify(row.id)}). Update wabgpt before choosing a project.`); }
    if (!name) throw new Error('ChatGPT\'s project list contains a project without a readable name. Update wabgpt before choosing a project.');
    if (!byRef.has(ref)) byRef.set(ref, { name, ref });
  }
  return [...byRef.values()].sort((a, b) => collator.compare(a.name, b.name) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

const readyTimeoutMs = 45_000;
const pollMs = 750;
const maxExpansions = 20;
const restoreTimeoutMs = 10_000;
const stableReadsToConfirmMismatch = 6;
// A first read after navigation can precede ChatGPT's own fetch, so an answer is accepted only once successive reads agree.
const stableReadsWithProjects = 2;
const stableReadsWithoutProjects = 4;

const signedOut = 'ChatGPT is signed out in BrowserOS. Sign in there, then refresh the project list.';
const challenged = 'ChatGPT is showing a verification challenge in BrowserOS. Complete it there, then refresh the project list.';

/** Runs one BrowserOS script in the catalog's scratch session; `signal` cancels that one request. */
export type CatalogRun = (code: string, signal?: AbortSignal) => Promise<unknown>;

async function evaluate(run: CatalogRun, pageId: number, script: string, mode: string, settle: boolean, signal?: AbortSignal): Promise<unknown> {
  return evaluated.parse(await run(`const page=browser.page(${pageId});return await page.evaluateInPage(${script},${JSON.stringify(mode)},${settle ? '{settle:true}' : '{}'});`, signal)).value;
}

/**
 * Puts the Projects section back to collapsed after the catalog expanded it: ChatGPT persists that presentation state across tabs, so it must not outlive the lookup.
 * This is cleanup and deliberately ignores the caller's (possibly already aborted) signal; it is bounded by its own timeout, which cancels the request in flight and the sleeps.
 */
async function restoreCollapsed(run: CatalogRun, pageId: number): Promise<void> {
  const bound = AbortSignal.timeout(restoreTimeoutMs);
  const deadline = Date.now() + restoreTimeoutMs;
  let clicked = false;
  while (Date.now() < deadline) {
    const state = sidebarSchema.parse(await evaluate(run, pageId, projectSidebarScript, 'read', false, bound));
    if (!state.header) throw new Error('the Projects toggle disappeared');
    if (!state.header.expanded) return;
    if (!clicked) { await evaluate(run, pageId, projectSidebarScript, 'toggle', true, bound); clicked = true; }
    await setTimeout(pollMs / 3, undefined, { signal: bound });
  }
  throw new Error('the section did not collapse');
}

async function readSidebar(run: CatalogRun, pageId: number, warn: Logger, signal?: AbortSignal): Promise<Project[]> {
  const deadline = Date.now() + readyTimeoutMs;
  let previous = '';
  let stable = 0;
  let expansions = 0;
  let expandedByUs = false;
  let last: SidebarProbe | null = null;
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      last = sidebarSchema.parse(await evaluate(run, pageId, projectSidebarScript, 'read', false, signal));
      if (last.loginRequired) throw new Error(signedOut);
      if (last.challenge) throw new Error(challenged);
      if (!last.sectionKnown) throw new Error('Could not locate the Projects section of the ChatGPT sidebar. ChatGPT\'s layout may have changed; update wabgpt.');
      if (last.header && !last.header.expanded) {
        // Collapsed sections render no rows. Expand in this scratch tab only; the finally below restores it.
        if (!expandedByUs) { expandedByUs = true; await evaluate(run, pageId, projectSidebarScript, 'toggle', true, signal); }
        previous = ''; stable = 0;
        await setTimeout(pollMs, undefined, { signal }); continue;
      }
      if (last.more > 0) {
        // Revealing the rest is its own step; the list is only trusted again after a later read shows no show-more control and a settled row set.
        if (++expansions > maxExpansions) throw new Error('ChatGPT\'s Projects list kept offering "Show more" after repeated expansion; the catalog would be incomplete. Refresh the project list.');
        await evaluate(run, pageId, projectSidebarScript, 'expand', true, signal);
        previous = ''; stable = 0;
        await setTimeout(pollMs, undefined, { signal }); continue;
      }
      const ready = last.sidebar && last.header !== null;
      const signature = JSON.stringify(last.projects);
      stable = ready && signature === previous ? stable + 1 : 0;
      previous = signature;
      if (ready && stable + 1 >= (last.projects.length ? stableReadsWithProjects : stableReadsWithoutProjects)) return mergeProjects(last.projects);
      await setTimeout(pollMs, undefined, { signal });
    }
    if (last && !last.sidebar) throw new Error('ChatGPT did not finish loading in BrowserOS (no sidebar). Check the page and refresh the project list.');
    if (last?.header && !last.header.expanded) throw new Error('The Projects section of the ChatGPT sidebar would not expand. Refresh the project list.');
    throw new Error('ChatGPT\'s project list did not finish loading in time. Refresh the project list.');
  } finally {
    if (expandedByUs) {
      try { await restoreCollapsed(run, pageId); }
      catch (error) { warn(`Could not collapse the ChatGPT Projects section again after listing projects (${error instanceof Error ? error.message : String(error)}). Collapse it manually if you prefer it closed.`); }
    }
  }
}

/** Requires ChatGPT's full /projects explorer to list exactly `expected` projects, so a truncated sidebar or an early or stale explorer cannot validate the catalog. */
async function verifyExplorerCount(run: CatalogRun, pageId: number, expected: number, signal?: AbortSignal): Promise<void> {
  await run(`await browser.page(${pageId}).goto('https://chatgpt.com/projects');return true;`, signal);
  const deadline = Date.now() + readyTimeoutMs;
  let previous = -1;
  let stable = 0;
  let last: ExplorerProbe | null = null;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    last = explorerSchema.parse(await evaluate(run, pageId, projectExplorerScript, 'read', false, signal));
    if (last.loginRequired) throw new Error(signedOut);
    if (last.challenge) throw new Error(challenged);
    stable = last.ready && last.projects === previous ? stable + 1 : 0;
    previous = last.projects;
    if (last.ready && last.projects === expected && stable + 1 >= (expected ? stableReadsWithProjects : stableReadsWithoutProjects)) return;
    // A different count may still be the explorer catching up; only a long-stable disagreement is a verdict.
    if (last.ready && last.projects !== expected && stable + 1 >= stableReadsToConfirmMismatch) break;
    await setTimeout(pollMs, undefined, { signal });
  }
  if (last?.ready) throw new Error(`ChatGPT's Projects page lists ${last.projects} projects but ${expected} were read from the sidebar. The catalog would be wrong or incomplete; refresh the project list.`);
  throw new Error('ChatGPT\'s Projects page did not finish loading in time, so the project list cannot be verified as complete. Refresh the project list.');
}

/**
 * Reads the full project catalog through an already-open ChatGPT home tab (page id in the BrowserOS session behind `run`).
 * Resolves only for a complete, positively identified list; every login, challenge, unreadable, mismatched or not-ready state throws.
 * A collapsed Projects section is expanded for the read and collapsed again afterwards, even on failure or cancellation.
 * The tab is navigated to the /projects explorer afterwards, so the caller owns it exclusively.
 * `signal` cancels every request and poll wait; the collapse-again cleanup is independently bounded and never uses it. Cancellation rejects with the signal's reason or an AbortError.
 */
export async function readProjectCatalog(run: CatalogRun, pageId: number, warn: Logger, signal?: AbortSignal): Promise<Project[]> {
  const projects = await readSidebar(run, pageId, warn, signal);
  await verifyExplorerCount(run, pageId, projects.length, signal);
  return projects;
}
