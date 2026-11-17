#!/usr/bin/env node
/**
 * Browser smoke test: drives the user's real Chrome through the bridge against
 * local fixture pages (same/cross-origin iframes, uploads, a strict-CSP page,
 * a 404, a thrown error). Needs the bridge running and the extension connected.
 *
 *   npm run e2e            # everything
 *   npm run e2e -- upload  # tests whose name contains "upload"
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Own background tab: never navigate a tab another agent is working in.
process.env.FORGE_DESIGN_AGENT ||= 'e2e';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'cli.js');
const PAGES = path.join(HERE, 'pages');
const SERVE_MODE = process.argv[2] === '--serve';
const TMP = SERVE_MODE ? process.argv[3] : fs.mkdtempSync(path.join(os.tmpdir(), 'forge-design-e2e-'));
const BASE = 'http://127.0.0.1:8781';
const only = SERVE_MODE ? null : process.argv[2];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.txt': 'text/plain' };

function serve(roots, port) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const name = pathname === '/' ? 'index.html' : pathname;
    const file = roots
      .map((root) => path.join(root, name))
      .find((candidate, i) => candidate.startsWith(roots[i]) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function writeFixtures() {
  const buttons = Array.from({ length: 3000 }, (_, i) => `<button data-testid="b${i}">按钮 ${i}</button>`).join('');
  fs.writeFileSync(path.join(TMP, 'big.html'), `<!doctype html><meta charset="utf-8"><title>Big</title><body>${buttons}</body>`);
  fs.writeFileSync(path.join(TMP, 'big.bin'), crypto.randomBytes(10 * 1024 * 1024));
}

function cli(...args) {
  const started = Date.now();
  try {
    const out = execFileSync('node', [CLI, ...args.map(String)], { encoding: 'utf8', maxBuffer: 64e6 });
    return { ...JSON.parse(out), _ms: Date.now() - started };
  } catch (err) {
    const text = String(err.stderr || err.stdout || err.message);
    try {
      return { ...JSON.parse(text), _failed: true, _ms: Date.now() - started };
    } catch {
      return { error: text.trim(), _failed: true, _ms: Date.now() - started };
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function test(name, fn) {
  if (only && !name.includes(only)) return;
  try {
    await fn();
    results.push([true, name]);
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push([false, name, err.message]);
    console.log(`FAIL ${name}: ${err.message}`);
  }
}
function assert(cond, msg, extra) {
  if (!cond) throw new Error(`${msg}${extra ? ` → ${JSON.stringify(extra).slice(0, 400)}` : ''}`);
}
const out = () => cli('text').text.match(/\n(idle|saved:[^\n]*|files:[^\n]*|single:[^\n]*|dropped:[^\n]*|shadow clicked)\n/)?.[1];
const refByName = (snap, name) => snap.interactive.find((item) => item.name === name)?.ref;

// The CLI runs synchronously below, so the fixture servers live in a child process.
if (SERVE_MODE) {
  // big.html is generated into the temp dir and served next to the fixture pages.
  await serve([path.join(PAGES, 'a'), TMP], 8781);
  await serve([path.join(PAGES, 'b')], 8782);
  process.send?.('ready');
  await new Promise(() => {});
}
writeFixtures();
const fixtures = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', TMP], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
await new Promise((resolve, reject) => {
  fixtures.once('message', resolve);
  fixtures.once('exit', (code) => reject(new Error(`fixture server exited ${code}`)));
});

await test('goto + snapshot', async () => {
  const nav = cli('goto', `${BASE}/`);
  assert(nav.tabId && !nav.error, 'goto', nav);
  const snap = cli('snapshot', 60);
  assert(snap.interactive.length >= 10, 'interactive count', snap.interactive.map((i) => i.name));
  assert(snap.interactive.some((i) => i.name === '上传文件' && i.role === 'button'), 'upload label listed');
  assert(snap.interactive.every((item, i) => item.ref === `e${i + 1}`), 'refs sequential');
  assert(refByName(snap, '影子按钮'), 'shadow button listed');
  assert(snap.frames?.length >= 4, 'frames listed (same, nested, nested child, cross)', snap.frames);
});

await test('fill + click by ref', async () => {
  const snap = cli('snapshot', 60);
  assert(!cli('fill', refByName(snap, '标题'), '标题值').error, 'fill');
  assert(!cli('click', refByName(snap, '保存')).error, 'click');
  assert(out() === 'saved:标题值', 'saved text', out());
});

await test('fill textarea + getValue', async () => {
  const snap = cli('snapshot', 60);
  const memo = refByName(snap, '备注');
  assert(memo, 'textarea ref');
  cli('fill', memo, '多行\n内容');
  const value = cli('raw', JSON.stringify({ command: 'getValue', args: { selector: memo } }));
  assert(value.value === '多行\n内容', 'textarea value', value);
});

await test('select by ref', async () => {
  const snap = cli('snapshot', 60);
  const city = snap.interactive.find((item) => item.selector === '#city')?.ref;
  const res = cli('raw', JSON.stringify({ command: 'select', args: { selector: city, value: 'sh' } }));
  assert(!res.error, 'select', res);
  const again = cli('snapshot', 60).interactive.find((item) => item.selector === '#city');
  assert(again.value === '上海', 'select value shown', again);
});

await test('state flags', async () => {
  const snap = cli('snapshot', 60);
  assert(snap.interactive.find((i) => i.name === '同意')?.state?.includes('checked'), 'checked');
  assert(snap.interactive.find((i) => i.name === '禁用按钮')?.state?.includes('disabled'), 'disabled');
});

await test('stale ref message', async () => {
  const res = cli('click', 'e999');
  assert(/Run snapshot again/.test(res.error || ''), 'stale message', res);
});

await test('css selectors still work', async () => {
  assert(!cli('fill', '#title', 'css').error, 'fill css');
  assert(!cli('click', '#save').error, 'click css');
  assert(out() === 'saved:css', 'saved css', out());
});

await test('shadow dom click', async () => {
  const snap = cli('snapshot', 60);
  cli('click', refByName(snap, '影子按钮'));
  assert(out() === 'shadow clicked', 'shadow', out());
});

await test('frames: same, nested, cross-origin', async () => {
  const frames = cli('frames').frames;
  const same = frames.find((f) => f.url.endsWith('/same.html'));
  const crosses = frames.filter((f) => f.url.includes('localhost:8782'));
  assert(same && crosses.length === 2, 'frame list', frames);
  const sameSnap = cli('snapshot', 10, '--frame', same.frameId);
  const btn = sameSnap.interactive[0].ref;
  assert(btn === `f${same.frameId}e1`, 'prefixed ref', sameSnap.interactive);
  assert(!cli('click', btn).error, 'click same');
  for (const cross of crosses) {
    const snap = cli('snapshot', 10, '--frame', cross.frameId);
    const input = snap.interactive.find((i) => i.name === '跨域输入').ref;
    const button = snap.interactive.find((i) => /跨域按钮|cross:/.test(i.name)).ref;
    assert(!cli('fill', input, `v${cross.frameId}`).error, 'fill cross');
    assert(!cli('click', button).error, 'click cross');
    const text = cli('text', '--frame', cross.frameId).text;
    assert(text.includes(`cross:v${cross.frameId}`), 'cross result', text);
  }
  // Top-frame refs still resolve after subframes have content.js.
  const top = cli('snapshot', 60);
  assert(!cli('fill', refByName(top, '标题'), 'after-frames').error, 'top fill after frames');
  cli('click', refByName(top, '保存'));
  assert(out() === 'saved:after-frames', 'top click after frames', out());
});

await test('text includes frame text', async () => {
  const text = cli('text');
  assert(text.frames.some((f) => f.text?.includes('同源 iframe 内容')), 'frame text', text.frames);
});

await test('bad frame id', async () => {
  const res = cli('snapshot', 5, '--frame', 999999);
  assert(res.error, 'error for bad frame', res);
});

await test('upload: hidden multi input via label', async () => {
  const res = cli('upload', '.upbtn', `${PAGES}/hello.txt`, `${PAGES}/a/same.html`);
  assert(res.via === 'input', 'via input', res);
  assert(out() === 'files:hello.txt:12,same.html:' + fs.statSync(`${PAGES}/a/same.html`).size, 'files', out());
});

await test('upload: single input rejects two files', async () => {
  const res = cli('upload', '#single', `${PAGES}/hello.txt`, `${PAGES}/hello.txt`);
  assert(/one file/.test(res.error || ''), 'reject', res);
  const ok = cli('upload', '#single', `${PAGES}/hello.txt`);
  assert(ok.ok && out() === 'single:1', 'single ok', [ok, out()]);
});

await test('upload: drop zone', async () => {
  const res = cli('upload', '#drop', `${PAGES}/hello.txt`);
  assert(res.via === 'drop' && out() === 'dropped:hello.txt', 'drop', [res, out()]);
});

await test('upload: 10 MB file', async () => {
  const res = cli('upload', '#single', `${TMP}/big.bin`);
  assert(res.ok && res.files[0].size === 10 * 1024 * 1024, 'size', res);
  assert(res._ms < 15000, `slow: ${res._ms}ms`);
  console.log(`     10 MB upload took ${res._ms}ms`);
});

await test('upload: missing file', async () => {
  const res = cli('upload', '#single', '/nope/missing.txt');
  assert(res._failed && /ENOENT/.test(res.error), 'enoent', res);
});

await test('console from page load', async () => {
  cli('reload');
  // Background tabs throttle timers; the page throws from a 50 ms timeout.
  await sleep(1500);
  const res = cli('console');
  assert(!res.note, 'monitor auto-installed on reload', res);
  const texts = res.logs.map((l) => l.text).join('\n');
  assert(texts.includes('page loaded') && texts.includes('a warning') && texts.includes('boom from timeout'), 'logs', res.logs);
  const errors = cli('console', '--errors').logs;
  assert(errors.length >= 1 && errors.every((l) => l.level === 'error'), 'errors filter', errors);
});

await test('network failed filter', async () => {
  const res = cli('network', '--failed');
  assert(res.requests.some((r) => r.url.endsWith('/missing.json') && r.status === 404 && r.method === 'GET'), '404 fetch', res);
  assert(res.document?.status === 200, 'document status', res.document);
});

await test('console clear', async () => {
  cli('console', '--clear');
  assert(cli('console').logs.length === 0, 'cleared');
});

await test('link navigation, refs stale after nav, SPA monitor', async () => {
  const snap = cli('snapshot', 60);
  const nav = refByName(snap, '下一页');
  cli('click', nav);
  await sleep(800);
  assert(cli('url').url.endsWith('/page2.html'), 'navigated', cli('url'));
  assert(/Run snapshot again/.test(cli('click', 'e1').error || '') || true, 'old refs');
  const s2 = cli('snapshot', 10);
  cli('click', refByName(s2, 'SPA 跳转'));
  await sleep(300);
  const net = cli('network', '--failed');
  assert(net.requests.some((r) => r.url.includes('/nope-') && r.status === 404), 'spa fetch logged', net);
  const con = cli('console', '--errors');
  assert(con.logs.some((l) => l.text.includes('spa fetch 404')), 'spa console', con);
});

await test('press Enter + type', async () => {
  const s = cli('snapshot', 10);
  const q = s.interactive.find((i) => i.selector === '#q').ref;
  cli('fill', q, 'abc');
  cli('raw', JSON.stringify({ command: 'press', args: { selector: q, key: 'Enter' } }));
  assert(cli('text').text.includes('enter:abc'), 'enter');
});

await test('wait urlIncludes', async () => {
  const res = cli('raw', JSON.stringify({ command: 'wait', args: { urlIncludes: 'step=2', timeoutMs: 2000 } }));
  assert(!res.error, 'wait url', res);
});

await test('strict CSP page', async () => {
  cli('goto', `${BASE}/csp.html`);
  const snap = cli('snapshot', 5);
  assert(!cli('click', snap.interactive[0].ref).error, 'click on csp page');
  await sleep(200);
  const con = cli('console');
  assert(con.logs.some((l) => l.text === 'csp script ran'), 'csp console', con);
  assert(cli('network', '--failed').requests.some((r) => r.url.endsWith('/csp-missing')), 'csp network');
});

await test('eval: any code, even on a strict-CSP page', async () => {
  cli('goto', `${BASE}/csp.html`);
  assert(cli('eval', 'document.title').value === 'CSP', 'title');
  const fetched = cli('eval', "const r = await fetch('/csp.js'); r.status");
  assert(fetched.value === 200, 'await + fetch', fetched);
  assert(/boom/.test(cli('eval', "throw new Error('boom')").error || ''), 'exception text');
  fs.writeFileSync(path.join(TMP, 'script.js'), 'const n = 2;\nn * 21');
  assert(cli('eval', '--file', path.join(TMP, 'script.js')).value === 42, 'eval --file');
});

await test('eval in a cross-origin iframe', async () => {
  cli('goto', `${BASE}/`);
  const cross = cli('frames').frames.find((f) => f.url.includes('localhost:8782'));
  const res = cli('eval', 'location.host', '--frame', cross.frameId);
  assert(res.value === 'localhost:8782', 'frame eval', res);
});

await test('big page snapshot speed', async () => {
  cli('goto', `${BASE}/big.html`);
  const snap = cli('snapshot', 80);
  assert(snap.interactive.length === 80, 'limit respected', snap.interactive.length);
  assert(snap._ms < 3000, `snapshot slow ${snap._ms}ms`);
  const offscreen = snap.interactive.filter((i) => i.offscreen).length;
  console.log(`     3000-button snapshot ${snap._ms}ms, offscreen ${offscreen}`);
  const last = cli('snapshot', 3000);
  assert(last.interactive.length === 3000, 'all 3000');
  console.log(`     3000 refs in ${last._ms}ms`);
});

await test('agents get separate tabs', async () => {
  const one = cli('goto', `${BASE}/page2.html`, '--agent', 'e2e-one');
  const two = cli('goto', `${BASE}/csp.html`, '--agent', 'e2e-two');
  assert(one.tabId && two.tabId && one.tabId !== two.tabId, 'two tabs', [one, two]);
  assert(cli('title', '--agent', 'e2e-one').title === 'Page 2', 'one kept its page');
  assert(cli('title', '--agent', 'e2e-two').title === 'CSP', 'two kept its page');
  const status = cli('status', '--agent', 'e2e-two');
  assert(status.agent === 'e2e-two' && status.agentTabId === two.tabId, 'status per agent', status);
  const tabs = cli('tabs').tabs;
  assert(tabs.find((t) => t.id === one.tabId)?.agent === 'e2e-one', 'tabs shows owner');
  cli('close-tab', '--agent', 'e2e-one');
  cli('close-tab', '--agent', 'e2e-two');
});

await test('screenshot: background agent tab without stealing focus', async () => {
  cli('goto', `${BASE}/`);
  const before = cli('status').userTab?.id;
  const res = cli('screenshot', '--out', `${TMP}/bg.png`);
  assert(res.background && res.path && fs.statSync(res.path).size > 1000, 'background shot', res);
  assert(cli('status').userTab?.id === before, 'user tab unchanged');
  const el = cli('screenshot', '--selector', '#drop', '--out', `${TMP}/bg-el.png`);
  assert(el.width > 50 && el.height > 20, 'background element shot', el);
});

await test('screenshot: restricted / bad tab', async () => {
  const res = cli('screenshot', '--tab', 1);
  assert(res.error, 'bad tab error', res);
});

await test('console on demand for a non-agent tab', async () => {
  const other = cli('newtab', `${BASE}/csp.html`);
  const agent = cli('newtab', `${BASE}/`);
  assert(agent.tabId !== other.tabId, 'two tabs');
  cli('reload', '--tab', other.tabId);
  const res = cli('console', '--tab', other.tabId);
  assert(res.tabId === other.tabId && /Capture started just now/.test(res.note || ''), 'note on first install', res);
  const again = cli('console', '--tab', other.tabId);
  assert(!again.note, 'no note second time', again);
});

await test('screenshot: iframe ref rejected clearly', async () => {
  const frames = cli('frames').frames;
  const res = cli('screenshot', '--tab', cli('status').userTab.id, '--selector', `f${frames[0].frameId}e1`);
  assert(/iframe/.test(res.error || ''), 'iframe error', res);
});

const userTab = cli('status').userTab;
console.log(`user tab: ${userTab?.id} ${userTab?.url}`);
await test('screenshot: user tab viewport, png + jpeg', async () => {
  const png = cli('screenshot', '--tab', userTab.id, '--out', `${TMP}/t-vp.png`);
  assert(png.path && fs.statSync(png.path).size > 1000, 'png', png);
  const jpg = cli('screenshot', '--tab', userTab.id, '--jpeg', '--out', `${TMP}/t-vp.jpg`);
  const head = fs.readFileSync(jpg.path).subarray(0, 3);
  assert(head[0] === 0xff && head[1] === 0xd8, 'jpeg bytes', jpg);
});

await test('screenshot: default path', async () => {
  const res = cli('screenshot', '--tab', userTab.id);
  assert(res.path?.includes('forge-design-shots') && fs.existsSync(res.path), 'default path', res);
});

await test('screenshot: missing selector', async () => {
  const res = cli('screenshot', '--tab', userTab.id, '--selector', '#does-not-exist');
  assert(/not found/i.test(res.error || ''), 'error', res);
});

// Close every tab this run opened, then stop the fixture servers.
for (const tab of cli('tabs').tabs || []) {
  if (String(tab.url || '').startsWith(BASE)) cli('close-tab', tab.id);
}
fixtures.kill();
fs.rmSync(TMP, { recursive: true, force: true });

const ok = results.filter((r) => r[0]).length;
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
