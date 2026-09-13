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

function chromePath() {
  for (const path of [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    try { if (path && accessSync(path, constants.X_OK) === undefined) return path; } catch { /* Try the next path. */ }
  }
  return null;
}
function waitFor(check, timeout = 20000) { return new Promise((resolveWait, reject) => { const end = Date.now() + timeout; const tick = async () => { try { const value = await check(); if (value) return resolveWait(value); if (Date.now() > end) throw new Error(`timed out: ${check}`); } catch (error) { if (Date.now() > end) return reject(error); } setTimeout(tick, 40); }; tick(); }); }
async function server(temp, name, text) {
  const documents = join(temp, 'documents'); mkdirSync(documents, { recursive: true });
  const file = join(documents, name); writeFileSync(file, text);
  const child = spawn(process.execPath, [CLI, file, '--no-open'], { env: { ...process.env, HOME: join(temp, 'home'), XDG_CONFIG_HOME: join(temp, 'config') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; let stdout = '';
  const exited = new Promise((resolveExit) => child.once('close', resolveExit));
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const base = await new Promise((resolveBase, reject) => { const timer = setTimeout(() => reject(new Error('server did not start')), 10000); child.stderr.on('data', (chunk) => { stderr += chunk; const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+/); if (match) { clearTimeout(timer); resolveBase(match[0]); } }); child.once('exit', (code) => reject(new Error(`server exited ${code}`))); });
  return { base, output: () => stdout, exited, async stop() {
    const url = new URL(base);
    const requestId = 'text-location-test-' + url.searchParams.get('t');
    const post = (path, body) => fetch(new URL(path + url.search, url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(1000),
    });
    try {
      const state = await (await fetch(new URL('/session' + url.search, url), { signal: AbortSignal.timeout(1000) })).json();
      if (state.closed) {
        const closeRequestId = state.history.at(-1)?.requestId;
        if (closeRequestId) await post('/confirm-close', { requestId: closeRequestId });
      } else {
        if (state.waiting) await post('/reply', { turn: state.nextTurn - 1, message: 'Test cleanup.' });
        const savedDraft = await (await fetch(new URL('/draft' + url.search, url), { signal: AbortSignal.timeout(1000) })).json();
        if ((await post('/submit', { action: 'close', requestId, draftRevision: savedDraft.revision,
          general: '', annotations: [] })).ok) await post('/confirm-close', { requestId });
      }
      for (let attempt = 0; attempt < 50; attempt++) {
        try { await fetch(new URL('/session' + url.search, url), { signal: AbortSignal.timeout(100) }); }
        catch { break; }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    } catch { /* A completed path may already have stopped its worker. */ }
    await stopChild(child, exited);
  } };
}

test('server removes unsafe text element locations', async (t) => {
  const cleanup = cleanupAfter(t);
  const temp = mkdtempSync(join(tmpdir(), 'redpen-text-location-server-')); cleanup(() => rmSync(temp, { recursive: true, force: true }));
  const session = await server(temp, 'review.html', '<p>review</p>'); cleanup(() => session.stop());
  const requestId = 'unsafe-location-close';
  const response = await fetch(new URL('/submit' + new URL(session.base).search, session.base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'close', requestId, general: '', annotations: [
      { quote: 'review', comment: 'note', elementLocation: { selector: 'body #safe', tag: 'p', role: 'javascript:bad', id: 'safe', classes: ['ok', 'url(bad)'], text: 'leak', html: '<p>leak</p>' } },
      { quote: 'unsafe selector', comment: 'unsafe note', elementLocation: { selector: 'body #123Unsafe', tag: 'p', role: '', id: '123Unsafe', classes: [] } },
      { quote: 'id mismatch', comment: 'id mismatch note', elementLocation: { selector: 'body #safe', tag: 'p', role: '', id: 'other', classes: [] } },
      { quote: 'tag mismatch', comment: 'tag mismatch note', elementLocation: { selector: 'body > article:nth-of-type(1) > p:nth-of-type(2)', tag: 'strong', role: '', id: '', classes: [] } },
    ] }),
  });
  assert.equal(response.status, 200);
  const base = new URL(session.base);
  assert.equal((await fetch(new URL('/confirm-close' + base.search, base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId }),
  })).status, 200);
  await session.exited;
  assert.match(session.output(), /Element Location:[\s\S]*Selector: body #safe[\s\S]*Role: \(none\)[\s\S]*Classes: ok/);
  assert.equal((session.output().match(/Element Location:/g) || []).length, 1);
  assert.doesNotMatch(session.output(), /javascript:|leak|url\(bad\)|123Unsafe/);
});

test('HTML text locations persist without changing other annotation kinds', { timeout: 90000 }, async (t) => {
  const chrome = chromePath();
  if (!chrome || typeof WebSocket !== 'function') return t.skip('Chrome or global WebSocket is unavailable');
  const cleanup = cleanupAfter(t);
  const temp = mkdtempSync(join(tmpdir(), 'redpen-text-location-')); cleanup(() => rmSync(temp, { recursive: true, force: true }));
  const deep = '<div>'.repeat(100) + '<strong class="deep-target">deep selected words</strong>' + '</div>'.repeat(100);
  const html = await server(temp, 'review.html', `<!doctype html><body><article id="shared" class="article-card" role="article"><p>Before <strong id="NestedID" class="author-note">nested selected words</strong> after.</p><p><strong id="123Target" class="digit-id">digit id text</strong></p><p><em>spanning first</em> and <b>spanning second</b></p>${deep}</article></body>`);
  cleanup(() => html.stop());
  const cdp = await startBrowser(chrome, join(temp, 'profile'), cleanup);
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' }); const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId); await cdp.send('Runtime.enable', {}, sessionId); await cdp.send('Network.enable', {}, sessionId);
  const value = (code) => cdp.send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true }, sessionId).then((result) => result.result.value);
  await cdp.send('Page.navigate', { url: html.base }, sessionId);
  await waitFor(() => value('connected && document.querySelector("#doc iframe")?.contentDocument?.querySelector("#NestedID")'));
  assert.equal(await value('document.querySelector("#block-toggle").checked'), true);
  await value('document.querySelector("#block-toggle").click()');
  assert.equal(await value('document.querySelector("#block-toggle").checked'), false);
  await value('(() => { const f=document.querySelector("#doc iframe"), e=f.contentDocument.querySelector("#NestedID"), r=f.contentDocument.createRange(), s=f.contentWindow.getSelection(); r.selectNodeContents(e); s.removeAllRanges(); s.addRange(r); e.dispatchEvent(new f.contentWindow.MouseEvent("mouseup", {bubbles:true})); })()');
  await waitFor(() => value('!document.querySelector("#add-btn").hidden'));
  await value('document.querySelector("#add-btn").click(); document.querySelector("#pop-comment").value="nested note"; document.querySelector("#pop-save").click()');
  await waitFor(() => value('annotations.length === 1'));
  const nested = await value('(() => { const key=[...Array(sessionStorage.length)].map((_,i)=>sessionStorage.key(i)).find((key)=>key.startsWith("redpen-draft:")); return [annotations[0].target, annotations[0].elementLocation, JSON.parse(sessionStorage.getItem(key)).annotations[0], document.querySelector("#list .element-context").textContent]; })()');
  assert.equal(nested[0], 'text');
  assert.deepEqual(nested[1], { selector: 'body #NestedID', tag: 'strong', role: '', id: 'NestedID', classes: ['author-note'] });
  assert.deepEqual(nested[2].elementLocation, nested[1]);
  assert.equal(nested[3], 'body #NestedID');
  assert.doesNotMatch(JSON.stringify(nested[1]), /text|html|value|data-|token|nonce|url/i);
  assert.deepEqual(await value('(() => { const f=document.querySelector("#doc iframe"), e=f.contentDocument.getElementById("123Target"), r=f.contentDocument.createRange(), s=f.contentWindow.getSelection(); r.selectNodeContents(e); s.removeAllRanges(); s.addRange(r); return [e.textContent, r.toString(), s.toString()]; })()'), ['digit id text', 'digit id text', 'digit id text']);
  await value('(() => { const f=document.querySelector("#doc iframe"), e=f.contentDocument.getElementById("123Target"); e.dispatchEvent(new f.contentWindow.MouseEvent("mouseup", {bubbles:true})); })()');
  await waitFor(() => value('!document.querySelector("#add-btn").hidden'));
  await value('document.querySelector("#add-btn").click(); document.querySelector("#pop-comment").value="digit id note"; document.querySelector("#pop-save").click()');
  await waitFor(() => value('annotations.length === 2'));
  assert.deepEqual(await value('annotations[1].elementLocation'), { selector: 'body > article:nth-of-type(1) > p:nth-of-type(2) > strong:nth-of-type(1)', tag: 'strong', role: '', id: '123Target', classes: ['digit-id'] });
  await value('document.documentElement.dataset.redpenBeforeReload="true"; location.reload()');
  await waitFor(() => value('!document.documentElement.dataset.redpenBeforeReload && document.readyState === "complete" && annotations.length === 2 && annotations[1].elementLocation?.selector === "body > article:nth-of-type(1) > p:nth-of-type(2) > strong:nth-of-type(1)" && annotations[1].elementLocation?.id === "123Target"'));
  await value('(() => { const key=[...Array(sessionStorage.length)].map((_,i)=>sessionStorage.key(i)).find((key)=>key.startsWith("redpen-draft:")); const draft=JSON.parse(sessionStorage.getItem(key)); draft.annotations[0].elementLocation.selector="body > article:nth-of-type(1) > p:nth-of-type(1)"; sessionStorage.setItem(key,JSON.stringify(draft)); document.documentElement.dataset.redpenBeforeReload="true"; location.reload(); })()');
  await waitFor(() => value('!document.documentElement.dataset.redpenBeforeReload && document.readyState === "complete" && annotations.length === 2'));
  assert.equal(await value('"elementLocation" in annotations[0]'), false);
  assert.equal(await value('[...document.querySelectorAll("#list .element-context")].some((node) => node.textContent === "body > article:nth-of-type(1) > p:nth-of-type(1)")'), false);
  await value('(() => { const key=[...Array(sessionStorage.length)].map((_,i)=>sessionStorage.key(i)).find((key)=>key.startsWith("redpen-draft:")); const draft=JSON.parse(sessionStorage.getItem(key)); draft.annotations[0].elementLocation={selector:"body #NestedID",tag:"forged",role:"wrong",id:"wrong",classes:["wrong"]}; sessionStorage.setItem(key,JSON.stringify(draft)); document.documentElement.dataset.redpenBeforeReload="true"; location.reload(); })()');
  await waitFor(() => value('!document.documentElement.dataset.redpenBeforeReload && document.readyState === "complete" && annotations.length === 2 && annotations[0].elementLocation?.selector === "body #NestedID" && annotations[0].elementLocation?.tag === "strong" && annotations[0].elementLocation?.id === "NestedID" && document.querySelector("#list .element-context")?.textContent === "body #NestedID"'));
  await value('document.querySelector("#block-toggle").click()');
  await value('(() => { const f=document.querySelector("#doc iframe"), d=f.contentDocument, one=d.querySelector("em").firstChild, two=d.querySelector("b").firstChild, r=d.createRange(), s=f.contentWindow.getSelection(); r.setStart(one, 0); r.setEnd(two, two.length); s.removeAllRanges(); s.addRange(r); one.parentElement.dispatchEvent(new f.contentWindow.MouseEvent("mouseup", {bubbles:true})); })()');
  await waitFor(() => value('!document.querySelector("#add-btn").hidden'));
  await value('document.querySelector("#add-btn").click(); document.querySelector("#pop-comment").value="shared note"; document.querySelector("#pop-save").click()');
  await waitFor(() => value('annotations.length === 3'));
  assert.deepEqual(await value('annotations[2].elementLocation'), { selector: 'body > article:nth-of-type(1) > p:nth-of-type(3)', tag: 'p', role: '', id: '', classes: [] });
  await value('document.querySelector("#block-toggle").click(); (() => { const f=document.querySelector("#doc iframe"), e=f.contentDocument.querySelector("#shared"), box=e.getBoundingClientRect(); e.dispatchEvent(new f.contentWindow.MouseEvent("mousemove", {bubbles:true,clientX:box.left + 2,clientY:box.top + 2})); e.dispatchEvent(new f.contentWindow.MouseEvent("click", {bubbles:true,clientX:box.left + 2,clientY:box.top + 2})); })()');
  assert.deepEqual(await value('(() => [blockMode, document.querySelector("#block-toggle").checked, !!hoverBlock, document.querySelector("#popover").hidden])()'), [true, true, true, false]);
  await waitFor(() => value('!document.querySelector("#popover").hidden'));
  await value('document.querySelector("#pop-comment").value="element note"; document.querySelector("#pop-save").click()');
  await waitFor(() => value('annotations.length === 4 && annotations[3].target === "element"'));
  await value('document.querySelector("#block-toggle").click(); (() => { const f=document.querySelector("#doc iframe"), e=f.contentDocument.querySelector(".deep-target"), r=f.contentDocument.createRange(), s=f.contentWindow.getSelection(); r.selectNodeContents(e); s.removeAllRanges(); s.addRange(r); e.dispatchEvent(new f.contentWindow.MouseEvent("mouseup", {bubbles:true})); })()');
  await waitFor(() => value('!document.querySelector("#add-btn").hidden'));
  await value('document.querySelector("#add-btn").click(); document.querySelector("#pop-comment").value="deep note"; document.querySelector("#pop-save").click()');
  await waitFor(() => value('annotations.length === 5 && annotations[4].elementLocation === undefined'));
  await value('annotations.push({...annotations[0], id: 99, comment: "forged location note", elementLocation: {...annotations[0].elementLocation, selector: "body > article:nth-of-type(1) > p:nth-of-type(2) > strong:nth-of-type(1)"}}); updateSidebar()');
  assert.equal(await value('document.querySelectorAll("#list .element-context").length'), 4);
  await value('document.querySelector("#close-session").click()'); await html.exited;
  const report = html.output();
  assert.match(report, /Element Location:\n\nSelector: body #NestedID[\s\S]*Comment:\n\nnested note/);
  assert.match(report, /Element Location:\n\nSelector: body > article:nth-of-type\(1\) > p:nth-of-type\(2\) > strong:nth-of-type\(1\)[\s\S]*Id: 123Target[\s\S]*Comment:\n\ndigit id note/);
  assert.match(report, /Element Location:\n\nSelector: body > article:nth-of-type\(1\) > p:nth-of-type\(3\)/);
  assert.match(report, /Element Context:/);
  assert.match(report, /forged location note/);
  assert.doesNotMatch(report.slice(report.indexOf('forged location note') - 500), /Element Location:/);
  const feedbackRequest = await waitFor(() => cdp.events.find((event) => event.method === 'Network.requestWillBeSent' && event.params.request.url.includes('/submit?t=')));
  const payload = feedbackRequest.params.request.postData;
  const submittedLocations = JSON.parse(payload).annotations.filter((annotation) => annotation.elementLocation).map((annotation) => annotation.elementLocation);
  assert.deepEqual(submittedLocations, [nested[1], { selector: 'body > article:nth-of-type(1) > p:nth-of-type(2) > strong:nth-of-type(1)', tag: 'strong', role: '', id: '123Target', classes: ['digit-id'] }, { selector: 'body > article:nth-of-type(1) > p:nth-of-type(3)', tag: 'p', role: '', id: '', classes: [] }]);
  assert.equal(JSON.parse(payload).annotations.find((annotation) => annotation.comment === 'forged location note').elementLocation, undefined);
  assert.doesNotMatch(JSON.stringify(submittedLocations), /text|html|data-|token|nonce|url/i);

  for (const [name, text] of [['review.md', '# Markdown\n\nmarkdown annotation'], ['review.txt', 'plain annotation']]) {
    const other = await server(temp, name, text); cleanup(() => other.stop());
    await cdp.send('Page.navigate', { url: other.base }, sessionId);
    await waitFor(() => value(name.endsWith('.md') ? 'connected && document.querySelector("#doc p")' : 'connected && document.querySelector("#doc pre.plain")'));
    const selector = name.endsWith('.md') ? '#doc p' : '#doc pre.plain';
    await value(`(() => { const e=document.querySelector(${JSON.stringify(selector)}), n=e.firstChild, r=document.createRange(), s=getSelection(); r.setStart(n,0); r.setEnd(n,Math.min(8,n.length)); s.removeAllRanges(); s.addRange(r); e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); })()`);
    await waitFor(() => value('!document.querySelector("#add-btn").hidden'));
    await value('document.querySelector("#add-btn").click(); document.querySelector("#pop-comment").value="other note"; document.querySelector("#pop-save").click()');
    await waitFor(() => value('annotations.length === 1'));
    assert.equal(await value('annotations[0].elementLocation === undefined && !document.querySelector("#list .element-context")'), true);
    await value('document.documentElement.dataset.redpenBeforeReload="true"; location.reload()');
    await waitFor(() => value('!document.documentElement.dataset.redpenBeforeReload && document.readyState === "complete" && annotations.length === 1 && !annotations[0].elementLocation'));
    await value('document.querySelector("#close-session").click()'); await other.exited;
    assert.doesNotMatch(other.output(), /Element Location:/);
  }
});
