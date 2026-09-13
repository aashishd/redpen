import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sessionUrl } from '../bin/review-session.mjs';

const CLI = fileURLToPath(new URL('../bin/redpen.mjs', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function command(args, env = process.env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr })); });
  return { child, exited, output: () => stdout, errors: () => stderr };
}
async function until(check) {
  for (let i = 0; i < 200; i++) { const result = await check(); if (result) return result; await pause(25); }
  throw new Error('Timed out waiting for review session');
}
async function start(t, options = []) {
  const temp = mkdtempSync(join(tmpdir(), 'redpen-session-'));
  const file = join(temp, 'review.md'); writeFileSync(file, '# Review\n\nOriginal text.\n');
  const initial = command([file, '--no-open', ...options], { ...process.env, XDG_CONFIG_HOME: join(temp, 'config') });
  let base;
  t.after(async () => {
    if (base) {
      try {
        writeFileSync(file, '# Review\n\nRestored for cleanup.\n');
        const state = await (await fetch(new URL('/session' + base.search, base))).json();
        if (state.closed) await post('/confirm-close', { requestId: state.history.at(-1)?.requestId });
        else {
          if (state.waiting) await post('/reply', { turn: state.nextTurn - 1, message: 'Test cleanup.' });
          const savedDraft = await (await fetch(new URL('/draft' + base.search, base))).json();
          const requestId = 'review-session-test-cleanup';
          const close = await post('/submit', { action: 'close', requestId, draftRevision: savedDraft.revision,
            general: '', annotations: [] });
          if (close.ok) await post('/confirm-close', { requestId });
        }
      } catch { /* A successfully closed session is already gone. */ }
    }
    initial.child.kill();
    await initial.exited;
    rmSync(temp, { recursive: true, force: true });
  });
  base = new URL(await until(() => initial.errors().match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+/)?.[0]));
  function post(path, body, extra = {}) {
    return fetch(new URL(path + base.search, base), {
      method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
    });
  }
  const snapshot = async () => (await fetch(new URL('/session' + base.search, base))).json();
  return { temp, file, initial, base, post, snapshot };
}

test('review sessions keep history, deliver replies, and close after multiple turns', { timeout: 20000 }, async (t) => {
  const session = await start(t);
  const { file, base, post, snapshot, initial } = session;
  const first = { action: 'revise', turn: 1, requestId: 'first', general: 'Why this wording?', annotations: [{ quote: 'Original text.', comment: 'Please clarify.' }] };
  assert.equal(initial.output(), '');
  assert.deepEqual(await snapshot(), { revision: 0, closed: false, waiting: false, nextTurn: 1, history: [] });
  const icon = await fetch(new URL('/pen.svg' + base.search, base));
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await icon.text(), /#c6202c/);
  assert.equal((await post('/submit', first)).status, 200);
  const report = await initial.exited;
  assert.equal(report.code, 0);
  assert.match(report.stdout, /^ACTION: revise\nFILE: .+\nSESSION: http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+\nTURN: 1\n/);
  assert.equal((await snapshot()).waiting, true);
  assert.equal((await post('/submit', first)).status, 200);
  assert.equal((await post('/submit', { ...first, general: 'Different message' })).status, 409);
  assert.equal((await post('/submit', { ...first, requestId: 'second', turn: 2 })).status, 409);
  assert.equal((await snapshot()).history.length, 1);

  const answer = '--version'; // Reply text must never activate global CLI options.
  const reply = await command(['reply', base.href, '--turn', '1', '--message', answer]).exited;
  assert.equal(reply.code, 0, reply.stderr);
  assert.equal(reply.stdout, '');
  assert.equal(readFileSync(file, 'utf8'), '# Review\n\nOriginal text.\n');
  assert.equal((await snapshot()).history[1].text, answer);
  assert.equal((await post('/reply', { turn: 1, message: answer })).status, 200);
  assert.equal((await snapshot()).revision, 1);
  assert.equal((await post('/reply', { turn: 1, message: 'Changed retry' })).status, 409);

  const waiting = command(['wait', base.href, '--after', '1']);
  t.after(() => waiting.child.kill());
  await pause(100);
  assert.equal(waiting.output(), '');
  const second = { action: 'revise', turn: 2, requestId: 'second', general: 'Please revise it.', annotations: [] };
  assert.equal((await post('/submit', second)).status, 200);
  assert.match((await waiting.exited).stdout, /^ACTION: revise[\s\S]*TURN: 2\n/);
  const replay = await command(['wait', base.href, '--after', '1']).exited;
  assert.match(replay.stdout, /Please revise it\./);
  writeFileSync(file, '# Review\n\nUpdated text.\n');
  const messageFile = join(session.temp, 'reply.txt'); writeFileSync(messageFile, 'Updated the wording.');
  const secondReply = await command(['reply', base.href, '--turn', '2', '--message-file', messageFile]).exited;
  assert.equal(secondReply.code, 0, secondReply.stderr);
  const meta = await (await fetch(new URL('/doc' + base.search, base))).json();
  assert.equal(meta.text, '# Review\n\nUpdated text.\n');
  assert.equal(meta.revision, 2);
  assert.deepEqual((await snapshot()).history.map((message) => message.role), ['user', 'agent', 'user', 'agent']);

  const closing = command(['wait', base.href, '--after', '2']);
  t.after(() => closing.child.kill());
  await pause(150);
  assert.equal((await post('/submit', { action: 'close', turn: 3, requestId: 'close', general: 'Done', annotations: [] })).status, 200);
  assert.match((await closing.exited).stdout, /^ACTION: close[\s\S]*TURN: 3\n/);
  await pause(300);
  assert.equal((await snapshot()).closed, true);
  assert.equal((await post('/submit', { action: 'revise', general: 'Too late', annotations: [] })).status, 409);
  assert.equal((await post('/confirm-close', { requestId: 'wrong' })).status, 409);
  assert.equal((await post('/confirm-close', { requestId: 'close' })).status, 200);
  await until(async () => { try { await snapshot(); return false; } catch { return true; } });
});

