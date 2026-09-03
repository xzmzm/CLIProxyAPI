'use strict';
const $ = id => document.getElementById(id);
const state = {page:1, pages:1, view:'chat', rawSource:'api', treeSource:'api', selected:null, parsed:null, listVersion:0, detailVersion:0};
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const formatSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MiB' : (n / 1024).toFixed(1) + ' KiB';
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
const downloadURL = name => '/logs/api/entries/' + encodeURIComponent(name) + '/raw';
async function getJSON(path) {
  const response = await fetch(path, {cache:'no-store', credentials:'same-origin'});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to load logs (HTTP ' + response.status + ').');
  return data;
}

async function loadList() {
  const version = ++state.listVersion;
  $('refresh').disabled = true;
  $('error').hidden = true;
  $('count').textContent = 'Loading requests…';
  try {
    const data = await getJSON('/logs/api/entries?page=' + state.page + '&q=' + encodeURIComponent($('search').value));
    if (version !== state.listVersion) return;
    state.page = data.page;
    state.pages = data.pages;
    $('entries').replaceChildren();
    for (const entry of data.entries) {
      const row = element('tr');
      const values = [entry.id, new Date(entry.time).toLocaleString(), entry.url || entry.name, entry.model || '—', entry.transport, entry.status || '—', entry.duration ? entry.duration.toFixed(2) + ' s' : '—', formatSize(entry.size)];
      values.forEach((value, i) => {
        const cell = element('td', null, i === 2 ? 'endpoint' : i === 0 ? 'mono' : '');
        if (i === 2) { cell.append(element('span', entry.method, 'method')); cell.title = entry.url || entry.name; }
        if (i === 4 || i === 5) {
          cell.append(element('span', value, 'badge ' + (i === 4 ? entry.transport === 'Stream' ? 'stream' : '' : entry.status >= 400 ? 'failure' : entry.status >= 200 && entry.status < 300 ? 'success' : '')));
        } else cell.append(document.createTextNode(value));
        row.append(cell);
      });
      const actions = element('td');
      const button = element('button', 'View details');
      button.addEventListener('click', () => openDetail(entry));
      actions.append(button);
      row.append(actions);
      $('entries').append(row);
    }
    $('empty').hidden = data.total !== 0;
    $('empty').textContent = $('search').value ? 'No matching requests.' : 'No request logs found. Enable request-log in config.yaml to record requests. Logs forwarded to Home are not stored locally.';
    $('count').textContent = data.total + (data.total === 1 ? ' request' : ' requests');
    $('page-label').textContent = 'Page ' + state.page + ' of ' + state.pages;
    $('previous').disabled = state.page <= 1;
    $('next').disabled = state.page >= state.pages;
  } catch (error) {
    if (version !== state.listVersion) return;
    $('error').textContent = error.message;
    $('error').hidden = false;
    $('count').textContent = 'Failed to refresh';
  } finally {
    if (version === state.listVersion) $('refresh').disabled = false;
  }
}

async function openDetail(entry) {
  const version = ++state.detailVersion;
  state.selected = entry;
  state.parsed = null;
  $('detail-meta').textContent = entry.id + ' · ' + (entry.method || '') + ' ' + (entry.url || entry.name);
  $('download').href = downloadURL(entry.name);
  $('download').download = entry.name;
  $('content').replaceChildren(element('p', 'Loading request details…', 'empty'));
  if (!$('detail').open) $('detail').showModal();
  try {
    const data = await getJSON('/logs/api/entries/' + encodeURIComponent(entry.name));
    if (version !== state.detailVersion) return;
    state.selected = data.entry;
    state.parsed = LogParser.parse(data.sections);
    renderView();
  } catch (error) {
    if (version === state.detailVersion) $('content').replaceChildren(element('p', error.message, 'error'));
  }
}

function folded(title, child, open = false) {
  const node = element('details', null, 'fold');
  node.open = open;
  node.append(element('summary', title), child);
  return node;
}

