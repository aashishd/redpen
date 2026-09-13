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
  return [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((path) => {
    try { if (path) { accessSync(path, constants.X_OK); return true; } } catch { /* Try another installation. */ }
    return false;
  });
}

async function until(check, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* A page may still be loading. */ }
    await pause(40);
  }
  throw new Error('Timed out waiting for ' + description);
}

async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  const value = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Browser evaluation failed');
    return result.result.value;
  };
  await cdp.send('Page.navigate', { url }, sessionId);
  await until(() => value('connected && docText.includes("Shared target sentence.")'), 'page readiness');
  return value;
}

async function api(base, path, body) {
  const response = await fetch(new URL(path + base.search, base), {
    signal: AbortSignal.timeout(5000),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() };
}

test('saved comments are shared across browsers without stale overwrites', { timeout: 45000 }, async (t) => {
  const chrome = chromePath();
  if (!chrome || typeof WebSocket !== 'function') return t.skip('Chrome or global WebSocket is unavailable');
  const cleanup = cleanupAfter(t);
  const temp = mkdtempSync(join(tmpdir(), 'redpen-cross-browser-'));
  cleanup(() => rmSync(temp, { recursive: true, force: true }));
  const file = join(temp, 'review.md');
  writeFileSync(file, '# Shared review\n\nShared target sentence.\n');
  const initial = spawn(process.execPath, [CLI, file, '--no-open'], {
    env: { ...process.env, XDG_CONFIG_HOME: join(temp, 'config') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; let base; let closed = false;
  initial.stderr.on('data', (chunk) => { stderr += chunk; });
  initial.stdout.resume();
  const exited = new Promise((resolve, reject) => { initial.once('error', reject); initial.once('close', resolve); });
  cleanup(async () => {
    try {
      if (base && !closed) {
        const state = await api(base, '/session');
        if (state.body.waiting) await api(base, '/reply', { turn: state.body.nextTurn - 1, message: 'Test cleanup.' });
        const savedDraft = await api(base, '/draft');
        const done = await api(base, '/submit', { action: 'close', requestId: 'cleanup',
          draftRevision: savedDraft.body.revision, general: '', annotations: [] });
        if (done.response.ok) await api(base, '/confirm-close', { requestId: 'cleanup' });
      }
    } catch { /* A completed test already closed the worker. */ }
    await stopChild(initial, exited);
  });
  await until(() => {
    const url = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]{32}/)?.[0];
    if (url) base = new URL(url);
    return base;
  }, 'review startup');
  const requestlessClose = await api(base, '/submit', {
    action: 'close', turn: 1, draftRevision: 0, general: '', annotations: [],
  });
  assert.equal(requestlessClose.response.status, 400);

  const firstBrowser = await startBrowser(chrome, join(temp, 'profile-one'), cleanup);
  const secondBrowser = await startBrowser(chrome, join(temp, 'profile-two'), cleanup);
  const first = await openPage(firstBrowser, base.href);
  const second = await openPage(secondBrowser, base.href);

  await first(`(() => {
    const node = [...reviewRoot.querySelectorAll('p')].find((item) => item.textContent.includes('Shared target sentence.')).firstChild;
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  })()`);
  await until(() => first('!addBtn.hidden'), 'first comment button');
  await first('addBtn.click(); popComment.value="First browser comment."; document.querySelector("#pop-save").click(); generalEl.value="First browser message."; generalEl.dispatchEvent(new Event("input", { bubbles: true }))');
  await until(() => first('annotations.length === 1 && !sharedDraftDirty && !pendingSharedDraft'), 'first browser disk save');
  await until(() => second('annotations[0]?.comment === "First browser comment." && generalEl.value === "First browser message."'), 'second browser draft');

  await second('document.querySelector("#list .edit").click()');
  await until(() => second('!!document.querySelector("#list .edit-area")'), 'second browser editor');
  await second('document.querySelector("#list .edit-area").value="Second browser edit."; document.querySelector("#list .save").click()');
  await until(() => second('annotations[0]?.comment === "Second browser edit." && !sharedDraftDirty && !pendingSharedDraft'), 'second browser disk save');
  await until(() => first('annotations[0]?.comment === "Second browser edit."'), 'first browser refreshed comment');

  const current = await api(base, '/draft');
  const revisionless = await api(base, '/submit', {
    action: 'revise', turn: 1, requestId: 'revisionless-stale', general: 'Stale browser message.', annotations: [],
  });
  assert.equal(revisionless.response.status, 409);
  assert.equal((await api(base, '/draft')).body.draft.annotations[0].comment, 'Second browser edit.');

  const stale = await api(base, '/draft', {
    revision: current.body.revision - 1,
    draft: { general: 'Stale overwrite', annotations: [{ id: 1, quote: 'Shared target sentence.', comment: 'Stale comment' }] },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.draft.annotations[0].comment, 'Second browser edit.');
  assert.equal((await api(base, '/draft')).body.draft.annotations[0].comment, 'Second browser edit.');

  const latest = await api(base, '/draft');
  const feedback = {
    action: 'revise', turn: 1, requestId: 'cross-browser-review', draftRevision: latest.body.revision,
    general: latest.body.draft.general,
    annotations: latest.body.draft.annotations.map(({ id, ...annotation }) => annotation),
  };
  assert.equal((await api(base, '/submit', feedback)).response.status, 200);
  await exited;
  const repeated = await api(base, '/draft', { revision: latest.body.revision, draft: latest.body.draft });
  assert.equal(repeated.response.status, 409);
  assert.deepEqual(repeated.body.draft, { general: '', annotations: [] });
  assert.equal((await api(base, '/reply', { turn: 1, message: 'Reviewed the shared comments.' })).response.status, 200);
  const close = await api(base, '/submit', {
    action: 'close', turn: 2, requestId: 'cross-browser-finished', general: '', annotations: [],
  });
  assert.equal(close.response.status, 200);
  closed = true;
  await api(base, '/confirm-close', { requestId: 'cross-browser-finished' });
});
