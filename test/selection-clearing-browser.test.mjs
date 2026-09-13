import assert from 'node:assert/strict';
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cleanupAfter, startBrowser, stopChild } from '../test-support/browser.mjs';

const CLI = fileURLToPath(new URL('../bin/redpen.mjs', import.meta.url));
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
    const value = await check();
    if (value) return value;
    await pause(40);
  }
  throw new Error('Timed out waiting for ' + description);
}

test('HTML text selection clears on cancel and ordinary page clicks', { timeout: 45000 }, async (t) => {
  const chrome = chromePath();
  if (!chrome || typeof WebSocket !== 'function') return t.skip('Chrome or global WebSocket is unavailable');
  const cleanup = cleanupAfter(t);
  const temp = mkdtempSync(join(tmpdir(), 'redpen-selection-clearing-'));
  cleanup(() => rmSync(temp, { recursive: true, force: true }));
  const file = join(temp, 'review.html');
  writeFileSync(file, '<!doctype html><meta charset="utf-8"><main><p id="target">Sticky selection text with another click target.</p></main>');
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
        const state = await (await fetch(new URL('/session' + base.search, base))).json();
        if (state.waiting) await fetch(new URL('/reply' + base.search, base), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ turn: state.nextTurn - 1, message: 'Test cleanup.' }),
        });
        if (state.closed) {
          const requestId = state.history.at(-1)?.requestId;
          if (requestId) await fetch(new URL('/confirm-close' + base.search, base), {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId }),
          });
        } else {
          const draft = await (await fetch(new URL('/draft' + base.search, base))).json();
          const requestId = 'selection-clearing-test-cleanup';
          const response = await fetch(new URL('/submit' + base.search, base), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'close', requestId, draftRevision: draft.revision, general: '', annotations: [] }),
          });
          if (response.ok) await fetch(new URL('/confirm-close' + base.search, base), {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId }),
          });
        }
      }
    } catch { /* A failed path may already have stopped its worker. */ }
    await stopChild(child, exited);
  });
  base = new URL(await until(() => stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]{32}/)?.[0], 'review URL'));

  const cdp = await startBrowser(chrome, join(temp, 'profile'), cleanup);
  const { targetId } = await cdp.send('Target.createTarget', { url: base.href });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  const value = async (expression) => (await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sessionId)).result.value;
  const click = async (selector) => {
    const point = await value(`(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
  };
  const selectTarget = async () => value(`(() => {
    const node = richFrame.contentDocument.querySelector('#target').firstChild;
    const range = richFrame.contentDocument.createRange();
    range.setStart(node, 0); range.setEnd(node, 21);
    const selection = reviewWindow.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.parentElement.dispatchEvent(new reviewWindow.MouseEvent('mouseup', { bubbles: true }));
  })()`);
  const selectionState = () => value('[reviewWindow.getSelection().rangeCount, pendingRange === null, addBtn.hidden, popover.hidden]');

  await until(() => value('connected && !!richFrame?.contentDocument.querySelector("#target")'), 'HTML review');
  assert.equal(await value('!richFrame.contentDocument.querySelector("[data-redpen-warning]")'), true);

  const hoverPoint = await value(`(() => {
    const frame = richFrame.getBoundingClientRect();
    const rect = richFrame.contentDocument.querySelector('#target').getBoundingClientRect();
    return { x: frame.left + rect.left + 18, y: frame.top + rect.top + rect.height / 2 };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPoint }, sessionId);
  await until(() => value('hoverBlock?.id === "target"'), 'hover-selected HTML line');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...hoverPoint, button: 'left', clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...hoverPoint, button: 'left', clickCount: 1 }, sessionId);
  await until(() => value('!popover.hidden && pendingElement?.element?.id === "target"'), 'hover-select comment editor');
  await click('#pop-cancel');
  assert.deepEqual(await value('[popover.hidden, hoverBlock === null, !richFrame.contentDocument.querySelector("#target").classList.contains("block-hover"), pendingElement === null]'),
    [true, true, true, true]);
  await value('if (blockMode) blockToggle.click()');
  assert.equal(await value('blockMode'), false);

  await selectTarget();
  await until(() => value('!addBtn.hidden'), 'first Add comment button');
  await click('#add-btn');
  await until(() => value('!popover.hidden'), 'comment editor');
  await click('#pop-cancel');
  assert.deepEqual(await selectionState(), [0, true, true, true]);

  await selectTarget();
  await until(() => value('!addBtn.hidden'), 'second Add comment button');
  const framePoint = await value(`(() => {
    const frame = richFrame.getBoundingClientRect();
    const rect = richFrame.contentDocument.querySelector('#target').getBoundingClientRect();
    return { x: frame.left + rect.right - 6, y: frame.top + rect.top + rect.height / 2 };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...framePoint, button: 'left', clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...framePoint, button: 'left', clickCount: 1 }, sessionId);
  await until(async () => (await selectionState())[0] === 0, 'document click selection clearing');
  assert.deepEqual(await selectionState(), [0, true, true, true]);

  await selectTarget();
  await until(() => value('!addBtn.hidden'), 'third Add comment button');
  await click('#general');
  await until(async () => (await selectionState())[0] === 0, 'page click selection clearing');
  assert.deepEqual(await selectionState(), [0, true, true, true]);
  assert.equal(await value('document.activeElement === generalEl'), true);
  await cdp.send('Input.insertText', { text: 'Message field remains editable.' }, sessionId);
  assert.equal(await value('generalEl.value'), 'Message field remains editable.');

  await selectTarget();
  await until(() => value('!addBtn.hidden'), 'final Add comment button');
  await click('#add-btn');
  await click('#pop-comment');
  await value('popComment.value="Editor remains usable"');
  assert.deepEqual(await value('[popover.hidden, pendingRange === null, document.activeElement === popComment, popComment.value]'),
    [false, false, true, 'Editor remains usable']);
  await click('#pop-cancel');
});
