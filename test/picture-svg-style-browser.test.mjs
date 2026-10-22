import assert from 'node:assert/strict';
import { accessSync, constants, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cleanupAfter, startBrowser, stopChild } from '../test-support/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'redpen.mjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1bQAAAABJRU5ErkJggg==', 'base64');
const square = (style, fill = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${style}<rect class="r" width="10" height="10"${fill}/></svg>`;
const SVGS = {
  'light.svg': square('', ' fill="rgb(0,128,0)"'),
  'dark.svg': square('', ' fill="rgb(200,0,0)"'),
  'styled.svg': square('<style>.r { fill: rgb(0, 128, 0) }</style>'),
  'import.svg': square('<style>@import "other.css"; .r { fill: rgb(0, 128, 0) }</style>'),
  'remote.svg': square('<style>.r { fill: url(https://example.test/paint.svg#p) }</style>'),
  'animated.svg': square('<style>.r { animation: spin 1s infinite }</style>'),
};

function chromePath() {
  for (const path of [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) if (path) {
    try { accessSync(path, constants.X_OK); return path; } catch { /* Try the next path. */ }
  }
  return null;
}
function waitFor(check, timeout = 10000, pause = 50) { return new Promise((resolveWait, reject) => { const end = Date.now() + timeout; const tick = async () => { try { const value = await check(); if (value) return resolveWait(value); if (Date.now() >= end) return reject(new Error('timed out waiting for browser')); setTimeout(tick, pause); } catch (error) { if (Date.now() >= end) reject(error); else setTimeout(tick, pause); } }; tick(); }); }

async function startServer(temp, name, text, args = []) {
  const documents = join(temp, 'documents'); mkdirSync(documents, { recursive: true });
  const file = join(documents, name); writeFileSync(file, text);
  for (const [svg, markup] of Object.entries(SVGS)) writeFileSync(join(documents, svg), markup);
  writeFileSync(join(documents, 'pixel.png'), PNG);
  const child = spawn(process.execPath, [CLI, file, '--no-open', ...args], { env: { ...process.env, HOME: join(temp, 'home'), XDG_CONFIG_HOME: join(temp, 'config') }, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise((resolveExit) => child.once('close', resolveExit));
  let stderr = '';
  const base = await new Promise((resolveBase, reject) => { const timer = setTimeout(() => reject(new Error('RedPen did not start')), 10000); child.stderr.on('data', (chunk) => { stderr += chunk; const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+/); if (match) { clearTimeout(timer); resolveBase(match[0]); } }); child.once('exit', (code) => reject(new Error(`RedPen exited ${code}`))); });
  return { base, async stop() {
    const url = new URL(base);
    const requestId = 'picture-test-' + url.searchParams.get('t');
    const post = (path, body) => fetch(new URL(path + url.search, url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(1000),
    });
    try {
      const draft = await (await fetch(new URL('/draft' + url.search, url), { signal: AbortSignal.timeout(1000) })).json();
      if ((await post('/submit', { action: 'close', requestId, draftRevision: draft.revision, general: '', annotations: [] })).ok) await post('/confirm-close', { requestId });
      for (let attempt = 0; attempt < 50; attempt++) {
        try { await fetch(new URL('/session' + url.search, url), { signal: AbortSignal.timeout(100) }); }
        catch { break; }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    } catch { /* A completed path may already have stopped its worker. */ }
    await stopChild(child, exited);
  } };
}

async function openReview(t, name, text, args) {
  const chrome = chromePath();
  if (!chrome || typeof WebSocket !== 'function') { t.skip('Chrome or global WebSocket is unavailable'); return null; }
  const cleanup = cleanupAfter(t);
  const temp = mkdtempSync(join(tmpdir(), 'redpen-picture-browser-'));
  cleanup(() => rmSync(temp, { recursive: true, force: true }));
  const server = await startServer(temp, name, text, args); cleanup(() => server.stop());
  const cdp = await startBrowser(chrome, join(temp, 'profile'), cleanup);
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  const emulate = (scheme) => cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
  await emulate('light');
  await cdp.send('Page.navigate', { url: server.base }, sessionId);
  const value = (code) => cdp.send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true }, sessionId).then((result) => result.result.value);
  return { value, emulate };
}

// Reads the drawn colour, so the test fails if a style block is dropped instead of applied.
const IMAGE_STATE = `(root) => [...root.querySelectorAll('img')].map((image) => {
  if (!image.complete || !image.naturalWidth) return { alt: image.alt, loaded: false };
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 10;
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 10, 10);
  return { alt: image.alt, loaded: true, rgb: [...context.getImageData(5, 5, 1, 1).data.slice(0, 3)] };
})`;

test('Markdown pictures follow the RedPen theme and SVG images keep safe style blocks', { timeout: 60000 }, async (t) => {
  const markdown = `# Pictures

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="dark.svg">
  <img alt="Themed" src="light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="pixel.png">
  <source media="(min-width: 1px)" srcset="dark.svg">
  <source media="(prefers-color-scheme: dark)" srcset="https://example.test/dark.svg">
  <source media="(prefers-color-scheme: dark)" srcset="dark.svg 1x, light.svg 2x">
  <source srcset="dark.svg">
  <img alt="Raster" src="light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="import.svg">
  <img alt="Unsafe source" src="light.svg">
