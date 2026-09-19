import assert from 'node:assert/strict';
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cleanupAfter, startBrowser, stopChild } from '../test-support/browser.mjs';

const CLI = fileURLToPath(new URL('../bin/redpen.mjs', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"><script src="app.js"></script>
<style>body{margin:0;font:16px/1.5 system-ui}#controls{position:fixed;top:0;left:0;right:0;height:60px;background:#eee}
#add{position:absolute;left:10px;top:10px;width:120px;height:40px}#name{position:absolute;left:150px;top:10px;width:160px;height:36px}
#agree{position:absolute;left:330px;top:18px;width:20px;height:20px}main{padding:80px 20px 20px}.spacer{height:1600px}</style></head>
<body><div id="controls"><button id="add" type="button">Add item</button><input id="name"><input id="agree" type="checkbox"></div>
<main><h1 id="title">Live page</h1><p id="status">Static text</p><p id="isolation">Not checked</p><ul id="items"></ul>
<noscript><p id="fallback">Please turn on JavaScript.</p></noscript>
<canvas id="chart" width="120" height="60"></canvas><div class="spacer"></div><p id="end">End of page</p></main>
<script>
document.getElementById('add').addEventListener('click', () => {
  const item = document.createElement('li'); item.textContent = 'Added by JavaScript'; document.getElementById('items').append(item);
});
const context = document.getElementById('chart').getContext('2d'); context.fillStyle = '#c00'; context.fillRect(0, 0, 120, 60);
</script></body></html>`;
const APP = `document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('status').textContent = 'Changed by app.js';
  let parentReachable = true;
  try { void window.parent.document.title; } catch { parentReachable = false; }
  document.getElementById('isolation').textContent = (parentReachable ? 'Parent reachable' : 'Parent blocked') + '; ' + (document.referrer ? 'Referrer sent' : 'No referrer');
});`;

function chromePath() {
  for (const path of [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']) {
    try { if (path) { accessSync(path, constants.X_OK); return path; } } catch { /* Try the next path. */ }
  }
  return null;
}

async function until(check, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch { /* The page may still be loading. */ }
    await pause(40);
  }
  throw new Error('Timed out waiting for ' + description);
}

function startReview(t, cleanup, file, temp) {
  const child = spawn(process.execPath, [CLI, file, '--no-open'], {
    env: { ...process.env, XDG_CONFIG_HOME: join(temp, 'config') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const review = { child, stdout: '', stderr: '', base: null };
  child.stdout.on('data', (chunk) => { review.stdout += chunk; });
  child.stderr.on('data', (chunk) => { review.stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  review.exited = exited;
  review.api = async (path, body) => {
    const response = await fetch(new URL(path + review.base.search, review.base), {
      signal: AbortSignal.timeout(5000), ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.ok, true, path + ' succeeded');
    return response.json();
  };
  cleanup(async () => {
    try {
      const state = await review.api('/session');
      if (state.closed) await review.api('/confirm-close', { requestId: state.history.at(-1)?.requestId });
      else {
        const draft = await review.api('/draft');
        const requestId = 'javascript-switch-test-cleanup';
        await review.api('/submit', { action: 'close', requestId, draftRevision: draft.revision, general: '', annotations: [] });
        await review.api('/confirm-close', { requestId });
      }
    } catch { /* A closed session needs no cleanup. */ }
    await stopChild(child, exited);
  });
  return until(() => {
    const url = review.stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]{32}/)?.[0];
    if (url) review.base = new URL(url);
    return review.base && review;
  }, 'review URL');
}

test('the live page route shares only page files and never the session token', { timeout: 30000 }, async (t) => {
  const cleanup = cleanupAfter(t);
  const temp = mkdtempSync(join(tmpdir(), 'redpen-live-route-'));
  cleanup(() => rmSync(temp, { recursive: true, force: true }));
  writeFileSync(join(temp, 'page.html'), PAGE);
  writeFileSync(join(temp, 'app.js'), APP);
  writeFileSync(join(temp, 'data.json'), '{"secret":true}');
  writeFileSync(join(temp, '.env'), 'SECRET=1');
  writeFileSync(join(temp, '.private.js'), 'window.secret = 1;');
  mkdirSync(join(temp, '.config'));
  writeFileSync(join(temp, '.config', 'theme.css'), 'body { color: red; }');
  writeFileSync(join(temp, 'notes.md'), '# Notes\n\nPlain Markdown.\n');
  const html = await startReview(t, cleanup, join(temp, 'page.html'), temp);
  const token = html.base.searchParams.get('t');
  const { live } = await html.api('/doc');
  assert.match(live, /^\/live\/[a-f0-9]{32}\/page\.html$/);
  assert.equal(live.includes(token), false, 'The live page key differs from the session token');
  const origin = html.base.origin;
  const livePrefix = live.slice(0, live.lastIndexOf('/') + 1);
  const page = await fetch(origin + live);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /^sandbox allow-scripts allow-forms;.*frame-ancestors 'self'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const body = await page.text();
  assert.ok(body.indexOf('redpen-live-snapshot') > body.indexOf('<head>') && body.indexOf('redpen-live-snapshot') < body.indexOf('style.css'), 'The snapshot script runs before page scripts');
  const script = await fetch(origin + livePrefix + 'app.js?v=2');
  assert.deepEqual([script.status, script.headers.get('content-type')], [200, 'text/javascript; charset=utf-8']);
  for (const path of ['data.json', '.env', '.private.js', '.config/theme.css', 'notes.md', 'page.htm', '..%2Fapp.js', 'sub%2Fapp.js', 'missing.js']) {
    assert.equal((await fetch(origin + livePrefix + path)).status, 404, path + ' stays private');
  }
  assert.equal((await fetch(origin + live, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${origin}/doc?t=${live.split('/')[2]}`)).status, 403, 'The live key cannot open session endpoints');

  const markdown = await startReview(t, cleanup, join(temp, 'notes.md'), temp);
  assert.equal((await markdown.api('/doc')).live, null, 'Only HTML reviews get a live page');
  assert.equal((await fetch(markdown.base.origin + '/live/' + '0'.repeat(32) + '/app.js')).status, 403);
});

