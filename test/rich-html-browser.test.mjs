import assert from 'node:assert/strict';
import { accessSync, constants, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { get } from 'node:http';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'redpen.mjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1bQAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>';

function chromePath() {
  for (const path of [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) if (path) {
    try { if (requireExecutable(path)) return path; } catch { /* Try the next path. */ }
  }
  return null;
}
function requireExecutable(path) { try { accessSync(path, constants.X_OK); return true; } catch { return false; } }
function httpJson(url) { return new Promise((resolveJson, reject) => get(url, (res) => { let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => { try { resolveJson(JSON.parse(text)); } catch (error) { reject(error); } }); }).on('error', reject)); }
function waitFor(check, timeout = 10000, pause = 50) { return new Promise((resolveWait, reject) => { const end = Date.now() + timeout; const tick = async () => { try { const value = await check(); if (value) return resolveWait(value); if (Date.now() >= end) return reject(new Error('timed out waiting for browser')); setTimeout(tick, pause); } catch (error) { if (Date.now() >= end) reject(error); else setTimeout(tick, pause); } }; tick(); }); }

class Cdp {
  constructor(socket) { this.socket = socket; this.id = 0; this.pending = new Map(); this.events = []; socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (message.id) { const pending = this.pending.get(message.id); this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); } else this.events.push(message); }); }
  send(method, params = {}, sessionId) { return new Promise((resolveSend, reject) => { const id = ++this.id; this.pending.set(id, { resolve: resolveSend, reject }); this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }); }
  async evaluate(expression) { const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; }
  close() { this.socket.close(); }
}