</picture>

<picture><source media="(prefers-color-scheme: dark)" srcset="dark.svg"></picture>

<source media="(prefers-color-scheme: dark)" srcset="dark.svg">

![Styled](styled.svg)

![Import style](import.svg)

![Remote style](remote.svg)

![Animated style](animated.svg)
`;
  const review = await openReview(t, 'review.md', markdown);
  if (!review) return;
  const { value, emulate } = review;
  const state = () => value(`(() => {
    const root = document.getElementById('doc');
    const placeholders = [...root.querySelectorAll('.image-placeholder')].map((node) => node.textContent);
    const images = (${IMAGE_STATE})(root);
    const pictures = [...root.querySelectorAll('picture')].map((picture) => [...picture.children].map((child) => child.localName === 'img' ? 'img'
      : [child.getAttribute('media'), (child.getAttribute('srcset') || '').replace(/^blob:.*/, 'blob').replace(/\\?t=[a-f0-9]+$/, '?t=token')].join(' ')));
    return { images, placeholders, pictures, sources: root.querySelectorAll('source').length };
  })()`);
  const themed = (rgb) => waitFor(async () => {
    const current = await state();
    return current.images.find((image) => image.alt === 'Themed')?.rgb?.join() === rgb.join() && current;
  });
  const green = [0, 128, 0];
  const red = [200, 0, 0];

  const initial = await themed(green);
  assert.deepEqual(initial.pictures, [
    ['(prefers-color-scheme: dark) blob', 'img'],
    ['(prefers-color-scheme: dark) /asset/pixel.png?t=token', 'img'],
    ['img'],
  ]);
  assert.equal(initial.sources, 2);
  assert.deepEqual(initial.images.map((image) => [image.alt, image.loaded, image.rgb]), [
    ['Themed', true, green], ['Raster', true, green], ['Unsafe source', true, green], ['Styled', true, green],
  ]);
  assert.deepEqual(initial.placeholders, ['Import style', 'Remote style', 'Animated style']);

  await emulate('dark');
  await themed(red);
  await value(`document.getElementById('theme-light').click()`);
  const light = await themed(green);
  assert.equal(light.pictures[0][0], 'not all blob');
  await value(`document.getElementById('theme-dark').click()`);
  const dark = await themed(red);
  assert.equal(dark.pictures[0][0], 'all blob');
  assert.deepEqual(dark.images.find((image) => image.alt === 'Unsafe source').rgb, green);
  await emulate('light');
  await themed(red);
  await value(`document.getElementById('theme-auto').click()`);
  const auto = await themed(green);
  assert.equal(auto.pictures[0][0], '(prefers-color-scheme: dark) blob');
});

test('HTML SVG images keep safe style blocks while inline SVG style stays blocked', { timeout: 60000 }, async (t) => {
  const html = `<!doctype html><html><body><img alt="Styled" src="styled.svg"><img alt="Import style" src="import.svg"><svg id="inline" width="10" height="10"><style>rect { fill: green }</style><rect width="10" height="10"/></svg></body></html>`;
  const review = await openReview(t, 'review.html', html, ['--no-js']);
  if (!review) return;
  const { value } = review;
  const state = await waitFor(() => value(`(() => {
    const root = document.querySelector('#doc iframe')?.contentDocument?.body;
    if (!root) return null;
    const images = (${IMAGE_STATE})(root);
    const placeholders = [...root.querySelectorAll('.image-placeholder')].map((node) => node.textContent);
    if (images.length + placeholders.length < 2 || images.some((image) => !image.loaded)) return null;
    return { images, inline: Boolean(root.querySelector('#inline')), placeholders };
  })()`));
  assert.deepEqual(state.images, [{ alt: 'Styled', loaded: true, rgb: [0, 128, 0] }]);
  assert.deepEqual(state.placeholders, ['Import style']);
  assert.equal(state.inline, false);
});
