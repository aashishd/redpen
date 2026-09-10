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
async function until(check, description) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try { if (await check()) return; } catch { /* Navigation can replace the page context. */ }
    await pause(40);
  }
  throw new Error('Timed out waiting for ' + description);
}
function chromePath() {
  return [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((path) => {
    try { if (path) { accessSync(path, constants.X_OK); return true; } } catch { /* Check another installation. */ }
    return false;
  });
}
function content(format, revision = 0) {
  const paragraphs = [revision ? 'Updated target sentence.' : 'Original target sentence.', revision > 1 ? 'Replacement paragraph.' : 'Draft target disappears.', ...Array.from({ length: 35 }, (_, index) => `Reading paragraph ${index + 1}. Scrolling remains available.`)];
  if (format === 'html') return '<!doctype html><html><body><h1>Commenting lock</h1>' + paragraphs.map((text, index) => `<p id="paragraph-${index}">${text}</p>`).join('') + '</body></html>';
  return (format === 'md' ? '# Commenting lock\n\n' : 'Commenting lock\n\n') + paragraphs.join('\n\n');
}
function rangeExpression(text) {
  return `(() => { const walker = reviewRoot.ownerDocument.createTreeWalker(reviewRoot, NodeFilter.SHOW_TEXT); let node; while ((node = walker.nextNode())) { const start = node.data.indexOf(${JSON.stringify(text)}); if (start < 0) continue; const range = reviewRoot.ownerDocument.createRange(); range.setStart(node, start); range.setEnd(node, start + ${text.length}); return range; } throw new Error('Missing passage'); })()`;
}

for (const format of ['html', 'md', 'txt']) {
  test(`${format} pauses commenting until replies and document updates are ready`, { timeout: 90000 }, async (t) => {
    const chrome = chromePath();
    if (!chrome || typeof WebSocket !== 'function') return t.skip('Chrome or global WebSocket is unavailable');
    const cleanup = cleanupAfter(t);
    const temp = mkdtempSync(join(tmpdir(), 'redpen-comment-lock-'));
    cleanup(() => rmSync(temp, { recursive: true, force: true }));
    const file = join(temp, 'review.' + format);
    writeFileSync(file, content(format));
    const initial = spawn(process.execPath, [CLI, file, '--no-open'], { env: { ...process.env, XDG_CONFIG_HOME: join(temp, 'config') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; let base; let closed = false;
    initial.stderr.on('data', (chunk) => { stderr += chunk; }); initial.stdout.resume();
    const exited = new Promise((resolve, reject) => { initial.once('error', reject); initial.once('close', resolve); });
    const api = async (path, body) => {
      const response = await fetch(new URL(path + base.search, base), { signal: AbortSignal.timeout(5000), ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      assert.equal(response.ok, true, path + ' succeeded');
      return response.json();
    };
    cleanup(async () => {
      try {
        if (base && !closed) {
          const state = await api('/session');
          if (state.waiting) await api('/reply', { turn: state.nextTurn - 1, message: 'Test cleanup.' });
          if (state.closed) await api('/confirm-close', { requestId: state.history.at(-1)?.requestId });
          else await api('/submit', { action: 'close', general: '', annotations: [] });
        }
      } finally { await stopChild(initial, exited); }
    });
    await until(() => { const url = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+/)?.[0]; if (url) base = new URL(url); return base; }, 'review startup');
    const cdp = await startBrowser(chrome, join(temp, 'profile'), cleanup);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    const value = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Browser evaluation failed');
      return result.result.value;
    };
    const mouse = async (point, click = true) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId);
      if (!click) return;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
    };
    const click = async (selector) => mouse(await value(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({ block: 'nearest' }); const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`));
    const targetPoint = async (text) => {
      await value('docWrap.scrollTop=0');
      return value(`(() => { const rect = ${rangeExpression(text)}.getClientRects()[0], frame = richFrame?.getBoundingClientRect(); return { x: rect.left + (frame?.left || 0) + 10, y: rect.top + (frame?.top || 0) + rect.height / 2 }; })()`);
    };
    const annotate = async (text, save = true) => {
      await mouse(await targetPoint(text));
      await until(() => value('!popover.hidden'), 'comment editor');
      await value('popComment.value="Draft comment"');
      if (save) await click('#pop-save');
    };
    const typeMessage = async (text) => {
      await click('#general');
      await cdp.send('Input.insertText', { text }, sessionId);
    };
    await cdp.send('Page.navigate', { url: base.href }, sessionId);
    await until(() => value('connected && blockToggle.checked'), 'initial document');
    await annotate('Original target sentence.');
    await click('#revise');
    await until(() => value('reviewState.waiting && !submitting'), 'pending reply');
    assert.equal(await exited, 0);
    await mouse(await targetPoint('Original target sentence.'));
    assert.deepEqual(await value('[popover.hidden, addBtn.hidden, annotations.length, !!hoverBlock, !!hoverLine]'), [true, true, 0, false, false], 'Commenting stays locked while awaiting a reply');
    assert.equal(await value('!document.querySelector("#commenting-notice").hidden'), true);
    assert.match(await value('document.querySelector("#commenting-notice").textContent'), /Waiting for the agent/);
    assert.deepEqual(await value('[reviseBtn.disabled, closeBtn.disabled, generalEl.disabled]'), [true, true, false]);
    await typeMessage('My next message');
    await click('#history summary');
    await click('#history .reference');
    assert.equal(await value('!!document.querySelector("#reference-layer rect")'), true, 'Submitted references remain usable');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 400, deltaX: 0, deltaY: 400 }, sessionId);
    await until(() => value('docWrap.scrollTop > 0 || (richMode && reviewWindow.scrollY > 0)'), 'scrolling while paused');
    await until(() => value('document.querySelector("#commenting-notice").hidden'), 'notice disappearance');
    await mouse(await targetPoint('Original target sentence.'), false);
    assert.equal(await value('document.querySelector("#commenting-notice").hidden && !hoverBlock && !hoverLine'), true, 'Hover alone does not show a notice or an annotation highlight');
    await click('label.switch');
    await value(`(() => { const range = ${rangeExpression('Original target sentence.')}, selection = reviewWindow.getSelection(); selection.removeAllRanges(); selection.addRange(range); range.startContainer.parentElement.dispatchEvent(new reviewWindow.MouseEvent('mouseup', { bubbles: true })); })()`);
    await until(() => value('!document.querySelector("#commenting-notice").hidden'), 'text-selection notice');
    assert.deepEqual(await value('[addBtn.hidden, popover.hidden, annotations.length]'), [true, true, 0]);
    await value('hideCommentingNotice()');
    const shiftPoint = await targetPoint('Original target sentence.');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...shiftPoint, button: 'left', clickCount: 1, modifiers: 8 }, sessionId);
    assert.equal(await value('!document.querySelector("#commenting-notice").hidden'), true, 'Shift-click extension also explains the pause');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...shiftPoint, button: 'left', clickCount: 1, modifiers: 8 }, sessionId);
    assert.deepEqual(await value('[addBtn.hidden, popover.hidden, annotations.length]'), [true, true, 0]);
    if (process.env.REDPEN_TEST_ARTIFACTS) {
      mkdirSync(process.env.REDPEN_TEST_ARTIFACTS, { recursive: true });
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(join(process.env.REDPEN_TEST_ARTIFACTS, `commenting-paused-${format}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    await value('document.documentElement.dataset.beforeReload="true"; location.reload()');
    await until(() => value('!document.documentElement.dataset.beforeReload && connected && reviewState.waiting'), 'paused session refresh');
    assert.equal(await value('generalEl.value'), 'My next message');
    await mouse(await targetPoint('Original target sentence.'));
    assert.equal(await value('popover.hidden'), true);
    // Hold both the document request and rendering to check the complete unlock boundary.
    await value(`(() => {
      const realFetch = window.fetch, realRender = renderDocument;
      window.fetch = async (...args) => { if (String(args[0]).startsWith('/doc?')) { await new Promise(resolve => window.releaseDocument = resolve); window.fetch = realFetch; } return realFetch(...args); };
      renderDocument = async (...args) => { await new Promise(resolve => window.finishRender = resolve); renderDocument = realRender; return realRender(...args); };
      Storage.prototype.setItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
    })()`);
    writeFileSync(file, content(format, 1));
    await api('/reply', { turn: 1, message: 'Updated the first paragraph.' });
    await until(() => value('!reviewState.waiting && documentPending && typeof releaseDocument === "function"'), 'reply before document download');
    await mouse(await targetPoint('Original target sentence.'));
    assert.deepEqual(await value('[popover.hidden, reviseBtn.disabled, generalEl.disabled]'), [true, true, false]);
    await value('releaseDocument()');
    await until(() => value('renderingUpdate && typeof finishRender === "function"'), 'document rendering');
    await typeMessage(' during the update');
    await mouse(await targetPoint('Original target sentence.'));
    assert.deepEqual(await value('[popover.hidden, annotations.length, generalEl.disabled]'), [true, 0, false]);
    await value('finishRender()');
    await until(() => value('loadedRevision === 1 && !documentPending && !renderingUpdate'), 'ready updated document');
    assert.equal(await value('generalEl.value'), 'My next message during the update');
    assert.equal(await value('document.querySelector("#commenting-notice").hidden'), true);
    // A second client can submit while this client has an older open draft.
    // Keep that text, lock editing, and retain an unavailable draft after the reply.
    await annotate('Draft target disappears.', format !== 'html');
    if (format !== 'html') {
      await click('#list .edit');
      await value('document.querySelector(".edit-area").value="Unsaved draft edit"');
    } else await value('popComment.value="Unsaved draft edit"');
    await api('/submit', { action: 'revise', general: 'Another client requested feedback.', annotations: [] });
    await until(() => value('reviewState.waiting'), 'another client submission');
    assert.deepEqual(await value('[popover.hidden, editingAnnotation === null, annotations.length, annotations[0].comment, document.querySelector("#list .edit").disabled]'), [true, true, 1, 'Unsaved draft edit', true]);
    writeFileSync(file, content(format, 2));
    await api('/reply', { turn: 2, message: 'Removed the draft target.' });
    await until(() => value('loadedRevision === 2 && !documentPending'), 'second document update');
    assert.deepEqual(await value('[annotations.length, annotations[0].comment, annotations[0].unavailable, document.querySelector("#list .edit").disabled]'), [1, 'Unsaved draft edit', true, false]);
    assert.match(await value('document.querySelector("#list .unavailable").textContent'), /Reference unavailable/);
    await click('#revise');
    await until(() => value('reviewState.waiting && !submitting'), 'third submission');
    const report = await api('/wait', { after: 2 });
    assert.match(report.report, /TURN: 3[\s\S]*Reference unavailable:[\s\S]*Unsaved draft edit/);
    await typeMessage('An answer-only draft');
    await api('/reply', { turn: 3, message: 'No further document changes are needed.' });
    await until(() => value('loadedRevision === 3 && !documentPending && !reviewState.waiting'), 'answer-only reply');
    assert.equal(await value('generalEl.value'), 'An answer-only draft');
    await annotate('Updated target sentence.');
    assert.equal(await value('annotations.length'), 1, 'Commenting resumes after an answer-only reply');
    await click('#close-session');
    await until(() => value('!!document.querySelector("#done")'), 'session close');
    closed = true;
    await until(async () => { try { await fetch(new URL('/session' + base.search, base), { signal: AbortSignal.timeout(1000) }); return false; } catch (error) { return error.cause?.code === 'ECONNREFUSED'; } }, 'review worker exit');
  });
}
