const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const marked = require('./assets/vendor/marked.umd.js');
const createPurifier = require('./assets/vendor/purify.min.js');
const {createRenderer} = require('./assets/markdown.js');

function setup(t) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'http://localhost:8317/logs'});
  t.after(() => dom.window.close());
  const purifier = createPurifier(dom.window);
  return {document:dom.window.document, render:createRenderer(dom.window.document, marked, purifier)};
}

test('Markdown headings, emphasis, nested lists, code, tables, quotes, and tasks', t => {
  const {render} = setup(t);
  const node = render('# Heading\n\nA **bold** and *emphasized* paragraph with `code`.\n\n- First\n  - Nested\n- Second\n\n1. Ordered\n2. Next\n\n> Quote\n\n```js\nconst x = "<script>";\n```\n\n| Name | Value |\n| --- | --- |\n| Test | 42 |\n\n- [x] Done\n- [ ] Pending\n');
  assert.equal(node.querySelector('h1').textContent, 'Heading');
  assert.equal(node.querySelector('strong').textContent, 'bold');
  assert.equal(node.querySelector('em').textContent, 'emphasized');
  assert.equal(node.querySelector('ul ul li').textContent, 'Nested');
  assert.equal(node.querySelectorAll('ol li').length, 2);
  assert.match(node.querySelector('blockquote').textContent, /Quote/);
  assert.equal(node.querySelector('pre code').textContent.trim(), 'const x = "<script>";');
  assert.equal(node.querySelector('.markdown-table table td').textContent, 'Test');
  const tasks = node.querySelectorAll('input');
  assert.equal(tasks.length, 2);
  assert.ok([...tasks].every(input => input.disabled && input.type === 'checkbox'));
  assert.ok(tasks[0].checked);
});