async function startServer(temp, name, text) {
  const documents = join(temp, 'documents'); mkdirSync(documents, { recursive: true });
  const file = join(documents, name); writeFileSync(file, text);
  mkdirSync(join(documents, 'styles'), { recursive: true }); writeFileSync(join(documents, 'pixel.png'), PNG); writeFileSync(join(documents, 'icon.svg'), SVG); writeFileSync(join(documents, 'bg.svg'), SVG);
  const font = Buffer.alloc(48); font.write('wOF2'); font.writeUInt32BE(font.length, 8); writeFileSync(join(documents, 'font.woff2'), font);
  writeFileSync(join(documents, 'styles', 'nested.css'), '.nested { outline-color: rgb(1, 2, 3) }');
  writeFileSync(join(documents, 'styles', 'base.css'), '@import "nested.css" screen; @font-face { font-family: TestFont; src:url(/font.woff2) } .linked { background-image:url(/bg.svg); color: rgb(4, 5, 6); font-family: TestFont }');
  const child = spawn(process.execPath, [CLI, file, '--no-open'], { env: { ...process.env, HOME: join(temp, 'home'), XDG_CONFIG_HOME: join(temp, 'config') }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const base = await new Promise((resolveBase, reject) => { const timer = setTimeout(() => reject(new Error('RedPen did not start')), 10000); child.stderr.on('data', (chunk) => { stderr += chunk; const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+/); if (match) { clearTimeout(timer); resolveBase(match[0]); } }); child.once('exit', (code) => reject(new Error(`RedPen exited ${code}`))); });
  return { base, stop: () => child.kill() };
}

// This is intentionally an end-to-end CDP test. It uses no DOM dump and skips only
// when Chrome or Node's global WebSocket is unavailable.
test('rich HTML remains safe and reviewable in Chrome', { timeout: 90000 }, async (t) => {
  const chrome = chromePath();
  if (!chrome || typeof WebSocket !== 'function') return t.skip('Chrome or global WebSocket is unavailable');
  const temp = mkdtempSync(join(tmpdir(), 'redpen-rich-browser-')); const port = 35000 + Math.floor(Math.random() * 20000);
  const html = `<!doctype html><html class="html-root"><head><link rel="stylesheet" href="./styles/base.css"><style>.inline { background:url(pixel.png); animation: spin 1s infinite } @keyframes spin { to { opacity:.5 } }</style></head><body class="body-root" style="background:url(pixel.png)"><script>window.evil = true</script><p class="inline nested">Alpha beta gamma</p><p id="css-svg" class="linked">SVG background</p><img src="./pixel.png"><img src="./icon.svg"><img src="missing.png"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1bQAAAABJRU5ErkJggg=="><svg id="inline-svg"><rect width="4" height="4"/></svg><details open><summary>More</summary>detail</details><form><input value="kept"><button>Send</button></form><a href="https://example.test">outside</a><a href="#target">inside</a><p id="target">Target text</p><p id="second">Delta epsilon zeta</p></body></html>`;
  const server = await startServer(temp, 'review.html', html); t.after(() => { server.stop(); rmSync(temp, { recursive: true, force: true }); });
  const browser = spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(temp, 'profile')}`, '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  t.after(() => browser.kill());
  const version = await waitFor(() => httpJson(`http://127.0.0.1:${port}/json/version`).catch(() => null));
  const socket = new WebSocket(version.webSocketDebuggerUrl); await new Promise((resolveOpen, reject) => { socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const cdp = new Cdp(socket); t.after(() => cdp.close());
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' }); const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }); const session = attached.sessionId;
  await cdp.send('Page.enable', {}, session); await cdp.send('Runtime.enable', {}, session); await cdp.send('Network.enable', {}, session);
  await cdp.send('Page.navigate', { url: server.base }, session);
  await waitFor(async () => (await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("#doc iframe")?.contentDocument?.body?.textContent.includes("Alpha beta gamma")', returnByValue: true }, session)).result.value);
  const value = (code) => cdp.send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true }, session).then((result) => result.result.value);
  assert.deepEqual(await value('(() => { const f=document.querySelector("#doc iframe"); const d=f.contentDocument; return [d.documentElement.className,d.body.className,!!d.querySelector("script"),!!d.querySelector("details[open]"),d.querySelector("input").value,!!d.querySelector("a[href*=example]"),!!d.querySelector("a[href=\\"#target\\"]"),getComputedStyle(d.querySelector(".inline")).animationPlayState] })()'), ['html-root', 'body-root', false, true, 'kept', false, true, 'paused']);
  assert.equal(await value('document.querySelector("#doc iframe").contentDocument.querySelectorAll("img, svg").length >= 4'), true);
  assert.equal(await value('getComputedStyle(document.querySelector("#doc iframe").contentDocument.querySelector(".nested")).outlineColor'), 'rgb(1, 2, 3)');
  await waitFor(() => value('document.querySelector("#doc iframe").contentDocument.querySelector("[data-redpen-warning]")'));
  assert.equal(await value('document.querySelector("#doc iframe").contentDocument.querySelectorAll("[data-redpen-warning]").length'), 1);
  assert.deepEqual(await value('(() => { const d=document.querySelector("#doc iframe").contentDocument; return [getComputedStyle(d.body).backgroundImage.includes("/background/pixel.png"), getComputedStyle(d.querySelector(".inline")).backgroundImage.includes("/background/pixel.png"), [...d.images].some((image) => image.src.startsWith("data:")), !!d.querySelector("#inline-svg")] })()'), [true, true, true, true]);
  assert.equal(await value('(() => { const d=document.querySelector("#doc iframe").contentDocument; return !d.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})) })()'), true);
  await value('document.querySelector("#doc iframe").contentDocument.querySelector("summary").click()');
  assert.equal(await value('document.querySelector("#doc iframe").contentDocument.querySelector("details").open'), false);

  assert.equal(await value('(() => { const f=document.querySelector("#doc iframe"), d=f.contentDocument, p=d.querySelector(".inline"); const r=d.createRange(); r.setStart(p.firstChild,0); r.setEnd(p.firstChild,10); const s=f.contentWindow.getSelection(); s.removeAllRanges(); s.addRange(r); p.dispatchEvent(new MouseEvent("mouseup",{bubbles:true})); return true })()'), true);
  await waitFor(() => value('!document.querySelector("#add-btn").hidden')); await value('document.querySelector("#add-btn").click(); document.querySelector("#pop-comment").value="note"; document.querySelector("#pop-save").click()');
  await waitFor(() => value('document.querySelectorAll("#list li").length === 1'));
  await waitFor(() => value('document.querySelectorAll("#ink-layer path").length === 1 && document.querySelectorAll("#comment-rail-bands rect").length === 1'));
  assert.deepEqual(await value('[document.querySelectorAll("#ink-layer path").length, document.querySelectorAll("#comment-rail-bands rect").length]'), [1, 1]);
  assert.equal(await value('(() => { const f=document.querySelector("#doc iframe").getBoundingClientRect(), p=document.querySelector("#ink-layer path").getBoundingClientRect(); return p.left >= f.left - 2 && p.right <= f.right + 2 && p.top >= f.top - 2 && p.bottom <= f.bottom + 2 })()'), true);
  assert.equal(await value('(() => { const rail=document.querySelector("#comment-rail-bands"), band=rail.querySelector("rect"), item=document.querySelector("#list li"); return Math.abs(rail.getBoundingClientRect().top + Number(band.getAttribute("y")) - item.getBoundingClientRect().top) <= 2 })()'), true);

  await value('document.querySelector("#list li").click()');
  await waitFor(() => value('document.querySelector("#list li").classList.contains("active")'));
  await value('(() => { const f=document.querySelector("#doc iframe"), p=f.contentDocument.querySelector(".inline"); p.dispatchEvent(new f.contentWindow.PointerEvent("pointerdown",{bubbles:true})) })()');
  await waitFor(() => value('!document.querySelector("#list li").classList.contains("active")'));

  await value('(() => { const f=document.querySelector("#doc iframe"), d=f.contentDocument, first=d.querySelector(".inline").firstChild, second=d.querySelector("#second"), r=d.createRange(); r.setStart(first,0); r.setEnd(first,5); const s=f.contentWindow.getSelection(); s.removeAllRanges(); s.addRange(r); const box=second.getBoundingClientRect(); second.dispatchEvent(new f.contentWindow.MouseEvent("mousedown",{bubbles:true,button:0,shiftKey:true,clientX:box.left+4,clientY:box.top+box.height/2})) })()');
  await waitFor(() => value('!document.querySelector("#add-btn").hidden'));
  await value('document.querySelector("#add-btn").click()');
  assert.equal(await value('document.querySelector("#pop-quote").textContent.includes("Alpha") && document.querySelector("#pop-quote").textContent.includes("Delta")'), true);
  await value('document.querySelector("#pop-cancel").click(); document.querySelector("#doc iframe").contentWindow.getSelection().removeAllRanges(); document.querySelector("#block-toggle").click()');
  await value('(() => { const f=document.querySelector("#doc iframe"), p=f.contentDocument.querySelector("#second"), box=p.getBoundingClientRect(); p.dispatchEvent(new f.contentWindow.MouseEvent("mousemove",{bubbles:true,clientX:box.left+4,clientY:box.top+4})) })()');
  await waitFor(() => value('document.querySelector("#doc iframe").contentDocument.querySelector("#second").classList.contains("block-hover")'));
  await value('(() => { const f=document.querySelector("#doc iframe"), p=f.contentDocument.querySelector("#second"), box=p.getBoundingClientRect(); p.dispatchEvent(new f.contentWindow.MouseEvent("click",{bubbles:true,clientX:box.left+4,clientY:box.top+4})) })()');
  await waitFor(() => value('!document.querySelector("#popover").hidden'));
  assert.equal(await value('document.querySelector("#pop-quote").textContent.trim()'), 'Delta epsilon zeta');
  await value('document.querySelector("#pop-cancel").click(); document.querySelector("#block-toggle").click()');

  await value('document.querySelector("#general").value="draft"; document.querySelector("#general").dispatchEvent(new Event("input",{bubbles:true})); location.reload()');
  await waitFor(() => value('document.querySelector("#general").value === "draft" && document.querySelectorAll("#list li").length === 1'));
  await waitFor(() => value('document.querySelectorAll("#ink-layer path").length === 1'));
  await value('document.querySelector("#theme-dark").click()');
  assert.deepEqual(await value('(() => { const f=document.querySelector("#doc iframe"); return [document.documentElement.dataset.theme, f.contentDocument.documentElement.dataset.theme || ""] })()'), ['dark', '']);

  const markdownServer = await startServer(temp, 'review.md', '# Markdown regression\n\n![local](pixel.png)\n\n```mermaid\nflowchart LR\n  A --> B\n```\n');
  t.after(() => markdownServer.stop());
  await cdp.send('Page.navigate', { url: markdownServer.base }, session);
  await waitFor(() => value('!!document.querySelector(".mermaid-diagram svg")'));
  assert.deepEqual(await value('[!!document.querySelector("#doc iframe"), [...document.querySelectorAll("#doc img")].filter((image) => image.getAttribute("src").startsWith("/asset/")).length, document.querySelectorAll(".mermaid-diagram svg").length]'), [false, 1, 1]);

  const requests = cdp.events.filter((event) => event.method === 'Network.requestWillBeSent').map((event) => event.params.request.url);
  assert.ok(requests.some((url) => /\/font\/font\.woff2\?t=/.test(url)));
  assert.ok(requests.some((url) => /\/background\/bg\.svg\?t=/.test(url)));
  assert.ok(requests.every((url) => url.startsWith('http://127.0.0.1:') || url.startsWith('data:') || url.startsWith('blob:http://127.0.0.1:') || url === 'about:blank'), requests.join('\n'));
});
