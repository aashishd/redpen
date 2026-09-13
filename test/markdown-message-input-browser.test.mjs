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

test('Markdown message input keeps focus after clearing a document selection', { timeout: 30000 }, async (t) => {
  const chrome = chromePath();
  if (!chrome || typeof WebSocket !== 'function') return t.skip('Chrome or global WebSocket is unavailable');
  const cleanup = cleanupAfter(t);
  const temp = mkdtempSync(join(tmpdir(), 'redpen-markdown-message-'));
  cleanup(() => rmSync(temp, { recursive: true, force: true }));
  const file = join(temp, 'review.md');
  writeFileSync(file, '# Message input\n\nSelect this sentence, then type a message.\n');
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
          const requestId = 'markdown-message-test-cleanup';
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

  await until(() => value('connected && !!reviewRoot.querySelector("p")'), 'Markdown review');
  await value(`(() => {
    const node = reviewRoot.querySelector('p').firstChild;
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  })()`);
  await until(() => value('!addBtn.hidden'), 'Add comment button');
  await click('#general');
  assert.deepEqual(await value('[document.activeElement === generalEl, pendingRange === null, addBtn.hidden]'), [true, true, true]);

  await cdp.send('Input.insertText', { text: 'Markdown message remains editable.' }, sessionId);
  assert.deepEqual(await value('[generalEl.value, reviseBtn.disabled]'), ['Markdown message remains editable.', false]);
  await until(async () => {
    const draft = await (await fetch(new URL('/draft' + base.search, base))).json();
    return draft.draft.general === 'Markdown message remains editable.';
  }, 'shared Markdown message draft');
});
