import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'redpen.mjs');
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FIXTURES = {
  'pixel.png': PNG,
  'photo.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  'loop.gif': Buffer.from('GIF89a'),
  'modern.webp': Buffer.from('RIFF\0\0\0\0WEBP'),
  'modern.avif': Buffer.from('\0\0\0\x18ftypavif\0\0\0\0'),
  'safe.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
};

async function startServer() {
  const temp = mkdtempSync(join(tmpdir(), 'redpen-assets-'));
  const home = join(temp, 'home');
  const root = join(temp, 'document');
  mkdirSync(home); mkdirSync(root);
  writeFileSync(join(root, 'review.md'), '# Review\n\n![local](pixel.png)\n![svg](safe.svg)\n');
  for (const [name, contents] of Object.entries(FIXTURES)) writeFileSync(join(root, name), contents);
  writeFileSync(join(root, 'bad.png'), 'not an image');
  writeFileSync(join(temp, 'outside.png'), PNG);
  symlinkSync(join(temp, 'outside.png'), join(root, 'escape.png'));
  const child = spawn(process.execPath, [CLI, join(root, 'review.md'), '--no-open'], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(temp, 'config') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=([a-f0-9]+)/);
      if (match) { clearTimeout(timer); resolveReady({ base: match[0], token: match[1] }); }
    });
    child.once('error', reject);
    child.once('exit', (code) => { if (!stderr.includes('http://')) reject(new Error(`server exited ${code}: ${stderr}`)); });
  });
  const session = await ready;
  return {
    ...session,
    root,
    stop() { child.kill(); rmSync(temp, { recursive: true, force: true }); },
  };
}

function asset(session, name, token = session.token) {
  return `http://127.0.0.1:${new URL(session.base).port}/asset/${encodeURIComponent(name)}?t=${token}`;
}

test('serves only tokenized, verified local image files', async (t) => {
  const session = await startServer();
  t.after(() => session.stop());
  const page = await fetch(session.base);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /img-src 'self' blob:/);
  assert.match(html, new RegExp(`/marked\\.min\\.js\\?t=${session.token}`));

  for (const [name, type] of [
    ['pixel.png', 'image/png'], ['photo.jpg', 'image/jpeg'], ['loop.gif', 'image/gif'],
    ['modern.webp', 'image/webp'], ['modern.avif', 'image/avif'],
  ]) {
    const response = await fetch(asset(session, name));
    assert.equal(response.status, 200, name);
    assert.match(response.headers.get('content-type'), new RegExp(`^${type}`));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  const svg = await fetch(asset(session, 'safe.svg'));
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /^text\/plain/);
  assert.match(await svg.text(), /<svg/);
});

test('blocks malformed, non-local, symlinked, and invalid image requests', async (t) => {
  const session = await startServer();
  t.after(() => session.stop());
  for (const name of ['bad.png', 'escape.png', '../outside.png', '%2e%2e%2foutside.png', '/etc/passwd.png', 'https:evil.png', 'data:image.png']) {
    const response = await fetch(asset(session, name));
    assert.notEqual(response.status, 200, name);
  }
  assert.equal((await fetch(asset(session, 'pixel.png', 'wrong'))).status, 403);
  assert.equal((await fetch(asset(session, 'pixel.png', session.token), { method: 'POST' })).status, 405);
});

test('asset reads are descriptor-based after containment validation', () => {
  const server = String(readFileSync(CLI));
  assert.match(server, /openSync\(target, fsConstants\.O_RDONLY \| \(fsConstants\.O_NOFOLLOW \?\? 0\)\)/);
  assert.match(server, /fstatSync\(fd\)/);
  assert.match(server, /const target = realpathSync\(candidate\)/);
  assert.match(server, /postOpenTarget = realpathSync\(candidate\)/);
  assert.match(server, /pathStat\.dev !== descriptorStat\.dev \|\| pathStat\.ino !== descriptorStat\.ino/);
  assert.match(server, /readSync\(fd, bytes/);
  assert.match(server, /closeSync\(fd\)/);
});

test('client image policy retains only local image routes and safe attributes', () => {
  const ui = String(readFileSync(join(ROOT, 'ui', 'index.html')));
  assert.match(ui, /\(navigator\.platform \|\| ''\).*\? '\(⌘ \+ ↵\)' : '\(⌃ \+ ↵\)'/);
  assert.match(ui, /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)\) saveAnnotation\(\)/);
  assert.match(ui, /SAFE_IMAGE_ATTRS = \['alt', 'title', 'width', 'height'\]/);
  assert.match(ui, /BLOCKED_DOCUMENT_ELEMENTS.*picture,source.*canvas/);
  assert.match(ui, /sanitizeLocalSvg/);
  assert.match(ui, /URL\.createObjectURL\(new Blob\(\[safeSvg\]/);
  assert.match(ui, /image\.dataset\.redpenSvgAsset = source/);
  assert.match(ui, /MAX_LOCAL_SVG_ELEMENTS = 10000/);
  assert.match(ui, /name === 'base'/);
  assert.match(ui, /safeLocalSvgStyle/);
  assert.match(ui, /safeSvgStyle/);
  assert.match(ui, /color-scheme: dark/);
  assert.match(ui, /textarea::placeholder/);
});

function contrast(first, second) {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test('theme foreground and placeholder colors retain text contrast', () => {
  const ui = String(readFileSync(join(ROOT, 'ui', 'index.html')));
  assert.match(ui, /button\.action:disabled \{ opacity: 1; color: var\(--muted\)/);
  assert.match(ui, /color: var\(--accent-foreground\)/);
  assert.ok(contrast('#e95058', '#21191a') >= 4.5);
  assert.ok(contrast('#ff6c72', '#21191a') >= 4.5);
  assert.ok(contrast('#d7c4c5', '#21191a') >= 4.5);
  assert.ok(contrast('#bd2028', '#ffffff') >= 4.5);
});
