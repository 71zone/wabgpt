import blessed from 'blessed';
import type { Application } from '../../core/application.js';
import type { Contact, Project } from '../../core/contracts.js';
import { errorMessage, fit, plain, textWidth, wrap } from './text.js';

type Row =
  | { kind: 'clear'; key: ''; current: boolean }
  | { kind: 'project'; key: string; name: string; ref: string; current: boolean; missing: boolean; owner: string | null; suffix: string };
type Phase = 'loading' | 'ready' | 'error';
interface State {
  target: Contact;
  phase: Phase;
  catalog: Project[];
  error: string;
  query: string;
  mode: 'search' | 'list';
  /** Key of the highlighted row (a project ref, or '' for "no project"); null until the user chooses, so a fresh catalog highlights the first project. */
  selected: string | null;
  notice: string;
  busy: boolean;
  request: number;
}

export interface PickerHooks {
  /** The picker took over input: the dashboard must ignore its own keys and buttons until `closed`. */
  opened(): void;
  /** Called one tick after the picker hid, so the key that closed it never reaches dashboard bindings. */
  closed(): void;
  /** True while another overlay is on top or the app is stopping. */
  blocked(): boolean;
}
export interface ProjectPicker {
  open(target: Contact): void;
  close(): void;
  isOpen(): boolean;
  focus(): void;
  render(): void;
  layout(): void;
}

/**
 * The part of each ref that tells same-named projects apart: refs are opaque, so drop the prefix and suffix every ref in the
 * group shares. Falls back to the whole ref when nothing is left.
 */
function distinguishing(ref: string, group: string[]): string {
  const first = group[0] ?? ref;
  const shortest = Math.min(...group.map(item => item.length));
  let head = 0;
  while (head < shortest && group.every(item => item[head] === first[head])) head++;
  let tail = 0;
  while (tail < shortest - head && group.every(item => item[item.length - 1 - tail] === first[first.length - 1 - tail])) tail++;
  return ref.slice(head, ref.length - tail) || ref;
}

/**
 * Searchable, named assistant-project chooser. It only calls Application.listProjects and Application.setProject for the contact
 * it was opened for; it never enables forwarding and drops catalog results that arrive after it was cancelled.
 */