test('No logged HTML, event handlers, embedded media, forms, or clobbering IDs', t => {
  const {render} = setup(t);
  const input = '<script>alert(1)</script>\n\n<img src="https://private.example/pixel" onerror="alert(2)">\n\n<svg onload="alert(3)"></svg>\n\n<iframe srcdoc="<script>alert(4)</script>"></iframe>\n\n<form id="content"><input name="close"></form>\n\n<style>body{display:none}</style>\n\n![Secret](https://private.example/pixel)\n';
  const node = render(input);
  assert.equal(node.querySelectorAll('script,img,svg,iframe,form,style,object,embed').length, 0);
  assert.equal(node.querySelectorAll('[id],[name],[src],[onerror],[onload]').length, 0);
  assert.match(node.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(node.textContent, /Attachment: Secret/);
});

test('Link destinations stay visible while only safe external URLs are clickable', t => {
  const {render} = setup(t);
  const node = render('[Safe](https://example.com/docs) [Mail](mailto:person@example.com) [JS](javascript:alert%281%29) [Data](data:text/html,test) [Relative](/logs/api/entries) [Protocol-relative](//evil.example/pixel) [Encoded](javascript&#58;alert%281%29)');
  const links = [...node.querySelectorAll('a[href]')];
  assert.deepEqual(links.map(a => a.getAttribute('href')), ['https://example.com/docs','mailto:person@example.com']);
  assert.ok(links.every(a => a.target === '_blank' && a.rel === 'noopener noreferrer'));
  const targets = [...node.querySelectorAll('.link-target')].map(target => target.textContent);
  assert.equal(targets.length, 7);
  assert.ok(targets.some(target => target.includes('/logs/api/entries')));
  assert.ok(targets.some(target => target.includes('javascript:')));
  assert.equal(node.querySelectorAll('a:not([href])').length, 5);
});

test('Relative Markdown file links render both their label and path', t => {
  const {render} = setup(t);
  const node = render('- [System Paths & Device Files](./memories/system-paths-device-files.md)');
  const item = node.querySelector('li');
  assert.match(item.textContent, /System Paths & Device Files/);
  assert.match(item.textContent, /\.\/memories\/system-paths-device-files\.md/);
  assert.equal(item.querySelector('a').hasAttribute('href'), false);
  assert.equal(item.querySelector('.link-target').textContent, ' (./memories/system-paths-device-files.md)');
});

test('Sanitizer failure falls back to literal text', t => {
  const {document} = setup(t);
  const render = createRenderer(document, marked, {isSupported:false});
  const node = render('# Heading\n<script>unsafe()</script>');
  assert.equal(node.querySelector('h1'), null);
  assert.equal(node.querySelector('script'), null);
  assert.match(node.querySelector('pre').textContent, /<script>/);
});

test('Viewer stylesheet carries the Management Center shell, tokens, and motion', () => {
  const css = fs.readFileSync(path.join(__dirname, 'assets/management.css'), 'utf8');
  for (const token of ['--bg-primary: #fff','--bg-secondary: #fff','--bg-tertiary: #f6f6f6','--text-primary: #2d2a26','--primary: #8b8680','--border: #e5e5e5']) {
    const managementToken = token.replace('--primary:', '--primary-color:').replace('--border:', '--border-color:');
    assert.match(css, new RegExp(managementToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(css, /--ease-out-strong:\s*cubic-bezier\(\.23, 1, \.32, 1\)/);
  assert.match(css, /--sidebar-panel-width:\s*216px/);
  assert.match(css, /\.header-actions\s*\{[^}]*backdrop-filter:\s*blur\(16px\)/s);
  assert.match(css, /\.request-card\s*\{[^}]*animation:\s*request-card-in 450ms/s);
  assert.match(css, /dialog\[open\]\s*\{[^}]*animation:\s*modal-scale-in 350ms/s);
  assert.match(css, /\.nav-item:hover\s*\{[^}]*transform:\s*translateX\(1px\)/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
test('Viewer renders Markdown chat and separates API/Proxy in Tree and Raw with keyboard navigation', async t => {
  const html = fs.readFileSync(path.join(__dirname, 'assets/index.html'), 'utf8');
  const dom = new JSDOM(html, {url:'http://localhost:8317/logs', runScripts:'outside-only'});
  t.after(() => dom.window.close());
  const win = dom.window;
  const doc = win.document;
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new win.Event('close')); };
  const entry = {name:'v1-responses-2026-09-03T100000-test.log',id:'test',time:'2026-09-03T10:00:00Z',method:'POST',url:'/v1/responses',model:'test',transport:'HTTP',status:200,duration:1,size:1000};
  const sections = [
    {name:'REQUEST BODY',text:JSON.stringify({input:[{role:'user',content:[
      {type:'input_text',text:'## Question\n\n**Please** explain.'},
      {type:'input_image',image_url:'data:image/png;base64,aGVsbG8='},
      {type:'input_image',image_url:'https://images.example/screenshot.png'}
    ]},{type:'function_call',name:'run',arguments:'{"text":"# literal"}',call_id:'c1'}]})},
    {name:'API REQUEST 1',text:'POST upstream\nBody:\n{"model":"provider-model"}\n'},
    {name:'API ERROR RESPONSE',text:'HTTP Status: 429\nquota\n'},
    {name:'API REQUEST 2',text:'POST retry\n'},
    {name:'API RESPONSE 2',text:'Status: 200\n\nupstream-result\n'},
    {name:'RESPONSE',text:'Status: 200\n\n'+JSON.stringify({output:[{role:'assistant',content:'# Answer\n\n- One\n- Two\n\n```js\nconst safe = true;\n```'}]})}
  ];
  win.fetch = async url => ({ok:true,json:async () => String(url).includes('?') ? {entries:[entry],page:1,pages:1,total:1} : {entry,sections}});
  for (const file of ['vendor/marked.umd.js','vendor/purify.min.js','parser.js','markdown.js','viewer.js']) {
    win.eval(fs.readFileSync(path.join(__dirname, 'assets', file), 'utf8'));
  }
  await nextTurn();
  doc.querySelector('#sidebar-toggle').click();
  assert.ok(doc.querySelector('.app-shell').classList.contains('sidebar-is-collapsed'));
  assert.equal(doc.querySelector('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(doc.querySelector('#sidebar-toggle').getAttribute('aria-label'), 'Expand sidebar');
  doc.querySelector('#entries button').click();
  await nextTurn();
  assert.equal(doc.querySelector('.message.user h2').textContent, 'Question');
  assert.equal(doc.querySelector('.message.user strong').textContent, 'Please');
  const embeddedImage = doc.querySelector('.message.user .chat-image img');
  assert.equal(embeddedImage.getAttribute('src'), 'data:image/png;base64,aGVsbG8=');
  assert.equal(embeddedImage.loading, 'lazy');
  const externalFigure = [...doc.querySelectorAll('.message.user .chat-image')].find(figure => figure.querySelector('button'));
  assert.match(externalFigure.textContent, /External image · images\.example/);
  assert.equal(externalFigure.querySelector('img'), null);
  externalFigure.querySelector('button').click();
  assert.equal(externalFigure.querySelector('img').getAttribute('src'), 'https://images.example/screenshot.png');
  assert.equal(externalFigure.querySelector('img').referrerPolicy, 'no-referrer');
  assert.equal(doc.querySelector('.message.assistant h1').textContent, 'Answer');
  assert.equal(doc.querySelectorAll('.message.assistant li').length, 2);
  assert.match(doc.querySelector('.tool-payload').textContent, /# literal/);
  assert.equal(doc.querySelector('.tool-call .markdown-body'), null);
  doc.querySelector('#tab-tree').click();
  assert.equal(doc.querySelector('#tree-tab-api').getAttribute('aria-selected'), 'true');
  assert.equal(doc.querySelector('#tree-tab-api').textContent, 'API (upstream)');
  assert.equal(doc.querySelector('#tree-tab-client').textContent, 'Proxy');
  let tree = doc.querySelector('#tree-exchange').textContent;
  assert.match(tree, /provider-model/);
  assert.match(tree, /API REQUEST 2/);
  assert.match(tree, /API ERROR RESPONSE/);
  assert.match(tree, /quota/);
  assert.match(tree, /upstream-result/);
  assert.doesNotMatch(tree, /Please/);
  doc.querySelector('#tree-tab-api').dispatchEvent(new win.KeyboardEvent('keydown',{key:'End',bubbles:true}));
  assert.equal(doc.querySelector('#tree-tab-client').getAttribute('aria-selected'), 'true');
  assert.equal(doc.activeElement.id, 'tree-tab-client');
  assert.equal(doc.querySelector('#tree-exchange').getAttribute('aria-labelledby'), 'tree-tab-client');
  tree = doc.querySelector('#tree-exchange').textContent;
  assert.match(tree, /Proxy request/);
  assert.match(tree, /REQUEST BODY/);
  assert.match(tree, /RESPONSE/);
  assert.doesNotMatch(tree, /provider-model|upstream-result|quota/);
  // Expand the nested proxy request to inspect the original user message.
  for (let depth = 0; depth < 6; depth++) {
    for (const details of doc.querySelectorAll('.tree-record .tree-node details')) {
      if (!details.open) { details.open = true; details.dispatchEvent(new win.Event('toggle')); }
    }
  }
  assert.match(doc.querySelector('#tree-exchange').textContent, /Please/);
  doc.querySelector('#tree-tab-client').dispatchEvent(new win.KeyboardEvent('keydown',{key:'Home',bubbles:true}));
  assert.equal(doc.activeElement.id, 'tree-tab-api');
  assert.match(doc.querySelector('#tree-exchange').textContent, /provider-model/);
  assert.doesNotMatch(doc.querySelector('#tree-exchange').textContent, /Please/);
  doc.querySelector('#tab-raw').click();
  assert.equal(doc.querySelector('#raw-tab-api').getAttribute('aria-selected'), 'true');
  let raw = doc.querySelector('#raw-exchange').textContent;
  assert.match(raw, /API request/);
  assert.match(raw, /API ERROR RESPONSE/);
  assert.match(raw, /API REQUEST 2/);
  assert.match(raw, /upstream-result/);
  assert.doesNotMatch(raw, /Please/);
  doc.querySelector('#raw-tab-api').dispatchEvent(new win.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  assert.equal(doc.querySelector('#raw-tab-client').getAttribute('aria-selected'), 'true');
  assert.equal(doc.activeElement.id, 'raw-tab-client');
  raw = doc.querySelector('#raw-exchange').textContent;
  assert.match(raw, /Proxy request/);
  assert.match(raw, /Please/);
  assert.doesNotMatch(raw, /upstream-result/);
  doc.querySelector('#tab-tree').click();
  assert.equal(doc.querySelector('#tree-tab-api').getAttribute('aria-selected'), 'true');
  assert.match(doc.querySelector('#tree-exchange').textContent, /provider-model/);
});
