import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConversationPage, isDestination, normalizeConversationUrl, normalizeProjectUrl } from '../src/adapters/chatgpt/references.js';

const id = 'g-p-00000000000000000000000000000001';
const project = `https://chatgpt.com/g/${id}`;

test('project URLs canonicalize to the bare project ID', () => {
  for (const value of [project, `${project}/`, `${project}-example/project`, `${project}-example/project?x=1#y`, `${project}-example`, ` ${project}-example/project `, `https://chatgpt.com/g/${id.toUpperCase().replace('G-P-', 'g-p-')}`]) {
    assert.equal(normalizeProjectUrl(value), project, value);
  }
});

test('project URLs reject other hosts, schemes, credentials, ports and IDs', () => {
  for (const value of [
    '', 'not a url', `/g/${id}-example/project`, `http://chatgpt.com/g/${id}`, `https://chatgpt.com.evil.example/g/${id}`, `https://www.chatgpt.com/g/${id}`,
    `https://user@chatgpt.com/g/${id}`, `https://user:pw@chatgpt.com/g/${id}`, `https://chatgpt.com:444/g/${id}`,
    'https://chatgpt.com/', 'https://chatgpt.com/g/g-abc', 'https://chatgpt.com/g/g-p-123', `https://chatgpt.com/g/${id}0`, `https://chatgpt.com/g/${id}/c/abc`,
    `https://chatgpt.com/g/${id}/settings`, 'https://chatgpt.com/c/abc', `https://chatgpt.com/g/${id}\n/x`,
  ]) assert.throws(() => normalizeProjectUrl(value), Error, JSON.stringify(value));
});

test('conversation URLs without a project accept only standalone chats and drop query and hash', () => {
  assert.equal(normalizeConversationUrl('https://chatgpt.com/c/00000000-0000-4000-8000-000000000001?model=x#top', null), 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000001');
  assert.throws(() => normalizeConversationUrl(`${project}/c/abc`, null));
  assert.throws(() => normalizeConversationUrl('https://chatgpt.com/c/abc/def', null));
  assert.throws(() => normalizeConversationUrl('https://chatgpt.com/c/', null));
  assert.throws(() => normalizeConversationUrl('https://evil.example/c/abc', null));
});

test('conversation URLs with a project accept only that project, including its slugged form', () => {
  assert.equal(normalizeConversationUrl(`${project}/c/abc-123`, `${project}-example/project`), `${project}/c/abc-123`);
  assert.equal(normalizeConversationUrl(`${project}-example/c/abc-123?x=1`, project), `${project}/c/abc-123`);
  assert.throws(() => normalizeConversationUrl('https://chatgpt.com/c/abc', project));
  assert.throws(() => normalizeConversationUrl('https://chatgpt.com/g/g-p-00000000000000000000000000000002/c/abc', project));
  assert.throws(() => normalizeConversationUrl('https://chatgpt.com/g/g-arbitrary/c/abc', project));
  assert.throws(() => normalizeConversationUrl(`${project}/c/abc`, 'https://chatgpt.com/g/g-arbitrary'));
});

test('destinations match the exact conversation, the same-project landing in any canonical form, or the home page', () => {
  const conversation = `${project}/c/abc`;
  assert.ok(isDestination(`${project}/c/abc`, { conversationUrl: conversation, projectUrl: project }));
  assert.ok(isDestination(`${project}-example/c/abc?x=1`, { conversationUrl: conversation, projectUrl: project }));
  assert.ok(!isDestination(`${project}/c/other`, { conversationUrl: conversation, projectUrl: project }));
  assert.ok(!isDestination('https://chatgpt.com/c/abc', { conversationUrl: conversation, projectUrl: project }));
  assert.ok(isDestination(project, { conversationUrl: null, projectUrl: project }));
  assert.ok(isDestination(`${project}-example/project`, { conversationUrl: null, projectUrl: project }));
  assert.ok(!isDestination('https://chatgpt.com/', { conversationUrl: null, projectUrl: project }));
  assert.ok(!isDestination('https://chatgpt.com/g/g-p-00000000000000000000000000000002-x/project', { conversationUrl: null, projectUrl: project }));
  assert.ok(!isDestination(`${project}/c/abc`, { conversationUrl: null, projectUrl: project }));
  assert.ok(!isDestination('https://chatgpt.com/c/abc', { conversationUrl: null, projectUrl: project }));
  assert.ok(isDestination('https://chatgpt.com/?model=auto', { conversationUrl: null, projectUrl: null }));
  assert.ok(!isDestination(`${project}-example/project`, { conversationUrl: null, projectUrl: null }));
  assert.ok(!isDestination('https://evil.example/', { conversationUrl: null, projectUrl: null }));
  assert.ok(!isDestination('not a url', { conversationUrl: null, projectUrl: null }));
});

test('conversation pages are recognized in either scope', () => {
  assert.ok(isConversationPage('https://chatgpt.com/c/abc'));
  assert.ok(isConversationPage(`${project}/c/abc`));
  assert.ok(isConversationPage(`${project}-example/c/abc`));
  assert.ok(!isConversationPage(`${project}-example/project`));
  assert.ok(!isConversationPage('https://chatgpt.com/'));
  assert.ok(!isConversationPage('https://evil.example/c/abc'));
});