test('session endpoints reject unsafe requests and failed document updates preserve the pending turn', { timeout: 15000 }, async (t) => {
  const { base, file, post, snapshot } = await start(t);
  for (const path of ['/session', '/pen.svg', '/reply', '/wait']) {
    assert.equal((await fetch(new URL(path, base))).status, 403);
    assert.equal((await fetch(new URL(path + base.search + '&extra=1', base))).status, 403);
  }
  assert.equal((await post('/submit', { action: 'revise', general: 'Question', annotations: [] }, { origin: 'https://example.test' })).status, 403);
  assert.equal((await post('/submit', { action: 'revise', general: 42, annotations: [] })).status, 400);
  assert.equal((await post('/submit', { action: 'revise', general: 'x'.repeat(1024 * 1024), annotations: [] })).status, 413);
  assert.equal((await post('/wait', { after: -1 })).status, 400);
  assert.equal((await post('/reply', { turn: 1, message: 'Unsolicited' })).status, 409);
  assert.equal((await post('/submit', { action: 'revise', general: 'Question', annotations: [] })).status, 200);
  writeFileSync(file, Buffer.from([0xff, 0x00]));
  assert.equal((await post('/reply', { turn: 1, message: 'Answer' })).status, 400);
  assert.equal((await snapshot()).waiting, true);
  assert.equal((await snapshot()).history.length, 1);
  writeFileSync(file, 'Valid text again.');
  assert.equal((await post('/reply', { turn: 1, message: 'Answer' })).status, 200);
});

test('stopping the initial command leaves its unsubmitted session available', { timeout: 15000 }, async (t) => {
  const { initial, snapshot } = await start(t);
  initial.child.kill('SIGTERM');
  assert.equal((await initial.exited).code, 143);
  assert.deepEqual(await snapshot(), { revision: 0, closed: false, waiting: false, nextTurn: 1, history: [] });
});

test('accepted feedback is recoverable when the first command dies before receiving it', { timeout: 15000 }, async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process suspension is unavailable');
  const { initial, base, post, snapshot } = await start(t);
  initial.child.kill('SIGSTOP');
  try {
    await pause(50);
    assert.equal((await post('/submit', { action: 'revise', general: 'Recover this feedback.', annotations: [] })).status, 200);
    initial.child.kill('SIGKILL');
    await initial.exited;
    assert.equal((await snapshot()).waiting, true);
    const recovered = await command(['wait', base.href, '--after', '0']).exited;
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.match(recovered.stdout, /^ACTION: revise[\s\S]*TURN: 1[\s\S]*Recover this feedback\./);
    assert.equal((await post('/reply', { turn: 1, message: 'Recovered and answered.' })).status, 200);
    assert.equal((await snapshot()).waiting, false);
  } finally { initial.child.kill('SIGCONT'); initial.child.kill('SIGKILL'); }
});

test('reply files have bounded reads and must contain valid UTF-8', { timeout: 10000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'redpen-reply-file-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const file = join(temp, 'reply.txt');
  const url = `http://127.0.0.1:1/?t=${'a'.repeat(32)}`;
  writeFileSync(file, ''); truncateSync(file, 256 * 1024 + 1);
  const oversized = await command(['reply', url, '--turn', '1', '--message-file', file]).exited;
  assert.equal(oversized.code, 1);
  assert.match(oversized.stderr, /at most 256 KiB/);
  const directory = await command(['reply', url, '--turn', '1', '--message-file', temp]).exited;
  assert.equal(directory.code, 1);
  assert.match(directory.stderr, /regular UTF-8 file/);
  writeFileSync(file, Buffer.from([0xff]));
  const invalid = await command(['reply', url, '--turn', '1', '--message-file', file]).exited;
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /encoded data was not valid/);
  writeFileSync(file, 'x'.repeat(65537));
  const tooLong = await command(['reply', url, '--turn', '1', '--message-file', file]).exited;
  assert.equal(tooLong.code, 1);
  assert.match(tooLong.stderr, /reply needs/);
});

test('session commands accept only tokenized localhost review URLs', () => {
  const token = 'a'.repeat(32);
  for (const value of [`https://127.0.0.1:4000/?t=${token}`, `http://example.test:4000/?t=${token}`, `http://127.0.0.1:4000/other?t=${token}`, `http://user@127.0.0.1:4000/?t=${token}`, `http://127.0.0.1:4000/?t=${token}&other=1`]) assert.throws(() => sessionUrl(value));
  assert.equal(sessionUrl(`http://127.0.0.1:4000/?t=${token}`).port, '4000');
});
