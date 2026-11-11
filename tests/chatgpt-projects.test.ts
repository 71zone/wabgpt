import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { mergeProjects, projectExplorerScript, projectSidebarScript } from '../src/adapters/chatgpt/projects.js';

const idA = `g-p-${'a'.repeat(32)}`;
const idB = `g-p-${'B'.repeat(32)}`;

test('rows merge into canonical, case-insensitively sorted, unique projects', () => {
  assert.deepEqual(mergeProjects([{ id: idB, name: 'beta   project' }, { id: idA, name: ' Alpha ' }, { id: idA.toUpperCase().replace('G-P-', 'g-p-'), name: 'Alpha again' }]), [
    { name: 'Alpha', ref: `https://chatgpt.com/g/${idA}` },
    { name: 'beta project', ref: `https://chatgpt.com/g/${idB.toLowerCase()}` },
  ]);
});

test('a row without a valid id or a name is an error, never silently dropped', () => {
  assert.throws(() => mergeProjects([{ id: 'not-a-project', name: 'X' }]), /unrecognised id/);
  assert.throws(() => mergeProjects([{ id: idA, name: '   ' }]), /without a readable name/);
});

test('the sidebar script reads names from the label attribute, then from aria-labelledby, and only clicks the Projects-level Show more', () => {
  const html = `<nav><section data-app-action-sidebar-section-heading="Projects"><button id="toggle" data-app-action-sidebar-section-toggle aria-expanded="true">Projects</button>
    <div data-sidebar-project-kind="local"><div data-app-action-sidebar-project-id="${idA}" data-app-action-sidebar-project-label="Alpha"></div><button id="chat">Show more</button></div>
    <div data-sidebar-project-kind="local"><div data-app-action-sidebar-project-id="${idB.toLowerCase()}" aria-labelledby="name-b"></div><span id="name-b"> Beta </span></div>
    <button id="section">Show more</button></section></nav>`;
  const { document } = parseHTML(html);
  const clicks: string[] = [];
  for (const id of ['chat', 'section', 'toggle']) document.getElementById(id)?.addEventListener('click', () => { clicks.push(id); });
  // Page results cross a vm realm; JSON-normalise them like the real MCP boundary before comparing.
  const run = (mode: string): unknown => JSON.parse(JSON.stringify(runInNewContext(`(${projectSidebarScript})(${JSON.stringify(mode)})`, { document, location: { href: 'https://chatgpt.com/' } })));
  assert.deepEqual(run('read'), {
    url: 'https://chatgpt.com/', loginRequired: false, challenge: false, sidebar: true, header: { expanded: true }, sectionKnown: true, more: 1,
    projects: [{ id: idA, name: 'Alpha' }, { id: idB.toLowerCase(), name: 'Beta' }],
  });
  assert.deepEqual(run('expand'), { clicked: true });
  assert.deepEqual(clicks, ['section']);
  assert.deepEqual(run('toggle'), { clicked: true });
  assert.deepEqual(clicks, ['section', 'toggle']);
});

test('the explorer script counts project rows but not the Locked chats row', () => {
  const rows = (count: number): string => Array.from({ length: count }, () => '<div data-project-row="true"><button>Toggle</button><button>Actions</button></div>').join('');
  const { document } = parseHTML(`<h1>Projects</h1><div data-projects-rows><div data-project-row="true"><button>Locked chats</button></div>${rows(3)}</div>`);
  const observed: unknown = JSON.parse(JSON.stringify(runInNewContext(`(${projectExplorerScript})()`, { document, location: { href: 'https://chatgpt.com/projects' } })));
  assert.deepEqual(observed, { loginRequired: false, challenge: false, ready: true, projects: 3 });
});
