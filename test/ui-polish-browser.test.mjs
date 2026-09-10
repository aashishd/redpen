import assert from 'node:assert/strict';
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cleanupAfter, startBrowser, stopChild } from '../test-support/browser.mjs';

const CLI = fileURLToPath(new URL('../bin/redpen.mjs', import.meta.url));
const ORIGINAL = 'The launch is planned for Friday.';
const UNCHANGED = 'The weekly digest arrives on Monday.';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
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
function content(format, changed = false) {
  const paragraphs = ['A small pilot for our neighborhood garden.', ...Array.from({ length: 45 }, (_, index) => `Planning note ${index + 1}: keep updates brief and useful.`), changed ? 'The launch is now planned for Monday.' : ORIGINAL, UNCHANGED, 'End of the launch plan.'];
  if (format === 'html') return '<!doctype html><html><head><style>body{margin:0;padding:36px;font:16px/1.6 system-ui;color:#252525;background:#fff}h1{font-size:30px}p{margin:20px 0}</style></head><body><h1>Garden Notes launch plan</h1>' + paragraphs.map((text, index) => `<p id="note-${index}">${text}</p>`).join('') + '</body></html>';
  return (format === 'md' ? '# Garden Notes launch plan' : 'Garden Notes launch plan') + '\n\n' + paragraphs.join('\n\n');
}
function rangeExpression(text) {
  return `(() => {
    const walker = reviewRoot.ownerDocument.createTreeWalker(reviewRoot, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.data.indexOf(${JSON.stringify(text)});
      if (start < 0) continue;
      const range = reviewRoot.ownerDocument.createRange();
      range.setStart(node, start); range.setEnd(node, start + ${text.length}); return range;
    }
    throw new Error('Missing test passage');
  })()`;
}
function contrast(first, second) {
  const luminance = (color) => {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((channel) => channel / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

for (const format of ['html', 'md', 'txt']) {
  test(`${format} review shows exact references and preserves the refined controls`, { timeout: 60000 }, async (t) => {
    const chrome = chromePath();
    if (!chrome || typeof WebSocket !== 'function') return t.skip('Chrome or global WebSocket is unavailable');
    const cleanup = cleanupAfter(t);
    const temp = mkdtempSync(join(tmpdir(), 'redpen-ui-polish-'));
    cleanup(() => rmSync(temp, { recursive: true, force: true }));
    const file = join(temp, 'review.' + format);
    writeFileSync(file, content(format));
    const initial = spawn(process.execPath, [CLI, file, '--no-open'], { env: { ...process.env, XDG_CONFIG_HOME: join(temp, 'config') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; let base; let closed = false;
    initial.stderr.on('data', (chunk) => { errors += chunk; });
    initial.stdout.resume();
    const exited = new Promise((resolve, reject) => { initial.once('error', reject); initial.once('close', resolve); });
    const api = async (path, body) => {
      const response = await fetch(new URL(path + base.search, base), {
        signal: AbortSignal.timeout(5000), ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
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
    await until(() => { const url = errors.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+/)?.[0]; if (url) base = new URL(url); return base; }, 'review startup');
    const cdp = await startBrowser(chrome, join(temp, 'profile'), cleanup);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    const value = async (expression) => {
      const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || 'Browser evaluation failed');
      return response.result.value;
    };
    const clickPoint = async (point) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, sessionId);
    };
    const click = async (selector) => {
      const point = await value(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({ block: 'nearest' }); const box = element.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
      await clickPoint(point);
    };
    await cdp.send('Page.navigate', { url: base.href }, sessionId);
    await until(() => value('connected && docText.includes(' + JSON.stringify(ORIGINAL) + ')'), 'document readiness');
    const initiallyEnabled = await value('blockToggle.checked');
    if (!initiallyEnabled) await click('label.switch');
    async function annotate(text, asText = false) {
      await value(`(() => { const range = ${rangeExpression(text)}, rect = range.getClientRects()[0], frame = richFrame?.getBoundingClientRect(); docWrap.scrollTop += rect.top + (frame?.top || 0) - docWrap.getBoundingClientRect().top - docWrap.clientHeight / 2; })()`);
      await value('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      if (asText) {
        await value(`(() => { const range = ${rangeExpression(text)}, selection = reviewWindow.getSelection(); selection.removeAllRanges(); selection.addRange(range); range.startContainer.parentElement.dispatchEvent(new reviewWindow.MouseEvent('mouseup', { bubbles: true })); })()`);
        await until(() => value('!addBtn.hidden'), 'text annotation button');
        await click('#add-btn');
      } else {
        const point = await value(`(() => { const rect = ${rangeExpression(text)}.getClientRects()[0], frame = richFrame?.getBoundingClientRect(); return { x: rect.left + (frame?.left || 0) + 12, y: rect.top + (frame?.top || 0) + rect.height / 2 }; })()`);
        await clickPoint(point);
      }
      await until(() => value('!popover.hidden'), 'comment editor');
      await value('popComment.value="Please review this."');
      await click('#pop-save');
    }
    await annotate(ORIGINAL);
    await annotate(UNCHANGED, format === 'html');
    assert.equal(await value('annotations.length'), 2);
    if (format === 'html') assert.deepEqual(await value('annotations.map(annotation => annotation.target)'), ['element', 'text']);
    await click('#revise');
    await until(() => value('reviewState.waiting && !submitting'), 'submitted comments');
    assert.equal(await exited, 0);
    await click('#history summary');
    await value('generalEl.value="My next feedback"; generalEl.dispatchEvent(new Event("input", { bubbles: true })); docWrap.scrollTop=0');
    await click('#history .reference');
    assert.equal(await value('!!document.querySelector("#reference-layer rect")'), true, 'A reference click must visibly identify its target');
    await until(() => value(`(() => { const rect = ${rangeExpression(ORIGINAL)}.getClientRects()[0], frame = richFrame?.getBoundingClientRect(), top = rect.top + (frame?.top || 0), wrap = docWrap.getBoundingClientRect(); return top >= wrap.top && top + rect.height <= wrap.bottom; })()`), 'exact target in the document viewport');
    const alignment = await value(`(() => { const range = ${rangeExpression(ORIGINAL)}, target = ${format === 'html' ? 'range.startContainer.parentElement.getBoundingClientRect()' : 'range.getClientRects()[0]'}, frame = richFrame?.getBoundingClientRect(), outline = document.querySelector('#reference-layer rect').getBoundingClientRect(); return Math.abs(outline.top - target.top - (frame?.top || 0)); })()`);
    assert.ok(alignment <= 4, 'The highlight follows the target, including inside the HTML frame');
    assert.deepEqual(await value('[annotations.length, generalEl.value, document.querySelectorAll("#ink-layer path, #ink-layer rect, #annotation-bands rect").length]'), [0, 'My next feedback', 0]);
    await until(() => value('!document.querySelector("#reference-layer rect")'), 'temporary highlight removal');
    assert.equal(initiallyEnabled, true, 'Hover selection starts on for every format');
    await click('#history .reference');
    assert.equal(await value('!!document.querySelector("#reference-layer rect")'), true);
    writeFileSync(file, content(format, true));
    await api('/reply', { turn: 1, message: 'Moved the launch to Monday. The digest schedule is unchanged.' });
    await until(() => value('loadedRevision === 1 && !documentPending && !reviewState.waiting'), 'updated document');
    assert.equal(await value('document.querySelectorAll("#reference-layer rect").length'), 0, 'A document update clears any old reference outline');
    assert.deepEqual(await value('[...document.querySelectorAll("#history .reference")].map(node => [node.textContent, node.disabled])'), [['Original text changed', true], ['Show in document', false]]);
    assert.equal(await value('generalEl.value'), 'My next feedback');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
    await value('docWrap.scrollTop=0');
    await click('#history li:nth-child(2) .reference');
    await until(() => value('!!document.querySelector("#reference-layer rect")'), 'unchanged target highlight');
    assert.equal(await value(`(() => { const rect = ${rangeExpression(UNCHANGED)}.getClientRects()[0], frame = richFrame?.getBoundingClientRect(), wrap = docWrap.getBoundingClientRect(), top = rect.top + (frame?.top || 0); return top >= wrap.top && top + rect.height <= wrap.bottom; })()`), true, 'Reduced-motion navigation reaches the target without animated scrolling');
    if (process.env.REDPEN_TEST_ARTIFACTS) {
      mkdirSync(process.env.REDPEN_TEST_ARTIFACTS, { recursive: true });
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(join(process.env.REDPEN_TEST_ARTIFACTS, `reference-${format}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    await until(() => value('!document.querySelector("#reference-layer rect")'), 'unchanged target highlight removal');
    await value('document.documentElement.dataset.beforeReload="true"; location.reload()');
    await until(() => value('!document.documentElement.dataset.beforeReload && connected && loadedRevision === 1'), 'refreshed session');
    assert.equal(await value('blockToggle.checked'), true);
    assert.equal(await value('generalEl.value'), 'My next feedback');
    assert.equal(await value('document.querySelectorAll("#history .message").length'), 2);
    assert.deepEqual(await value('(() => { const badge = document.querySelector(".brand-icon"), image = badge.querySelector("img"), rect = badge.getBoundingClientRect(); return [image.src === document.querySelector("link[rel=icon]").href, image.complete && image.naturalWidth > 0, rect.width === rect.height, parseFloat(getComputedStyle(badge).borderRadius) > 0, document.querySelector(".brand").textContent]; })()'), [true, true, true, true, 'redpen']);
    assert.deepEqual(await value('[reviseBtn.textContent, closeBtn.textContent]'), ['Send for review', 'Send feedback and exit']);
    assert.equal(await value('reviseBtn.getBoundingClientRect().height > closeBtn.getBoundingClientRect().height'), true);
    assert.equal(await value('commentsPane.getBoundingClientRect().width > 340 && paneToggle.getBoundingClientRect().width >= 24'), true);
    await click('#history summary');
    for (const theme of ['light', 'dark', 'auto']) {
      await click('#theme-' + theme);
      await until(() => value(`document.querySelector('#theme-${theme}').getAttribute('aria-pressed') === 'true'`), theme + ' theme');
      const colors = await value('(() => { const input = getComputedStyle(generalEl), action = getComputedStyle(reviseBtn), reference = getComputedStyle(document.querySelector("#history .reference")), link = getComputedStyle(document.querySelector("#history .reference:not(:disabled)")), card = getComputedStyle(document.querySelector("#history .user")); return [[input.color, input.backgroundColor], [action.color, action.backgroundColor], [reference.color, card.backgroundColor], [link.color, card.backgroundColor]]; })()');
      for (const pair of colors) assert.ok(contrast(...pair) >= 4.5, 'Text retains readable contrast in ' + theme);
      if (process.env.REDPEN_TEST_ARTIFACTS && theme !== 'auto') {
        mkdirSync(process.env.REDPEN_TEST_ARTIFACTS, { recursive: true });
        await value('docWrap.scrollTop=0');
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        writeFileSync(join(process.env.REDPEN_TEST_ARTIFACTS, `ui-${format}-${theme}.png`), Buffer.from(screenshot.data, 'base64'));
      }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
    assert.equal(await value('document.documentElement.scrollWidth <= innerWidth'), true, 'The header fits a narrow viewport');
    await click('#pane-toggle');
    assert.equal(await value('commentsPane.hidden'), true);
    await click('#pane-toggle');
    assert.equal(await value('commentsPane.hidden'), false);
    await value('blockToggle.focus()');
    for (const enabled of [false, true]) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }, sessionId);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }, sessionId);
      assert.equal(await value('blockToggle.checked'), enabled, 'The hover switch remains keyboard accessible');
    }
    if (process.env.REDPEN_TEST_ARTIFACTS) {
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(join(process.env.REDPEN_TEST_ARTIFACTS, `ui-${format}-mobile.png`), Buffer.from(screenshot.data, 'base64'));
    }
    await click('#close-session');
    await until(() => value('!!document.querySelector("#done")'), 'session close');
    closed = true;
    await until(async () => {
      try { await fetch(new URL('/session' + base.search, base), { signal: AbortSignal.timeout(1000) }); return false; }
      catch (error) { return error.cause?.code === 'ECONNREFUSED'; }
    }, 'review worker exit');
  });
}