export function createProjectPicker(screen: blessed.Widgets.Screen, application: Application, hooks: PickerHooks, frame: blessed.Widgets.Border): ProjectPicker {
  const box = blessed.box({ parent: screen, top: 'center', left: 'center', width: 88, height: 28, border: frame, label: ` ${plain(application.metadata.assistantName) || 'Assistant'} project `, hidden: true, tags: true, mouse: true, style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } } });
  const header = blessed.box({ parent: box, top: 0, left: 1, width: 84, height: 3, tags: true, style: { bg: 'black' } });
  const search = blessed.box({ parent: box, top: 3, left: 1, width: 84, height: 1, tags: true, style: { bg: 'black' } });
  const status = blessed.box({ parent: box, top: 4, left: 1, width: 84, height: 1, tags: true, style: { bg: 'black' } });
  const list = blessed.list({ parent: box, top: 5, left: 0, width: 86, height: 15, tags: true, mouse: true, keys: false, scrollbar: { ch: '│' }, style: { bg: 'black', selected: { bg: 'cyan', fg: 'black' }, item: { fg: 'white', bg: 'black' }, scrollbar: { fg: 'gray' } } });
  const hint = blessed.box({ parent: box, top: 22, left: 1, width: 84, height: 1, tags: true, style: { bg: 'black' } });
  const buttonStyle = { fg: 'white', bg: 'blue', focus: { bg: 'cyan', fg: 'black' }, hover: { bg: 'cyan', fg: 'black' } };
  const buttons: blessed.Widgets.ButtonElement[] = [];
  const button = (label: string, left: number, width: number, action: () => void): void => {
    const widget = blessed.button({ parent: box, top: 20, left, width, height: 1, content: label, align: 'center', mouse: true, style: buttonStyle });
    widget.on('press', () => { if (state && !hooks.blocked()) action(); });
    buttons.push(widget);
  };
  const assistant = plain(application.metadata.assistantName) || 'assistant';
  let state: State | null = null;
  let rows: Row[] = [];
  let rendering = false;
  let innerWidth = 84;

  const currentRef = (target: Contact): string | null => application.snapshot().routes.find(route => route.contactId === target.id)?.projectRef ?? null;

  function buildRows(s: State): Row[] {
    const all = application.snapshot().routes;
    const current = all.find(route => route.contactId === s.target.id)?.projectRef ?? null;
    const owners = new Map<string, string>();
    for (const route of all) if (route.projectRef && route.contactId !== s.target.id) owners.set(route.projectRef, plain(route.name) || route.contactId);
    const entries: Array<{ name: string; ref: string; missing: boolean }> = s.phase === 'ready' ? s.catalog.map(project => ({ name: plain(project.name) || 'Untitled project', ref: project.ref, missing: false })) : [];
    if (current && !entries.some(entry => entry.ref === current)) entries.unshift({ name: 'Current project', ref: current, missing: s.phase === 'ready' });
    const groups = new Map<string, string[]>();
    for (const entry of entries) {
      const name = entry.name.toLocaleLowerCase();
      const group = groups.get(name) ?? [];
      if (!group.includes(entry.ref)) group.push(entry.ref);
      groups.set(name, group);
    }
    /** Empty for a unique name; otherwise the shortest trailing part of the distinguishing ref text (at least 6 characters) that no other project with that name shares. */
    const suffixOf = (entry: { name: string; ref: string }): string => {
      const group = groups.get(entry.name.toLocaleLowerCase()) ?? [];
      if (group.length < 2) return '';
      const id = distinguishing(entry.ref, group);
      const others = group.filter(other => other !== entry.ref).map(other => distinguishing(other, group));
      for (let length = 6; length < id.length; length++) {
        if (!others.some(other => other.slice(-length) === id.slice(-length))) return ` #${id.slice(-length)}`;
      }
      return ` #${id}`;
    };
    const tokens = s.query.toLowerCase().split(/\s+/).filter(Boolean);
    const projects: Row[] = [];
    for (const entry of entries) {
      const owner = owners.get(entry.ref) ?? null;
      const haystack = `${entry.name} ${entry.ref} ${owner ?? ''}`.toLowerCase();
      if (!tokens.every(token => haystack.includes(token))) continue;
      projects.push({ kind: 'project', key: entry.ref, name: entry.name, ref: entry.ref, current: entry.ref === current, missing: entry.missing, owner, suffix: suffixOf(entry) });
    }
    return [{ kind: 'clear', key: '', current: current === null }, ...projects];
  }
  function selectedIndex(s: State): number {
    const found = s.selected === null ? -1 : rows.findIndex(row => row.key === s.selected);
    if (found >= 0) return found;
    const current = rows.findIndex(row => row.kind === 'project' && row.current);
    return current >= 0 ? current : rows.length > 1 ? 1 : 0;
  }
  function rowText(row: Row, selected: boolean, width: number): string {
    const paint = (text: string, color: string): string => selected ? blessed.escape(text) : `{${color}-fg}${blessed.escape(text)}{/}`;
    if (row.kind === 'clear') {
      const right = row.current ? 'current' : '';
      const left = fit(`${row.current ? '●' : '○'} No project · standalone chats`, width - textWidth(right) - 2);
      return `${blessed.escape(left)}${' '.repeat(Math.max(1, width - textWidth(left) - textWidth(right)))}${right ? paint(right, 'green') : ''}`;
    }
    const tag = [row.current ? 'current' : '', row.missing ? `not in ${assistant} list` : '', row.owner ? `in use: ${fit(row.owner, 18)}` : ''].filter(Boolean).join(' · ');
    const suffix = row.suffix;
    const marker = row.current ? '●' : row.owner ? '×' : '○';
    const budget = Math.max(6, width - textWidth(tag) - 2);
    const name = fit(`${marker} ${row.name}`, Math.max(4, budget - textWidth(suffix)));
    const gap = ' '.repeat(Math.max(1, width - textWidth(name) - textWidth(suffix) - textWidth(tag)));
    const color = row.owner ? 'gray' : 'white';
    const tagColor = row.current ? 'green' : 'yellow';
    return `${row.owner ? paint(name, color) : blessed.escape(name)}${suffix ? paint(suffix, 'gray') : ''}${gap}${tag ? paint(tag, tagColor) : ''}`;
  }

  function render(): void {
    if (!state || rendering) return;
    const s = state;
    rendering = true;
    try {
      rows = buildRows(s);
      const index = selectedIndex(s);
      const width = innerWidth - 2;
      const current = currentRef(s.target);
      const currentName = current === null ? 'none' : (s.catalog.find(project => project.ref === current)?.name ?? current);
      const title = fit(`Project for ${plain(s.target.name) || s.target.id} · now: ${plain(currentName)}`, innerWidth);
      const warning = wrap(`Use a project set to project-only memory in ${assistant}. Choosing another one starts a new chat on the next message; the old chat is kept. Saving never enables forwarding.`, innerWidth, 2);
      header.setContent([`{bold}${blessed.escape(title)}{/bold}`, ...warning.map(line => `{yellow-fg}${blessed.escape(line)}{/}`)].join('\n'));
      const shownQuery = fit(s.query.length > 0 ? [...s.query].slice(-Math.max(1, innerWidth - 14)).join('') : '', innerWidth - 14);
      const caret = s.mode === 'search' ? '{inverse} {/inverse}' : '';
      search.setContent(`${s.mode === 'search' ? '{cyan-fg}{bold}Search:{/bold}{/} ' : '{gray-fg}Search:{/} '}${blessed.escape(shownQuery)}${caret}${!s.query && s.mode !== 'search' ? '{gray-fg}/ to type{/}' : ''}`);
      const matches = rows.length - 1;
      const total = s.phase === 'ready' ? s.catalog.length : 0;
      status.setContent(s.notice ? `{yellow-fg}${blessed.escape(fit(s.notice, innerWidth))}{/}`
        : s.phase === 'loading' ? `{yellow-fg}${blessed.escape(fit(`Loading projects from ${assistant}… this can take a few seconds.`, innerWidth))}{/}`
          : s.phase === 'error' ? '{red-fg}Could not load the project list.{/}'
            : `{gray-fg}${total} project${total === 1 ? '' : 's'} in ${blessed.escape(assistant)}${s.query ? ` · ${matches} match${matches === 1 ? '' : 'es'}` : ''}{/}`);
      const notes: string[] = [];
      if (s.phase === 'loading') notes.push('Loading… you can still choose "No project" or cancel with Esc.');
      else if (s.phase === 'error') notes.push(...wrap(plain(s.error) || 'Unknown error.', width, 3), 'Press F5 (R in list mode) or click Refresh to try again. No URL is needed.');
      else if (s.catalog.length === 0) notes.push(`${assistant} shows no projects for this account.`, `Create one in ${assistant}, then press F5 to refresh.`);
      else if (matches === 0) notes.push(`No project matches “${fit(s.query, 40)}”. Ctrl-U clears the search.`);
      const items = [...rows.map((row, position) => rowText(row, position === index, width)), ...notes.map(note => `{${s.phase === 'error' ? 'red' : 'gray'}-fg}${blessed.escape(fit(note, width))}{/}`)];
      list.setItems(items);
      list.select(index);
      hint.setContent(`{gray-fg}${blessed.escape(fit(s.mode === 'search'
        ? 'Type to filter · ↑↓ move · Enter assign · Tab list keys · F5 refresh · Esc cancel'
        : '↑↓/J/K move · Enter assign · / search · R refresh · C no project · Tab · Esc cancel', innerWidth))}{/}`);
      screen.render();
    } finally { rendering = false; }
  }

  function load(s: State): void {
    const request = ++s.request;
    s.phase = 'loading'; s.error = ''; s.notice = '';
    render();
    application.listProjects().then(projects => {
      if (state !== s || s.request !== request) return;
      s.catalog = projects; s.phase = 'ready'; render();
    }, (error: unknown) => {
      if (state !== s || s.request !== request) return;
      s.catalog = []; s.phase = 'error'; s.error = errorMessage(error); render();
    });
  }
  function refresh(): void {
    if (!state || state.busy) return;
    if (state.phase === 'loading') { state.notice = 'Already loading the project list…'; render(); return; }
    load(state);
  }
  function close(): void {
    if (!state) return;
    state = null; rows = [];
    box.hide(); screen.render();
    setImmediate(() => hooks.closed());
  }
  function commit(ref: string | null): void {
    const s = state;
    if (!s || s.busy) return;
    s.busy = true; s.notice = 'Saving…'; render();
    Promise.resolve().then(() => application.setProject(s.target, ref)).then(() => { if (state === s) close(); }, (error: unknown) => {
      const message = errorMessage(error);
      application.log(message);
      if (state === s) { s.busy = false; s.notice = message; render(); }
    });
  }
  function assign(): void {
    const s = state;
    if (!s || s.busy) return;
    const row = rows[selectedIndex(s)];
    if (!row) return;
    const current = currentRef(s.target);
    const name = plain(s.target.name) || s.target.id;
    if (row.kind === 'clear') {
      // The pinned row is also the fallback highlight (no match, catalog unavailable); only a deliberate choice (Home, C, click, button, arrows) clears.
      if (s.selected !== '') {
        s.notice = rows.length === 1 && s.query ? 'No project matches the search; nothing changed. Highlight "No project" (Home or C) to clear.' : 'Nothing chosen. Highlight a project, or "No project" (Home or C), then press Enter.';
        render(); return;
      }
      if (current === null) { close(); application.log(`${name} already has no ${assistant} project; nothing changed.`); return; }
      commit(null); return;
    }
    if (row.owner) { s.notice = `Already assigned to ${row.owner}. Pick another project, or clear that contact's project first.`; render(); return; }
    if (row.ref === current) { close(); application.log(`Project unchanged for ${name}.`); return; }
    commit(row.ref);
  }
  function move(delta: number): void {
    if (!state || rows.length === 0) return;
    if (!state.busy) state.notice = '';
    const next = Math.max(0, Math.min(rows.length - 1, selectedIndex(state) + delta));
    state.selected = rows[next]?.key ?? null;
    render();
  }

  function onKey(ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg): void {
    const s = state;
    if (!s || hooks.blocked() || key.full === 'C-c') return;
    const half = Math.max(1, Number(list.height) - 2);
    switch (key.full) {
      case 'escape': close(); return;
      case 'f5': case 'C-r': refresh(); return;
      case 'enter': assign(); return;
      case 'up': move(-1); return;
      case 'down': move(1); return;
      case 'pageup': move(-half); return;
      case 'pagedown': move(half); return;
      case 'home': move(-rows.length); return;
      case 'end': move(rows.length); return;
      case 'tab': s.mode = s.mode === 'search' ? 'list' : 'search'; render(); return;
      default:
    }
    if (s.mode === 'list') {
      if (ch === 'j') move(1);
      else if (ch === 'k') move(-1);
      else if (ch === 'r' || ch === 'R') refresh();
      else if (ch === 'c' || ch === 'C') { s.selected = ''; render(); }
      else if (ch === '/') { s.mode = 'search'; render(); }
      else render();
      return;
    }
    if (key.full === 'backspace') { s.query = [...s.query].slice(0, -1).join(''); }
    else if (key.full === 'C-u') s.query = '';
    else if (key.full === 'C-w') s.query = s.query.replace(/\s*\S*\s*$/, '');
    else if (ch && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(ch) && [...s.query].length < 100) s.query += ch;
    else { render(); return; }
    if (!s.busy) s.notice = '';
    s.selected = null; render();
  }
  screen.on('keypress', onKey);

  list.on('select item', (_item: unknown, index: number) => {
    const s = state;
    if (!s || rendering) return;
    if (index >= rows.length) { list.select(Math.max(0, rows.length - 1)); screen.render(); return; }
    s.selected = rows[index]?.key ?? null;
  });
  list.on('select', (_item: unknown, index: number) => {
    if (!state || rendering || hooks.blocked() || index >= rows.length) return;
    state.selected = rows[index]?.key ?? null;
    assign();
  });
  button(' Refresh F5 ', 1, 14, refresh);
  button(' No project ', 16, 14, () => { if (!state) return; state.selected = ''; render(); assign(); });
  button(' Cancel Esc ', 31, 14, close);

  function layout(): void {
    const width = Math.max(44, Math.min(88, Number(screen.width) - 2));
    const height = Math.max(15, Math.min(28, Number(screen.height) - 2));
    innerWidth = width - 4;
    box.width = width; box.height = height;
    const inner = height - 2;
    for (const part of [header, search, status, hint]) part.width = innerWidth;
    header.height = 3;
    list.width = width - 2; list.height = Math.max(3, inner - 7);
    hint.top = inner - 1;
    for (const widget of buttons) widget.top = inner - 2;
    if (state) render();
  }

  return {
    open(target) {
      if (state) return;
      const current = currentRef(target);
      state = { target: { id: target.id, name: target.name }, phase: 'loading', catalog: [], error: '', query: '', mode: 'search', selected: current, notice: '', busy: false, request: 0 };
      hooks.opened();
      layout();
      box.show(); box.setFront(); box.focus();
      load(state);
    },
    close,
    isOpen: () => state !== null,
    focus: () => { if (state) box.focus(); },
    render,
    layout,
  };
}