function renderChat() {
  const node = element('div', null, 'chat');
  const entry = state.selected;
  const params = element('div', null, 'params');
  params.append(element('strong', 'Request parameters'), element('span', 'Model: ' + (entry.model || '—')), element('span', entry.transport), element('span', 'Status: ' + (entry.status || 'not recorded')));
  node.append(params);
  const requests = Array.isArray(state.parsed.request) ? state.parsed.request : [state.parsed.request];
  const tools = requests.flatMap(r => r?.tools || []);
  if (tools.length) {
    const toolList = element('div');
    toolList.className = 'tool-definitions';
    tools.forEach(tool => {
      const definition = element('div');
      const description = tool.description || tool.function?.description;
      if (description) definition.append(LogMarkdown.render(description));
      definition.append(folded('Definition', tree(tool)));
      toolList.append(folded(tool.name || tool.function?.name || tool.type || 'Tool', definition));
    });
    const available = folded('Available tools (' + tools.length + ')', toolList);
    available.classList.add('available-tools');
    node.append(available);
  }
  const messages = state.parsed.chat;
  if (!messages.length) node.append(element('p', 'No chat format detected. Inspect Tree or Raw view for the complete recorded data.', 'empty'));
  // Bound initial DOM work for very large conversations; every message remains accessible.
  let shown = 0;
  const more = element('button', 'Show more messages', 'load-more');
  function appendBatch() {
    more.remove();
    const end = Math.min(shown + 100, messages.length);
    for (; shown < end; shown++) {
      const message = messages[shown];
      const role = ['user','assistant','system','developer','tool','tool-call','reasoning','error'].includes(message.role) ? message.role : 'assistant';
      const block = element('article', null, 'message ' + role);
      const names = {system:'System prompt', developer:'Developer prompt', user:'User', assistant:'Assistant', tool:'Tool result', 'tool-call':'Tool call', reasoning:'Reasoning', error:'Error'};
      const title = message.label && message.label !== message.role ? message.label : names[role];
      const heading = element('header', null, 'message-header');
      heading.append(element('h3', title));
      if (message.id) heading.append(element('span', message.id, 'call-id mono'));
      block.append(heading);
      const body = element('div', null, 'message-body');
      const isTool = role === 'tool' || role === 'tool-call';
      const content = () => isTool ? element('pre', message.text, 'tool-payload') : LogMarkdown.render(message.text);
      // Render long content on expansion, not while building every collapsed message.
      if (message.text.length > 12000 || role === 'reasoning') {
        const container = element('div');
        const fold = folded('Expand ' + (isTool ? 'payload' : 'message') + ' · ' + message.text.length.toLocaleString() + ' characters', container);
        let rendered = false;
        fold.addEventListener('toggle', () => {
          if (fold.open && !rendered) { rendered = true; container.append(content()); }
        });
        body.append(fold);
      } else body.append(content());
      block.append(body);
      node.append(block);
    }
    if (shown < messages.length) { more.textContent = 'Show more messages (' + (messages.length - shown) + ' remaining)'; node.append(more); }
  }
  more.addEventListener('click', appendBatch);
  appendBatch();
  return node;
}

function tree(value, key = 'root', depth = 0) {
  const wrapper = element('div', null, 'tree-node');
  if (value == null || typeof value !== 'object') {
    wrapper.append(element('span', key + ': ', 'tree-key'), element('span', pretty(value), 'tree-value'));
    return wrapper;
  }
  const items = Object.entries(value);
  const details = element('details');
  const summary = element('summary');
  summary.append(element('span', key, 'tree-key'), document.createTextNode(Array.isArray(value) ? ' [' + items.length + ']' : ' {' + items.length + '}'));
  details.append(summary);
  let built = false;
  function build() {
    if (built || !details.open) return;
    built = true;
    let offset = 0;
    const more = element('button', 'Show more fields');
    const batch = () => {
      more.remove();
      const end = Math.min(offset + 100, items.length);
      for (; offset < end; offset++) details.append(tree(items[offset][1], items[offset][0], depth + 1));
      if (offset < items.length) details.append(more);
    };
    more.addEventListener('click', batch);
    batch();
  }
  details.addEventListener('toggle', build);
  if (depth < 2) { details.open = true; build(); }
  wrapper.append(details);
  return wrapper;
}

function panel(title, node, className = '') {
  const wrapper = element('section', null, 'panel ' + className);
  const body = element('div');
  body.append(node);
  wrapper.append(element('h3', title), body);
  return wrapper;
}

function foldedTree(title, value) {
  const container = element('div');
  const fold = folded(title, container);
  let built = false;
  fold.addEventListener('toggle', () => {
    if (fold.open && !built) { built = true; container.append(tree(value)); }
  });
  return fold;
}

function treeRecords(records, emptyNote) {
  if (!records.length) return element('p', emptyNote, 'view-note');
  const wrapper = element('div', null, 'tree-records');
  records.forEach(record => {
    const block = element('section', null, 'tree-record');
    block.append(element('h4', record.name));
    if (record.metadata) block.append(foldedTree('Headers & metadata', record.metadata));
    block.append(tree(record.body, 'body'));
    if (record.events?.length) block.append(foldedTree('Original events (' + record.events.length + ')', record.events));
    wrapper.append(block);
  });
  return wrapper;
}

