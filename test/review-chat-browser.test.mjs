import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CLI = fileURLToPath(new URL('../bin/redpen.mjs', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description = 'browser state') {
  const end = Date.now() + 15000;
  while (Date.now() < end) { try { const value = await check(); if (value) return value; } catch { /* Navigation can replace the execution context. */ } await pause(50); }
  throw new Error('Timed out waiting for ' + description);
}
function command(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr })); });
  return { child, exited, errors: () => stderr };
}
class Cdp {
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Browser closed')); } this.pending.clear(); this.socket.close(); }
}

function chromePath() {
  return [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((path) => {
    try { if (path) { accessSync(path, constants.X_OK); return true; } } catch { /* Check another installation. */ }
    return false;
  });
}

function content(format, changed = false) {
  const paragraphs = [changed ? 'Updated target sentence.' : 'Original target sentence.', 'Keep this reference.', changed ? 'Replacement draft section.' : 'Draft target disappears.'];
  if (format === 'html') return '<!doctype html><html><body><h1>Review conversation</h1>' + paragraphs.map((text, i) => `<p id="target-${i}">${text}</p>`).join('') + '</body></html>';
  return (format === 'md' ? '# Review conversation\n\n' : 'Review conversation\n\n') + paragraphs.join('\n\n');
}

test('review chat keeps immutable history, safe references, and pending drafts in every document format', { timeout: 120000 }, async (t) => {
  const chrome = chromePath();
  if (!chrome || typeof WebSocket !== 'function') return t.skip('Chrome or global WebSocket is unavailable');
  const temp = mkdtempSync(join(tmpdir(), 'redpen-chat-browser-'));
  const env = { ...process.env, XDG_CONFIG_HOME: join(temp, 'config') };
  const profile = join(temp, 'profile');
  const browser = spawn(chrome, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const browserExit = new Promise((resolve) => browser.once('exit', resolve));
  let cdp;
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    cdp?.close(); browser.kill(); await browserExit; rmSync(temp, { recursive: true, force: true });
  });
  const port = await until(() => existsSync(join(profile, 'DevToolsActivePort')) && readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0], 'Chrome startup');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  cdp = new Cdp(socket);

  for (const format of ['md', 'txt', 'html']) {
    const file = join(temp, 'review.' + format); writeFileSync(file, content(format));
    const initial = command([file, '--no-open'], env);
    const base = new URL(await until(() => initial.errors().match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+/)?.[0], 'review startup'));
    cleanups.push(async () => {
      try {
        writeFileSync(file, content(format));
        const state = await (await fetch(new URL('/session' + base.search, base))).json();
        const post = (path, body) => fetch(new URL(path + base.search, base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (state.closed) await post('/confirm-close', { requestId: state.history.at(-1)?.requestId });
        else {
          if (state.waiting) await post('/reply', { turn: state.nextTurn - 1, message: 'Test cleanup.' });
          const savedDraft = await (await fetch(new URL('/draft' + base.search, base))).json();
          const requestId = 'review-chat-test-cleanup';
          if ((await post('/submit', { action: 'close', requestId, draftRevision: savedDraft.revision,
            general: '', annotations: [] })).ok) await post('/confirm-close', { requestId });
        }
      } catch { /* Closed sessions need no cleanup. */ }
      initial.child.kill(); await initial.exited;
    });
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const session = attached.sessionId;
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, session);
    const value = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Browser evaluation failed');
      return result.result.value;
    };
    await cdp.send('Page.navigate', { url: base.href }, session);
    await until(() => value('connected && !!reviewState && docText.includes("Original target sentence.")'), 'initial review');
    assert.equal(await value('document.querySelectorAll("#history .message").length'), 0);
    assert.equal(await value('document.querySelector("link[rel=icon]").href.includes("/pen.svg?t=")'), true);
    assert.equal(await value('document.querySelector("header .brand").textContent'), 'redpen');
    assert.equal(await value('document.querySelector("#general").getBoundingClientRect().bottom <= document.querySelector("#revise").getBoundingClientRect().top'), true);
    if (format === 'html') await value('document.querySelector("#block-toggle").click()');
    async function annotate(text, comment) {
      if (format === 'html' && text !== 'Original target sentence.') {
        await value(`(() => {
          document.querySelector('#block-toggle').click();
          const element = [...reviewRoot.querySelectorAll('p')].find(node => node.textContent === ${JSON.stringify(text)});
          element.dispatchEvent(new reviewWindow.MouseEvent('mousemove', { bubbles: true }));
          element.dispatchEvent(new reviewWindow.MouseEvent('click', { bubbles: true }));
        })()`);
        await until(() => value('!document.querySelector("#popover").hidden'), 'element comment');
        await value(`document.querySelector('#pop-comment').value=${JSON.stringify(comment)}; document.querySelector('#pop-save').click(); document.querySelector('#block-toggle').click()`);
        return;
      }
      await value(`(() => {
        const root = reviewRoot, walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node; while ((node = walker.nextNode())) { const start = node.data.indexOf(${JSON.stringify(text)}); if (start < 0) continue;
          const range = root.ownerDocument.createRange(); range.setStart(node, start); range.setEnd(node, start + ${text.length});
          const selection = root.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          node.parentElement.dispatchEvent(new (root.ownerDocument.defaultView.MouseEvent)('mouseup', { bubbles: true })); break;
        }
      })()`);
      await until(() => value('!document.querySelector("#add-btn").hidden'), 'selection comment button');
      await value(`document.querySelector('#add-btn').click(); document.querySelector('#pop-comment').value=${JSON.stringify(comment)}; document.querySelector('#pop-save').click()`);
    }
    await annotate('Original target sentence.', 'Clarify this wording.');
    await annotate('Keep this reference.', 'Keep this example.');
    await value('generalEl.value="Can you clarify this?"; generalEl.dispatchEvent(new Event("input",{bubbles:true}))');
    await until(() => value('document.querySelectorAll("#ink-layer path, #ink-layer rect[data-annotation-id]").length >= 2'), 'draft underlines');
    await value('document.querySelector("#revise").click()');
    await until(() => value('reviewState.waiting && !submitting && document.querySelectorAll("#history .user").length === 1'), 'submitted history');
    assert.equal((await initial.exited).code, 0);
    assert.deepEqual(await value('[annotations.length, document.querySelectorAll("#ink-layer path, #ink-layer rect, #annotation-bands rect").length, document.querySelectorAll("#history .edit, #history .del, #history textarea").length, document.querySelector("#history details").open]'), [0, 0, 0, false]);
    assert.equal(await value('getComputedStyle(document.querySelector(".message.user")).alignSelf'), 'flex-end');
    if (format === 'txt') await value('window.originalStorageSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new DOMException("Storage blocked", "SecurityError"); }');
    await value('generalEl.value="My next draft"; generalEl.dispatchEvent(new Event("input",{bubbles:true}))');
    assert.deepEqual(await value('[reviseBtn.disabled, closeBtn.disabled, generalEl.disabled, annotations.length]'), [true, true, false, 0]);
    // Open annotation drafts across another client's reply are covered in
    // commenting-lock-browser.test.mjs. New annotations are now paused here.
    writeFileSync(file, content(format, true));
    const reply = await command(['reply', base.href, '--turn', '1', '--message', 'Updated the wording. The example is unchanged.'], env).exited;
    assert.equal(reply.code, 0, reply.stderr);
    await until(() => value('loadedRevision === 1 && connected && docText.includes("Updated target sentence.")'), 'document refresh');
    assert.deepEqual(await value('[generalEl.value, annotations.length, reviseBtn.disabled]'), ['My next draft', 0, false]);
    assert.equal(await value('getComputedStyle(document.querySelector(".message.agent")).alignSelf'), 'flex-start');
    await value('document.querySelector("#history details").open=true');
    assert.deepEqual(await value('[...document.querySelectorAll("#history .reference")].map(button=>button.disabled)'), [true, false]);
    await value('document.querySelectorAll("#history .reference")[1].click()');
    assert.equal(await value('document.querySelectorAll("#ink-layer path, #ink-layer rect, #annotation-bands rect").length'), 0);
    const urlBefore = await value('location.href');
    if (format === 'txt') await value('Storage.prototype.setItem = window.originalStorageSetItem; persistDraft()');
    await value('location.reload()');
    await until(() => value('connected && loadedRevision === 1 && annotations.length === 0 && document.querySelectorAll("#history .message").length === 2'), 'refresh persistence');
    assert.equal(await value('location.href'), urlBefore);
    assert.equal(await value('generalEl.value'), 'My next draft');

    if (format === 'md' && process.env.REDPEN_TEST_ARTIFACTS) {
      mkdirSync(process.env.REDPEN_TEST_ARTIFACTS, { recursive: true });
      for (const theme of ['light', 'dark']) {
        await value(`document.querySelector('#theme-${theme}').click(); document.querySelector('#history details').open=true; document.querySelector('section.notes').scrollTop=0`);
        await until(() => value(`document.documentElement.dataset.theme === '${theme}'`), theme + ' theme');
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }, session);
        writeFileSync(join(process.env.REDPEN_TEST_ARTIFACTS, 'review-chat-' + theme + '.png'), Buffer.from(screenshot.data, 'base64'));
      }
    }

    const next = command(['wait', base.href, '--after', '1'], env);
    t.after(() => next.child.kill());
    await value('document.querySelector("#revise").click()');
    await until(() => value('reviewState.waiting && !submitting && document.querySelectorAll("#history .user").length === 2'), 'second submission');
    const second = await next.exited;
    assert.match(second.stdout, /TURN: 2[\s\S]*My next draft/);
    const answer = 'Your question is answered here. <script>window.chatInjection=true</script>';
    assert.equal((await command(['reply', base.href, '--turn', '2', '--message', answer], env).exited).code, 0);
    await until(() => value('connected && loadedRevision === 2 && document.querySelectorAll("#history .agent").length === 2'), 'answer-only reply');
    assert.equal(await value('document.querySelectorAll("#history .agent p")[1].textContent'), answer);
    assert.equal(await value('!!window.chatInjection || !!document.querySelector("#history script")'), false);
    assert.equal(await value('location.href'), urlBefore);
    assert.equal(readFileSync(file, 'utf8'), content(format, true));
    const closing = command(['wait', base.href, '--after', '2'], env);
    t.after(() => closing.child.kill());
    await pause(100);
    if (format === 'md') await value(`(() => {
      const realFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await realFetch(...args);
        if (String(args[0]).startsWith('/submit?')) {
          await new Promise(resolve => setTimeout(resolve, 300));
          throw new TypeError('Simulated lost close response');
        }
        return response;
      };
    })()`);
    await value('document.querySelector("#close-session").click()');
    await until(() => value('!!document.querySelector("#done")'), 'session close');
    assert.match((await closing.exited).stdout, /^ACTION: close[\s\S]*TURN: 3\n/);
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
  }
});
