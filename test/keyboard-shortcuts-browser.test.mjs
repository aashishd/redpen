import assert from 'node:assert/strict';
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cleanupAfter, startBrowser, stopChild } from '../test-support/browser.mjs';

const CLI = fileURLToPath(new URL('../bin/redpen.mjs', import.meta.url));
const FIRST = 'First passage for shortcuts.';
const SECOND = 'Second passage stays put.';
const CTRL = 2;
const META = 4;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function content(format) {
  if (format === 'html') return `<!doctype html><meta charset="utf-8"><main><p id="first">${FIRST}</p><p id="second">${SECOND}</p></main>`;
  if (format === 'md') return `# Shortcuts\n\n${FIRST}\n\n${SECOND}\n`;
  return `${FIRST}\n${SECOND}\n`;
}

for (const format of ['md', 'txt', 'html']) {
  test(`${format} keyboard shortcuts comment, save, send, and toggle hover select`, { timeout: 60000 }, async (t) => {
    const chrome = chromePath();
    if (!chrome || typeof WebSocket !== 'function') return t.skip('Chrome or global WebSocket is unavailable');
    const cleanup = cleanupAfter(t);
    const temp = mkdtempSync(join(tmpdir(), 'redpen-shortcuts-'));
    cleanup(() => rmSync(temp, { recursive: true, force: true }));
    const file = join(temp, 'review.' + format);
    writeFileSync(file, content(format));
    const child = spawn(process.execPath, [CLI, file, '--no-open'], {
      env: { ...process.env, XDG_CONFIG_HOME: join(temp, 'config') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    let base;
    cleanup(async () => {
      try {
        if (base) {
          const post = (path, body) => fetch(new URL(path + base.search, base), {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
          // The send shortcut leaves the session waiting for an agent reply.
          const state = await (await fetch(new URL('/session' + base.search, base))).json();
          if (state.waiting) await post('/reply', { turn: state.nextTurn - 1, message: 'Test cleanup.' });
          const draft = await (await fetch(new URL('/draft' + base.search, base))).json();
          const requestId = 'keyboard-shortcuts-test-cleanup';
          const response = await post('/submit', { action: 'close', requestId, draftRevision: draft.revision, general: '', annotations: [] });
          if (response.ok) await post('/confirm-close', { requestId });
        }
      } catch { /* A failed path may already have stopped its worker. */ }
      await stopChild(child, exited);
    });
    base = new URL(await until(() => stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]{32}/)?.[0], 'review URL'));

    const cdp = await startBrowser(chrome, join(temp, 'profile'), cleanup);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    const value = async (expression) => {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || 'Browser evaluation failed');
      return response.result.value;
    };
    const press = async (key, code, keyCode, modifiers = 0) => {
      const text = !modifiers && key.length === 1 ? key : undefined;
      await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text, unmodifiedText: text } : {}) }, sessionId);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers }, sessionId);
    };
    const saveModifier = process.platform === 'darwin' ? META : CTRL;
    const pressSave = () => press('Enter', 'Enter', 13, saveModifier);
    const pressToggle = () => press('h', 'KeyH', 72, CTRL);
    const click = async (selector) => {
      const point = await value(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
    };

    await cdp.send('Page.navigate', { url: base.href }, sessionId);
    await until(() => value(`connected && docText.includes(${JSON.stringify(FIRST)})`), 'document readiness');
    const saveLabel = process.platform === 'darwin' ? '⌘ + ↵' : '⌃ + ↵';
    assert.deepEqual(await value('[...document.querySelectorAll("header .shortcuts li")].map((item) => item.textContent)'),
      ['C Comment on hover', saveLabel + ' Save comment', saveLabel + ' Send for review', '⌃ + H Hover select on/off'], 'The header lists every shortcut');
    assert.equal(await value('blockMode'), true);

    const hoverPoint = await value(`(() => {
      const walker = reviewRoot.ownerDocument.createTreeWalker(reviewRoot, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && !node.data.includes(${JSON.stringify(FIRST)}));
      const range = reviewRoot.ownerDocument.createRange();
      const start = node.data.indexOf(${JSON.stringify(FIRST)});
      range.setStart(node, start); range.setEnd(node, start + ${FIRST.length});
      const rect = range.getClientRects()[0], frame = richFrame?.getBoundingClientRect();
      return { x: rect.left + (frame?.left || 0) + 12, y: rect.top + (frame?.top || 0) + rect.height / 2 };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPoint }, sessionId);
    const hovered = format === 'html' ? 'hoverBlock?.id === "first"'
      : format === 'txt' ? `hoverLine?.range.toString() === ${JSON.stringify(FIRST)}`
        : `hoverBlock?.textContent === ${JSON.stringify(FIRST)}`;
    await until(() => value(hovered), 'hover target');

    await value('generalEl.focus()');
    await press('c', 'KeyC', 67);
    assert.deepEqual(await value('[popover.hidden, generalEl.value]'), [true, 'c'], 'C types normally in a text box');
    await value('generalEl.value = ""; generalEl.dispatchEvent(new Event("input", { bubbles: true })); generalEl.blur()');

    await press('c', 'KeyC', 67);
    await until(() => value('!popover.hidden'), 'comment editor from C');
    assert.deepEqual(await value('[popComment.value, document.activeElement === popComment]'), ['', true], 'C focuses an empty comment box');
    if (format === 'html') assert.equal(await value('pendingElement?.element?.id'), 'first');
    else assert.equal(await value('popQuote.textContent'), FIRST);
    await cdp.send('Input.insertText', { text: 'Shortcut comment' }, sessionId);
    await pressSave();
    await until(() => value('popover.hidden && annotations.length === 1'), 'saved shortcut comment');
    assert.equal(await value('annotations[0].comment'), 'Shortcut comment');
    assert.equal(await value('annotations[0].target'), format === 'html' ? 'element' : 'text');

    await click('#list .edit');
    await until(() => value('document.activeElement?.classList.contains("edit-area")'), 'comment edit box');
    await value('document.activeElement.select()');
    await cdp.send('Input.insertText', { text: 'Edited by keyboard' }, sessionId);
    await pressSave();
    await until(() => value('editingAnnotation === null && !document.querySelector("#list .edit-area")'), 'saved comment edit');
    assert.equal(await value('annotations[0].comment'), 'Edited by keyboard');
    assert.equal(await value('document.querySelector("#list li p:last-child").textContent'), 'Edited by keyboard');

    if (format === 'html') {
      await value('richFrame.contentWindow.focus()');
      assert.equal(await value('document.activeElement === richFrame'), true, 'Keyboard focus is inside the HTML frame');
    } else {
      await value('document.activeElement.blur()');
    }
    await pressToggle();
    assert.deepEqual(await value('[blockMode, blockToggle.checked, hintEl.textContent]'), [false, false, 'Select text to comment']);
    await press('c', 'KeyC', 67);
    assert.equal(await value('popover.hidden'), true, 'C does nothing while hover select is off');
    await pressToggle();
    assert.deepEqual(await value('[blockMode, blockToggle.checked, hintEl.textContent]'), [true, true, 'Hover and click to comment']);

    await value('generalEl.focus()');
    await pressToggle();
    assert.equal(await value('blockMode'), true, 'Ctrl+H does nothing while typing in a text box');

    await value('generalEl.blur()');
    await pressSave();
    assert.deepEqual(await value('[reviewState.waiting, reviewState.history.length]'), [false, 0], 'The send shortcut does nothing outside the message box');
    await value('generalEl.focus()');
    await cdp.send('Input.insertText', { text: 'Sent by keyboard' }, sessionId);
    await pressSave();
    await until(() => value('reviewState.waiting && reviewState.history.length === 1'), 'sent review from the message box');
    assert.deepEqual(await value('[reviewState.history[0].text, reviewState.history[0].annotations.length, generalEl.value]'),
      ['Sent by keyboard', 1, ''], 'The send shortcut sends the message and the comment');
  });
}