function renderExchange(view) {
  const sourceKey = view + 'Source';
  const isTree = view === 'tree';
  const wrapper = element('div');
  const toolbar = element('div', null, 'raw-toolbar');
  const tabs = element('div', null, 'tabs raw-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', (isTree ? 'Tree' : 'Raw') + ' traffic source');
  const note = element('p', null, 'view-note');
  const content = element('div');
  content.id = view + '-exchange';
  content.setAttribute('role', 'tabpanel');
  content.tabIndex = 0;
  const buttons = [];
  function renderSource() {
    buttons.forEach(button => {
      const active = button.dataset.source === state[sourceKey];
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    content.setAttribute('aria-labelledby', view + '-tab-' + state[sourceKey]);
    const api = state[sourceKey] === 'api';
    note.textContent = (api ? 'Proxy ↔ upstream provider. ' : 'Client ↔ proxy. ') + (isTree ? 'Expand JSON fields. Streamed responses are consolidated per recorded attempt; original sections remain available below.' : api ? 'Upstream headers, payloads, retries, and errors exactly as recorded.' : 'The original incoming request and response returned to the client.');
    const data = LogParser[isTree ? 'treeExchange' : 'rawExchange'](state.parsed.sections, state[sourceKey]);
    const columns = element('div', null, isTree ? 'columns' : 'columns raw-columns');
    const body = (value, side) => {
      const missing = 'No ' + (api ? 'API ' : 'proxy ') + side + ' section was recorded.' + (data.timeline.length ? ' See the WebSocket timeline below.' : '');
      return isTree ? treeRecords(value, missing) : value ? element('pre', value, 'raw-text') : element('p', missing, 'view-note');
    };
    columns.append(panel(api ? 'API request' : 'Proxy request', body(data.request, 'request')), panel(api ? 'API response' : 'Proxy response', body(data.response, 'response'), 'response'));
    content.replaceChildren(columns);
    if (data.timeline.length) content.append(panel(api ? 'API WebSocket timeline' : 'Proxy WebSocket timeline', isTree ? treeRecords(data.timeline) : element('pre', data.timeline, 'raw-text'), 'timeline-panel'));
    if (isTree && data.sections.length) {
      const records = element('div', null, 'section-list');
      data.sections.forEach(s => records.append(foldedTree(s.name, s.text)));
      content.append(folded('Recorded ' + (api ? 'API' : 'proxy') + ' sections (' + data.sections.length + ')', records));
    }
    if (data.other.length) {
      const other = element('div', null, 'section-list');
      data.other.forEach(s => other.append(folded(s.name, element('pre', s.text, 'raw-text'))));
      content.append(other);
    }
  }
  for (const source of ['api', 'client']) {
    const button = element('button', source === 'api' ? 'API (upstream)' : 'Proxy');
    button.id = view + '-tab-' + source;
    button.dataset.source = source;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', content.id);
    button.addEventListener('click', () => { state[sourceKey] = source; renderSource(); });
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      state[sourceKey] = event.key === 'Home' ? 'api' : event.key === 'End' ? 'client' : state[sourceKey] === 'api' ? 'client' : 'api';
      renderSource();
      buttons.find(b => b.dataset.source === state[sourceKey]).focus();
    });
    buttons.push(button);
    tabs.append(button);
  }
  toolbar.append(tabs, note);
  wrapper.append(toolbar, content);
  renderSource();
  return wrapper;
}

function renderView() {
  document.querySelectorAll('[data-view]').forEach(tab => {
    const selected = tab.dataset.view === state.view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  $('content').setAttribute('aria-labelledby', 'tab-' + state.view);
  if (!state.parsed) return;
  $('content').replaceChildren(state.view === 'chat' ? renderChat() : renderExchange(state.view));
  $('content').scrollTop = 0;
}
document.querySelectorAll('[data-view]').forEach(tab => {
  tab.addEventListener('click', () => { state.view = tab.dataset.view; renderView(); });
  tab.addEventListener('keydown', event => {
    const views = ['chat','tree','raw'];
    let index = views.indexOf(state.view);
    if (event.key === 'ArrowRight') index = (index + 1) % 3;
    else if (event.key === 'ArrowLeft') index = (index + 2) % 3;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = 2;
    else return;
    event.preventDefault();
    state.view = views[index]; renderView(); $('tab-' + state.view).focus();
  });
});
$('close').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('close', () => { state.detailVersion++; state.parsed = null; $('content').replaceChildren(); });
$('fullscreen').addEventListener('click', () => { const active = $('detail').classList.toggle('fullscreen'); $('fullscreen').setAttribute('aria-pressed', String(active)); });
$('refresh').addEventListener('click', loadList);
$('previous').addEventListener('click', () => { state.page--; loadList(); });
$('next').addEventListener('click', () => { state.page++; loadList(); });
let searchTimer;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.page = 1; loadList(); }, 250); });
loadList();
