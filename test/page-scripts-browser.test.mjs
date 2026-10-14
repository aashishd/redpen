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

// The page draws for longer than RedPen's quiet period without changing its
// markup, then finishes in two timer steps. Each step is shorter than the quiet period.
const SLOW_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>body{margin:0;font:16px/1.5 system-ui}</style></head>
<body><h1 id="title">Report</h1><p id="status">Loading</p>
<canvas id="chart" width="120" height="60"></canvas>
<svg id="diagram" viewBox="0 0 200 60" width="200" height="60"><defs>
<filter id="sketch"><feTurbulence baseFrequency="0.02" numOctaves="1" result="noise"/><feDisplacementMap in="SourceGraphic" in2="noise" scale="2"/></filter>
<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M1,1 L9,5 L1,9" fill="none" stroke="black"/></marker></defs>
<g filter="url(#sketch)"><line x1="10" y1="30" x2="180" y2="30" stroke="black" marker-end="url(#arrow)"/></g></svg>
<svg id="loads" width="20" height="20"><defs><filter id="picture"><feImage href="pixel.png"/></filter></defs><rect width="20" height="20" filter="url(#picture)"/></svg>
<script>
const context = document.getElementById('chart').getContext('2d');
const started = performance.now();
requestAnimationFrame(function draw(now) {
  const done = Math.min(1, (now - started) / 700);
  context.fillStyle = '#c00';
  context.fillRect(0, 0, 120 * done, 60);
  if (done < 1) return requestAnimationFrame(draw);
  setTimeout(() => {
    document.getElementById('status').textContent = 'Almost done';
    setTimeout(() => { document.getElementById('status').textContent = 'Settled'; }, 300);
  }, 300);
});
</script></body></html>`;
const BUSY_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"></head><body><p id="status">Static text</p>
<script>
document.getElementById('status').textContent = 'Changed by a script';
(function spin() { requestAnimationFrame(spin); })();
</script></body></html>`;

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