test('the JavaScript switch runs the page, then keeps its state for commenting', { timeout: 60000 }, async (t) => {
  const chrome = chromePath();
  if (!chrome || typeof WebSocket !== 'function') return t.skip('Chrome or global WebSocket is unavailable');
  const cleanup = cleanupAfter(t);
  const temp = mkdtempSync(join(tmpdir(), 'redpen-javascript-switch-'));
  cleanup(() => rmSync(temp, { recursive: true, force: true }));
  writeFileSync(join(temp, 'page.html'), PAGE);
  writeFileSync(join(temp, 'app.js'), APP);
  writeFileSync(join(temp, 'style.css'), '#status { color: rgb(0, 90, 0); }');
  const review = await startReview(t, cleanup, join(temp, 'page.html'), temp);
  const token = review.base.searchParams.get('t');

  const cdp = await startBrowser(chrome, join(temp, 'profile'), cleanup);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  const evaluate = async (expression, session = sessionId, contextId) => {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, session);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || 'Browser evaluation failed');
    return response.result.value;
  };
  const value = (expression) => evaluate(expression);
  // The live page may run in its own process. Reach it through its own target, or
  // through an isolated world when Chrome keeps it in the review page's process.
  const liveValue = async (expression) => {
    const attached = cdp.events.filter((event) => event.method === 'Target.attachedToTarget' && event.params.targetInfo.type === 'iframe').at(-1);
    if (attached) return evaluate(expression, attached.params.sessionId);
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
    const frame = frameTree.childFrames?.find((child) => child.frame.url.includes('/live/'));
    if (!frame) throw new Error('Live page is not loaded');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frame.frame.id }, sessionId);
    return evaluate(expression, sessionId, executionContextId);
  };
  const mouse = async (point, click = true) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId);
    if (!click) return;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
  };
  const click = async (selector) => mouse(await value(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`));
  const framePoint = (selector) => value(`(() => { const element = reviewRoot.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({ block: 'center' }); const rect = element.getBoundingClientRect(), frame = richFrame.getBoundingClientRect(); return { x: frame.left + rect.left + 12, y: frame.top + rect.top + rect.height / 2 }; })()`);
  const livePoint = async (x, y) => { const rect = await value('liveFrame.getBoundingClientRect().toJSON()'); return { x: rect.left + x, y: rect.top + y }; };
  const press = async (key, code, keyCode, modifiers = 0) => {
    const text = !modifiers && key.length === 1 ? key : undefined;
    await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers }, sessionId);
  };

  await cdp.send('Page.navigate', { url: review.base.href }, sessionId);
  await until(() => value('connected && !!richFrame && docText.includes("Static text")'), 'static HTML review');
  assert.equal(await value('scriptSwitch.hidden'), false, 'HTML reviews show the JavaScript switch');
  assert.equal(await value('reviewRoot.querySelector("#status").textContent'), 'Static text', 'Scripts stay off by default');

  // A comment made before JavaScript runs must survive the switch.
  await mouse(await framePoint('#title'));
  await until(() => value('!popover.hidden'), 'title comment editor');
  await cdp.send('Input.insertText', { text: 'Title comment' }, sessionId);
  await click('#pop-save');
  await until(() => value('annotations.length === 1 && popover.hidden'), 'title comment');

  await click('#script-switch');
  await until(() => value('liveMode && !!liveFrame'), 'live page');
  assert.deepEqual(await value('[liveFrame.getAttribute("sandbox"), liveFrame.src.includes(' + JSON.stringify(token) + '), richFrame.hidden]'), ['allow-scripts allow-forms', false, true]);
  assert.deepEqual(await value('[commentingPaused(), reviseBtn.disabled, closeBtn.disabled, blockToggle.disabled, generalEl.disabled, hintEl.textContent]'),
    [true, true, true, true, false, 'JavaScript is on']);
  assert.equal(await value('document.querySelectorAll("#ink-layer *, #annotation-bands *, #comment-rail-bands *").length'), 0, 'Comment marks are hidden');
  assert.equal(await value('document.querySelector("#list .edit").disabled'), true);

  await until(() => liveValue('document.getElementById("status")?.textContent === "Changed by app.js"'), 'local script in the live page');
  assert.equal(await liveValue('document.getElementById("isolation").textContent'), 'Parent blocked; No referrer');
  assert.equal(await liveValue('getComputedStyle(document.getElementById("status")).color'), 'rgb(0, 90, 0)', 'Local styles load');
  await mouse(await livePoint(70, 30));
  await until(() => liveValue('document.querySelectorAll("#items li").length === 1'), 'item added by a click');
  await mouse(await livePoint(230, 28));
  await cdp.send('Input.insertText', { text: 'Ada' }, sessionId);
  await mouse(await livePoint(340, 28));
  await until(() => liveValue('document.getElementById("name").value === "Ada" && document.getElementById("agree").checked'), 'form input');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...(await livePoint(600, 400)), deltaX: 0, deltaY: 300 }, sessionId);
  const liveScrollY = await until(() => liveValue('window.scrollY'), 'live page scroll');

  await click('#script-switch');
  await until(() => value('!liveMode && !liveSwitching && !renderingUpdate && !liveFrame && !richFrame.hidden'), 'kept page state');
  assert.deepEqual(await value(`(() => {
    const find = (selector) => reviewRoot.querySelector(selector);
    return [find('#status').textContent, find('#items li')?.textContent, find('#name').getAttribute('value'), find('#agree').hasAttribute('checked'),
      find('#chart').localName, /^data:image\\/(png|webp);base64,/.test(find('#chart').getAttribute('src')), !!find('#fallback'),
      reviewRoot.ownerDocument.querySelectorAll('script').length, reviewRoot.querySelectorAll('[data-redpen-scroll]').length];
  })()`), ['Changed by app.js', 'Added by JavaScript', 'Ada', true, 'img', true, false, 0, 0]);
  await until(() => value('reviewRoot.querySelector("#chart").naturalWidth === 120'), 'canvas drawing shown as an image');
  assert.equal(await value('!!reviewRoot.querySelector("[data-redpen-warning]")'), false, 'Scripts that already ran do not add a blocked-script notice');
  assert.ok(Math.abs(await value('docWrap.scrollTop') - liveScrollY) <= 2, 'The scroll position is kept');
  assert.deepEqual(await value('[commentingPaused(), blockToggle.disabled, scriptToggle.checked, annotations.length, !!annotations[0].element, annotations[0].unavailable === true]'),
    [false, false, false, 1, true, false], 'Commenting resumes and the earlier comment still links to its element');

  await mouse(await framePoint('#items li'), false);
  await until(() => value('hoverBlock?.textContent === "Added by JavaScript"'), 'hover on content added by JavaScript');
  await press('c', 'KeyC', 67);
  await until(() => value('!popover.hidden'), 'comment editor from C');
  await cdp.send('Input.insertText', { text: 'Keep this item' }, sessionId);
  await press('Enter', 'Enter', 13, process.platform === 'darwin' ? 4 : 2);
  await until(() => value('annotations.length === 2'), 'comment on content added by JavaScript');

  await click('#close-session');
  assert.equal(await review.exited, 0);
  assert.match(review.stdout, /ACTION: close[\s\S]*Title comment[\s\S]*Added by JavaScript[\s\S]*Keep this item/);
});
