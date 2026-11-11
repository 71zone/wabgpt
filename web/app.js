'use strict';
/* wabgpt owner dashboard. Plain browser JavaScript, no build step. All server text is inserted with textContent only.
 * The owner token is never stored; the session cookie is HttpOnly and the CSRF token lives only in this variable. */
(() => {
  const $ = id => document.getElementById(id);
  const MAX_ROWS = 500;

  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }

  let csrf = null;
  let view = null;
  let activity = [];
  let source = null;
  let reconnectTimer = null;
  let selectedId = null;
  let projects = null;
  let projectsVersion = 0;
  let projectsLoading = false;
  let projectDirty = false;
  let ttlDirty = false;
  let detailFor = null;
  let projectSignature = '';
  let shownQr = null;
  const busyContacts = new Set();
  const rows = new Map();

  const loginPanel = $('login');
  const dashboard = $('dashboard');
  const loginForm = $('login-form');
  const loginToken = $('login-token');
  const loginError = $('login-error');
  const notice = $('notice');
  const list = $('contact-list');
  const projectSelect = $('project-select');
  const ttlInput = $('ttl-input');

  function tone(element, value) { if (value) element.dataset.tone = value; else delete element.dataset.tone; }
  function formatTime(ms) { return new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); }

  async function api(method, path, body) {
    const init = { method, credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      init.headers['X-CSRF-Token'] = csrf || '';
      init.body = JSON.stringify(body ?? {});
    }
    let response;
    try { response = await fetch(path, init); }
    catch { throw new ApiError(0, 'network', 'Could not reach the server.'); }
    let data = null;
    try { data = await response.json(); } catch { /* non-JSON error body */ }
    if (response.status === 401 && path !== '/api/login') showLogin('Your session ended. Sign in again.');
    if (!response.ok) throw new ApiError(response.status, data && data.error, (data && data.message) || `The request failed (${response.status}).`);
    return data;
  }

  function showNotice(message, kind) {
    notice.textContent = message;
    tone(notice, kind);
    notice.hidden = !message;
  }

  /* ---------- session ---------- */

  function showLogin(message) {
    csrf = null; view = null; activity = []; selectedId = null; projects = null; detailFor = null; shownQr = null;
    clearTimeout(reconnectTimer);
    if (source) { source.close(); source = null; }
    for (const row of rows.values()) row.li.remove();
    rows.clear();
    $('activity-log').replaceChildren();
    $('qr-image').removeAttribute('src');
    $('qr-panel').hidden = true;
    showNotice('', '');
    dashboard.hidden = true;
    loginPanel.hidden = false;
    loginError.hidden = !message;
    loginError.textContent = message || '';
    loginToken.focus();
  }

  function showDashboard() {
    loginPanel.hidden = true;
    dashboard.hidden = false;
    connectEvents();
  }

  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = $('login-submit');
    submit.disabled = true;
    loginError.hidden = true;
    try {
      const session = await api('POST', '/api/login', { token: loginToken.value.trim() });
      loginToken.value = '';
      csrf = session.csrfToken;
      showDashboard();
    } catch (error) {
      loginError.textContent = error.message;
      loginError.hidden = false;
    } finally { submit.disabled = false; }
  });

  $('btn-logout').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api('POST', '/api/logout', {});
      showLogin('');
    } catch (error) {
      // A 401 already returned to the login view inside api(). Anything else means the server may not have revoked the session.
      if (error.status !== 401) showNotice(`Sign-out failed: ${error.message} Your session may still be active. Try again.`, 'bad');
    } finally { button.disabled = false; }
  });

  /* ---------- live events ---------- */

  function connectEvents() {
    clearTimeout(reconnectTimer);
    if (source) source.close();
    const connection = $('connection');
    const stream = new EventSource('/api/events');
    source = stream;
    stream.addEventListener('open', () => { connection.textContent = 'Live'; tone(connection, 'ok'); });
    stream.addEventListener('snapshot', event => {
      const data = JSON.parse(event.data);
      activity = data.activity; delete data.activity;
      view = data;
      renderAll(); renderActivityFull();
    });
    stream.addEventListener('state', event => { view = JSON.parse(event.data); renderAll(); });
    stream.addEventListener('activity', event => { addActivity(JSON.parse(event.data)); });
    stream.addEventListener('error', async () => {
      if (source !== stream) return;
      connection.textContent = 'Reconnecting…'; tone(connection, 'warn');
      if (stream.readyState !== EventSource.CLOSED) return;
      source = null;
      try {
        const session = await api('GET', '/api/session');
        if (!session.authenticated) { showLogin('Your session ended. Sign in again.'); return; }
        csrf = session.csrfToken;
      } catch { /* server unreachable: retry below */ }
      if (csrf) reconnectTimer = setTimeout(connectEvents, 3000);
    });
  }

  /* ---------- rendering ---------- */

  function statusTone(kind, status) {
    if (kind === 'channel') {
      if (status === 'open') return 'ok';
      if (status.startsWith('failed') || status === 'logged-out') return 'bad';
      if (status === 'disconnected' || status === 'stopped') return '';
      return 'warn';
    }
    if (status === 'connected') return 'ok';
    if (status === 'failed') return 'bad';
    return status === 'connecting' ? 'warn' : '';
  }

  function renderAll() {
    if (!view) return;
    const { channelName, assistantName } = view.app;
    $('app-names').textContent = `${channelName} → ${assistantName} → ${channelName}`;
    $('channel-label').textContent = channelName;
    $('assistant-label').textContent = assistantName;
    $('channel-status').textContent = view.channelStatus; tone($('channel-status'), statusTone('channel', view.channelStatus));
    $('assistant-status').textContent = view.assistantStatus; tone($('assistant-status'), statusTone('assistant', view.assistantStatus));
    $('forwarding-status').textContent = view.armed ? 'ACTIVE' : 'PAUSED'; tone($('forwarding-status'), view.armed ? 'ok' : 'warn');
    $('enabled-count').textContent = String(view.enabledCount);
    $('btn-connect').textContent = `Connect ${channelName}`;
    $('btn-browser').textContent = `Check ${assistantName}`;
    $('sharing-warning').textContent = `Enabled contacts share their incoming text with ${assistantName} and its reply is sent back automatically. Only direct text messages are forwarded.`;
    renderQr();
    renderContacts();
    renderDetail();
  }

  function renderQr() {
    const qr = view.qr || null;
    $('qr-panel').hidden = !qr;
    if (qr === shownQr) return;
    shownQr = qr;
    if (qr) {
      $('qr-image').src = qr;
      $('qr-help').textContent = `Scan this code with the ${view.app.channelName} app on your phone (Linked devices → Link a device). It refreshes automatically.`;
    } else $('qr-image').removeAttribute('src');
  }

  function contactById(id) { return view && view.contacts.find(contact => contact.id === id); }

  function matches(contact, query, filter) {
    if (filter === 'enabled' && !contact.enabled) return false;
    if (filter === 'contacts' && !contact.saved) return false;
    if (filter === 'chats' && contact.lastMessageAt === null) return false;
    if (!query) return true;
    return contact.name.toLowerCase().includes(query) || contact.id.toLowerCase().includes(query);
  }

  function makeRow(id) {
    const li = document.createElement('li');
    li.dataset.contactId = id;
    const pick = document.createElement('button');
    pick.type = 'button'; pick.className = 'pick';
    const name = document.createElement('span'); name.className = 'name';
    const meta = document.createElement('span'); meta.className = 'meta';
    pick.append(name, meta);
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'toggle';
    pick.addEventListener('click', () => { selectedId = id; renderContacts(); renderDetail(); });
    toggle.addEventListener('click', () => {
      const contact = contactById(id);
      if (contact) setEnabled(contact, !contact.enabled);
    });
    li.append(pick, toggle);
    return { li, pick, name, meta, toggle };
  }

  function renderContacts() {
    const query = $('contact-search').value.trim().toLowerCase();
    const filter = $('contact-filter').value;
    const visible = view.contacts.filter(contact => matches(contact, query, filter));
    const shown = visible.slice(0, MAX_ROWS);
    const ordered = [];
    const keep = new Set();
    for (const contact of shown) {
      let row = rows.get(contact.id);
      if (!row) { row = makeRow(contact.id); rows.set(contact.id, row); }
      keep.add(contact.id);
      row.name.textContent = contact.name;
      const parts = [contact.id, contact.enabled ? 'enabled' : contact.hasRoute ? 'paused' : null, contact.ttl !== '24h' && contact.hasRoute ? `lifetime ${contact.ttl}` : null, contact.unread > 0 ? `${contact.unread} unread` : null, contact.error ? 'needs attention' : null];
      row.meta.textContent = parts.filter(Boolean).join(' · ');
      row.toggle.textContent = contact.enabled ? 'Pause' : 'Enable';
      row.toggle.dataset.enabled = String(contact.enabled);
      row.toggle.disabled = busyContacts.has(contact.id);
      row.toggle.setAttribute('aria-label', `${contact.enabled ? 'Pause' : 'Enable'} ${contact.name}`);
      if (contact.id === selectedId) row.li.setAttribute('aria-current', 'true'); else row.li.removeAttribute('aria-current');
      ordered.push(row.li);
    }
    for (const [id, row] of rows) if (!keep.has(id)) { row.li.remove(); rows.delete(id); }
    const same = list.children.length === ordered.length && ordered.every((li, index) => list.children[index] === li);
    if (!same) list.replaceChildren(...ordered);
    const empty = $('contact-empty');
    if (visible.length > MAX_ROWS) { empty.hidden = false; empty.textContent = `Showing ${MAX_ROWS} of ${visible.length}. Refine the search to see more.`; }
    else { empty.hidden = visible.length > 0; empty.textContent = 'No contacts match.'; }
  }

  function ownersByProject(excludeId) {
    const owners = new Map();
    for (const contact of view.contacts) if (contact.projectRef && contact.id !== excludeId) owners.set(contact.projectRef, contact.name);
    return owners;
  }

  function renderProjectOptions(contact) {
    const owners = ownersByProject(contact.id);
    const signature = [contact.id, contact.projectRef, projectsVersion, [...owners].join('|')].join('\n');
    if (signature === projectSignature) return;
    projectSignature = signature;
    const wanted = projectDirty ? projectSelect.value : (contact.projectRef || '');
    const options = [];
    const add = (value, label, disabled) => {
      const option = document.createElement('option');
      option.value = value; option.textContent = label; option.disabled = Boolean(disabled);
      options.push(option);
    };
    add('', 'No project');
    const known = projects || [];
    for (const project of known) {
      const owner = owners.get(project.ref) || (project.owner && project.owner.id !== contact.id ? project.owner.name : null);
      if (project.ref === contact.projectRef) add(project.ref, `${project.name} (current)`);
      else if (owner) add(project.ref, `${project.name} — in use by ${owner}`, true);
      else add(project.ref, project.name);
    }
    if (contact.projectRef && !known.some(project => project.ref === contact.projectRef)) add(contact.projectRef, projects ? 'Current project (not in your list)' : 'Current project');
    projectSelect.replaceChildren(...options);
    projectSelect.value = options.some(option => option.value === wanted && !option.disabled) ? wanted : (contact.projectRef || '');
    $('project-note').textContent = projects
      ? `${projects.length} project${projects.length === 1 ? '' : 's'} loaded. Projects used by another contact are disabled. Assigning a project never enables forwarding and starts a new conversation.`
      : `Refresh to read your ${view.app.assistantName} projects. This briefly uses a separate browser tab.`;
  }

  function renderDetail() {
    const contact = selectedId === null ? undefined : contactById(selectedId);
    if (!contact) {
      selectedId = null; detailFor = null;
      $('detail-body').hidden = true; $('detail-empty').hidden = false;
      return;
    }
    $('detail-empty').hidden = true; $('detail-body').hidden = false;
    if (detailFor !== contact.id) {
      detailFor = contact.id; projectDirty = false; ttlDirty = false; projectSignature = '';
      ttlInput.value = contact.ttl;
    } else if (!ttlDirty && document.activeElement !== ttlInput) ttlInput.value = contact.ttl;
    $('detail-name').textContent = contact.name;
    const state = $('detail-state');
    state.textContent = contact.enabled ? 'Enabled' : contact.hasRoute ? 'Paused' : 'Not configured';
    tone(state, contact.enabled ? 'ok' : 'warn');
    $('detail-id').textContent = contact.id;
    const error = $('detail-error');
    error.hidden = !contact.error;
    error.textContent = contact.error ? `Stopped: ${contact.error}` : '';
    const conversation = contact.conversation;
    $('detail-conversation').textContent = !conversation.active
      ? `No saved ${view.app.assistantName} conversation. The next message starts one.`
      : `Conversation saved${conversation.startedAt === null ? '' : `, started ${formatTime(conversation.startedAt)}`}. ${conversation.expiresAt === null ? 'Never expires.' : conversation.expired ? 'Past its lifetime; replaced at the next message.' : `Expires ${formatTime(conversation.expiresAt)}.`}`;
    const toggle = $('detail-toggle');
    toggle.textContent = contact.enabled ? 'Pause this contact' : 'Enable this contact';
    toggle.disabled = busyContacts.has(contact.id);
    renderProjectOptions(contact);
    $('project-refresh').disabled = projectsLoading;
  }

  function addActivity(entry) {
    activity.push(entry);
    if (activity.length > 200) activity.shift();
    const log = $('activity-log');
    log.prepend(activityItem(entry));
    while (log.children.length > 200) log.lastElementChild.remove();
  }

  function activityItem(entry) {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date(entry.at).toLocaleTimeString();
    time.dateTime = new Date(entry.at).toISOString();
    item.append(time, document.createTextNode(entry.message));
    return item;
  }

  function renderActivityFull() {
    $('activity-log').replaceChildren(...activity.slice().reverse().map(activityItem));
  }

  /* ---------- commands ---------- */

  async function act(buttons, request, success) {
    const targets = [].concat(buttons).filter(Boolean);
    for (const button of targets) button.disabled = true;
    try {
      const result = await request();
      if (result && result.state) { view = result.state; renderAll(); }
      showNotice(success || '', success ? 'ok' : '');
      return true;
    } catch (error) {
      showNotice(error.message, 'bad');
      return false;
    } finally {
      for (const button of targets) button.disabled = false;
      if (view) renderAll();
    }
  }

  async function setEnabled(contact, enabled) {
    busyContacts.add(contact.id);
    renderContacts(); renderDetail();
    try {
      await act([], () => api('POST', '/api/contacts/enabled', { contactId: contact.id, enabled }), enabled ? `${contact.name} enabled.` : `${contact.name} paused.`);
    } finally { busyContacts.delete(contact.id); if (view) renderAll(); }
  }

  $('btn-connect').addEventListener('click', event => act(event.currentTarget, () => api('POST', '/api/channel/connect', {}), 'Connecting. A pairing code appears here if a login is needed.'));
  $('btn-browser').addEventListener('click', event => act(event.currentTarget, () => api('POST', '/api/browser/check', {}), 'The browser connection and sign-in are ready.'));
  $('btn-resume').addEventListener('click', event => act(event.currentTarget, () => api('POST', '/api/forwarding/resume', {}), 'Forwarding resumed for enabled contacts.'));
  $('btn-pause').addEventListener('click', event => act(event.currentTarget, () => api('POST', '/api/forwarding/pause', {}), 'All forwarding paused.'));

  $('add-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('add-input');
    const value = input.value.trim();
    if (!value) return;
    const ok = await act($('add-submit'), () => api('POST', '/api/contacts', { input: value }), 'Contact added and enabled.');
    if (ok) input.value = '';
  });

  $('contact-search').addEventListener('input', () => { if (view) renderContacts(); });
  $('contact-filter').addEventListener('change', () => { if (view) renderContacts(); });

  $('detail-toggle').addEventListener('click', () => {
    const contact = contactById(selectedId);
    if (contact) setEnabled(contact, !contact.enabled);
  });

  projectSelect.addEventListener('change', () => { projectDirty = true; });
  $('project-refresh').addEventListener('click', async () => {
    projectsLoading = true; $('project-refresh').disabled = true;
    showNotice('Reading projects…', '');
    try {
      const result = await api('GET', '/api/projects');
      projects = result.projects; projectsVersion++; projectSignature = '';
      showNotice('', '');
    } catch (error) { showNotice(error.message, 'bad'); }
    finally { projectsLoading = false; if (view) renderAll(); }
  });
  $('project-save').addEventListener('click', async event => {
    const contact = contactById(selectedId);
    if (!contact) return;
    const ok = await act(event.currentTarget, () => api('POST', '/api/contacts/project', { contactId: contact.id, projectRef: projectSelect.value || null }), `Project saved for ${contact.name}. Forwarding state is unchanged.`);
    if (ok) { projectDirty = false; projectSignature = ''; if (view) renderAll(); }
  });

  ttlInput.addEventListener('input', () => { ttlDirty = true; });
  $('ttl-form').addEventListener('submit', async event => {
    event.preventDefault();
    const contact = contactById(selectedId);
    if (!contact) return;
    const ok = await act($('ttl-save'), () => api('POST', '/api/contacts/ttl', { contactId: contact.id, ttl: ttlInput.value }), `Lifetime saved for ${contact.name}.`);
    if (ok) { ttlDirty = false; ttlInput.value = (contactById(contact.id) || contact).ttl; }
  });

  /* ---------- start ---------- */

  api('GET', '/api/session').then(session => {
    if (session.authenticated) { csrf = session.csrfToken; showDashboard(); } else showLogin('');
  }, error => { showLogin(error.message); });
})();