function startReview(cleanup, file, temp, options = []) {
  const child = spawn(process.execPath, [CLI, file, '--no-open', ...options], {
    env: { ...process.env, XDG_CONFIG_HOME: join(temp, 'config') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const review = { child, stderr: '', base: null };
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { review.stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  review.api = async (path, body) => {
    const response = await fetch(new URL(path + review.base.search, review.base), {
      signal: AbortSignal.timeout(5000), ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.ok, true, path + ' succeeded');
    return response.json();
  };
  cleanup(async () => {
    try {
      const draft = await review.api('/draft');
      const requestId = 'page-scripts-test-cleanup';
      await review.api('/submit', { action: 'close', requestId, draftRevision: draft.revision, general: '', annotations: [] });
      await review.api('/confirm-close', { requestId });
    } catch { /* A closed session needs no cleanup. */ }
    await stopChild(child, exited);
  });
  return until(() => {
    const url = review.stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]{32}/)?.[0];
    if (url) review.base = new URL(url);
    return review.base && review;
  }, 'review URL');
}

async function openPage(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  const value = async (expression) => {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || 'Browser evaluation failed');
    return response.result.value;
  };
  return { value, navigate: (url) => cdp.send('Page.navigate', { url }, sessionId) };
}

test('--no-js never serves the running page', { timeout: 30000 }, async (t) => {
  const cleanup = cleanupAfter(t);
  const temp = mkdtempSync(join(tmpdir(), 'redpen-no-js-route-'));
  cleanup(() => rmSync(temp, { recursive: true, force: true }));
  writeFileSync(join(temp, 'page.html'), BUSY_PAGE);
  writeFileSync(join(temp, 'other.html'), BUSY_PAGE);

  const review = await startReview(cleanup, join(temp, 'page.html'), temp, ['--no-js']);
  assert.equal((await review.api('/doc')).live, null, 'The review has no running page');
  assert.equal((await fetch(review.base.origin + '/live/' + '0'.repeat(32) + '/page.html')).status, 403);

  // A running review that already runs scripts cannot be joined with --no-js.
  const running = await startReview(cleanup, join(temp, 'other.html'), temp);
  assert.match((await running.api('/doc')).live, /^\/live\/[a-f0-9]{32}\/other\.html$/);
  const second = spawn(process.execPath, [CLI, join(temp, 'other.html'), '--no-open', '--no-js'], {
    env: { ...process.env, XDG_CONFIG_HOME: join(temp, 'config') }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  second.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { second.once('error', reject); second.once('close', resolve); });
  cleanup(() => stopChild(second, exited));
  assert.equal(await exited, 1);
  assert.match(stderr, /runs page scripts; close it before using --no-js/);
});

test('an HTML review waits until the page stops changing', { timeout: 60000 }, async (t) => {
  const chrome = chromePath();
  if (!chrome || typeof WebSocket !== 'function') return t.skip('Chrome or global WebSocket is unavailable');
  const cleanup = cleanupAfter(t);
  const temp = mkdtempSync(join(tmpdir(), 'redpen-page-scripts-'));
  cleanup(() => rmSync(temp, { recursive: true, force: true }));
  writeFileSync(join(temp, 'slow.html'), SLOW_PAGE);
  writeFileSync(join(temp, 'busy.html'), BUSY_PAGE);
  const cdp = await startBrowser(chrome, join(temp, 'profile'), cleanup);

  const slow = await startReview(cleanup, join(temp, 'slow.html'), temp);
  const slowPage = await openPage(cdp);
  await slowPage.navigate(slow.base.href);
  await until(() => slowPage.value('connected && !!richFrame && !commentingPaused()'), 'review of the slow page');
  assert.equal(await slowPage.value('reviewRoot.querySelector("#status").textContent'), 'Settled', 'Timer steps finish before the page is shown');
  assert.deepEqual(await slowPage.value(`(async () => {
    const image = reviewRoot.querySelector('#chart');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 120; canvas.height = 60;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 120, 60);
    return [...context.getImageData(118, 30, 1, 1).data];
  })()`), [204, 0, 0, 255], 'The drawing finishes before the page is shown');
  assert.deepEqual(await slowPage.value(`(() => {
    const find = (selector) => reviewRoot.querySelector(selector);
    return [!!find('#diagram marker'), !!find('#diagram filter feTurbulence'), find('#diagram line').getAttribute('marker-end'), !!find('#loads'),
      find('[data-redpen-warning]')?.textContent, document.querySelectorAll('#doc iframe').length];
  })()`), [true, true, 'url(#arrow)', false, 'RedPen: an inline SVG was blocked.', 1], 'Markers and filter effects are kept; an SVG that loads a file is not');

  // A page that never stops is shown after the time limit of the page, not the longer limit of RedPen.
  const busy = await startReview(cleanup, join(temp, 'busy.html'), temp);
  const busyPage = await openPage(cdp);
  const started = Date.now();
  await busyPage.navigate(busy.base.href);
  await until(() => busyPage.value('connected && !!richFrame && !commentingPaused()'), 'review of the busy page');
  assert.equal(await busyPage.value('reviewRoot.querySelector("#status").textContent'), 'Changed by a script');
  assert.ok(Date.now() - started < 7000, 'The busy page is shown at its time limit');
});

test('--no-js shows the file without running its scripts', { timeout: 60000 }, async (t) => {
  const chrome = chromePath();
  if (!chrome || typeof WebSocket !== 'function') return t.skip('Chrome or global WebSocket is unavailable');
  const cleanup = cleanupAfter(t);
  const temp = mkdtempSync(join(tmpdir(), 'redpen-no-js-'));
  cleanup(() => rmSync(temp, { recursive: true, force: true }));
  writeFileSync(join(temp, 'page.html'), BUSY_PAGE);
  const review = await startReview(cleanup, join(temp, 'page.html'), temp, ['--no-js']);
  const cdp = await startBrowser(chrome, join(temp, 'profile'), cleanup);
  const page = await openPage(cdp);
  await page.navigate(review.base.href);
  await until(() => page.value('connected && !!richFrame && !commentingPaused()'), 'static HTML review');
  assert.deepEqual(await page.value('[reviewRoot.querySelector("#status").textContent, scriptSwitch.hidden, reviewRoot.querySelector("[data-redpen-warning]")?.textContent, document.querySelectorAll("#doc iframe").length]'),
    ['Static text', true, 'RedPen: script was blocked.', 1]);
});
