import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CLI = fileURLToPath(new URL('../bin/redpen.mjs', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function command(file, env) {
  const child = spawn(process.execPath, [CLI, file, '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

async function until(check, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch { /* The worker may be restarting. */ }
    await pause(30);
  }
  throw new Error('Timed out waiting for ' + description);
}

function urlFrom(command) {
  const value = command.stderr().match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]{32}/)?.[0];
  if (value) return new URL(value);
  if (command.child.exitCode !== null || command.child.signalCode !== null) throw new Error(command.stderr() || 'RedPen exited before publishing its URL');
  return null;
}

function stateRecord(config) {
  const directory = join(config, 'redpen', 'sessions');
  const files = readdirSync(directory).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const path = join(directory, files[0]);
  return { path, value: JSON.parse(readFileSync(path, 'utf8')) };
}

async function request(base, path, body) {
  const response = await fetch(new URL(path + base.search, base), {
    signal: AbortSignal.timeout(3000),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() };
}

async function killWorker(record) {
  try { process.kill(record.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  await until(async () => {
    try { await fetch(record.link, { signal: AbortSignal.timeout(200) }); return false; } catch { return true; }
  }, 'worker shutdown');
}

test('unfinished comments survive command timeouts and worker crashes', { timeout: 30000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'redpen-durable-'));
  const config = join(temp, 'config');
  const file = join(temp, 'review.md');
  const env = { ...process.env, XDG_CONFIG_HOME: config };
  writeFileSync(file, '# Review\n\nOriginal text.\n');
  const commands = [];
  let base;
  t.after(async () => {
    try {
      if (base) {
        const session = await request(base, '/session');
        if (session.response.ok) {
          if (session.body.closed) await request(base, '/confirm-close', { requestId: session.body.history.at(-1)?.requestId });
          else {
            if (session.body.waiting) await request(base, '/reply', { turn: session.body.nextTurn - 1, message: 'Test cleanup.' });
            const savedDraft = await request(base, '/draft');
            const requestId = 'durable-test-cleanup';
            const close = await request(base, '/submit', { action: 'close', requestId,
              draftRevision: savedDraft.body.revision, general: '', annotations: [] });
            if (close.response.ok) await request(base, '/confirm-close', { requestId });
          }
        }
      }
    } catch { /* A closed or killed worker needs no HTTP cleanup. */ }
    try { await killWorker(stateRecord(config).value); } catch { /* Explicit exit removes the state file. */ }
    for (const item of commands) {
      if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
      await item.exited;
    }
    rmSync(temp, { recursive: true, force: true });
  });

  const initial = command(file, env); commands.push(initial);
  const firstBase = await until(() => urlFrom(initial), 'initial review URL');
  base = firstBase;
  const saved = await request(firstBase, '/draft', {
    revision: 0,
    draft: {
      general: 'Keep this unfinished message.',
      annotations: [{ id: 1, quote: 'Original text.', prefix: '', suffix: '', occurrences: 1, comment: 'Keep this unfinished comment.' }],
    },
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.revision, 1);
  const firstRecord = stateRecord(config);
  assert.equal(statSync(firstRecord.path).mode & 0o777, 0o600);
  assert.equal(firstRecord.value.state.draft.annotations[0].comment, 'Keep this unfinished comment.');

  initial.child.kill('SIGTERM');
  assert.equal((await initial.exited).code, 143);
  assert.equal((await request(firstBase, '/draft')).body.draft.general, 'Keep this unfinished message.');

  await killWorker(stateRecord(config).value);
  const recovered = command(file, env); commands.push(recovered);
  const recoveredBase = await until(() => urlFrom(recovered), 'replacement review URL');
  base = recoveredBase;
  assert.notEqual(recoveredBase.href, firstBase.href);
  const recoveredDraft = await request(recoveredBase, '/draft');
  assert.equal(recoveredDraft.body.draft.annotations[0].comment, 'Keep this unfinished comment.');
  assert.equal(recoveredDraft.body.draft.general, 'Keep this unfinished message.');

  recovered.child.kill('SIGTERM');
  assert.equal((await recovered.exited).code, 143);
  const resumed = command(file, env); commands.push(resumed);
  const resumedBase = await until(() => urlFrom(resumed), 'active resumed URL');
  assert.equal(resumedBase.href, recoveredBase.href);
  const submitted = await request(resumedBase, '/submit', {
    action: 'revise', turn: 1, requestId: 'durable-turn', draftRevision: recoveredDraft.body.revision,
    general: recoveredDraft.body.draft.general,
    annotations: [{ quote: 'Original text.', prefix: '', suffix: '', occurrences: 1, comment: 'Keep this unfinished comment.' }],
  });
  assert.equal(submitted.response.status, 200);
  assert.match((await resumed.exited).stdout, /Keep this unfinished comment\./);

  await killWorker(stateRecord(config).value);
  const historyRecovery = command(file, env); commands.push(historyRecovery);
  const historyBase = await until(() => urlFrom(historyRecovery), 'history recovery URL');
  base = historyBase;
  const replay = await historyRecovery.exited;
  assert.equal(replay.code, 0);
  assert.match(replay.stdout, /Keep this unfinished comment\./);
  const session = await request(historyBase, '/session');
  assert.equal(session.body.waiting, true);
  assert.equal(session.body.history[0].annotations[0].comment, 'Keep this unfinished comment.');
  assert.equal((await request(historyBase, '/reply', { turn: 1, message: 'Recovered successfully.' })).response.status, 200);
  assert.equal((await request(historyBase, '/submit', { action: 'close', turn: 2, requestId: 'finished', general: '', annotations: [] })).response.status, 200);
  assert.equal(stateRecord(config).value.state.turns.at(-1).feedback.action, 'close');

  await killWorker(stateRecord(config).value);
  const closeRecovery = command(file, env); commands.push(closeRecovery);
  const closeBase = await until(() => urlFrom(closeRecovery), 'closed session recovery URL');
  base = closeBase;
  const closeReplay = await closeRecovery.exited;
  assert.equal(closeReplay.code, 0);
  assert.match(closeReplay.stdout, /^ACTION: close[\s\S]*TURN: 2\n/);
  assert.equal((await request(closeBase, '/session')).body.closed, true);
  assert.equal((await request(closeBase, '/confirm-close', { requestId: 'finished' })).response.status, 200);
  assert.throws(() => stateRecord(config));
});
