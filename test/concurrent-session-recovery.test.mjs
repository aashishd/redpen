import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CLI = fileURLToPath(new URL('../bin/redpen.mjs', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launch(file, env) {
  const child = spawn(process.execPath, [CLI, file, '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, exited, stderr: () => stderr };
}

function reviewUrl(item) {
  return item.stderr().match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]{32}/)?.[0] || null;
}

async function until(check, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await pause(25);
  }
  throw new Error('Timed out waiting for ' + description);
}

function record(config) {
  const directory = join(config, 'redpen', 'sessions');
  const name = readdirSync(directory).find((entry) => entry.endsWith('.json'));
  return JSON.parse(readFileSync(join(directory, name), 'utf8'));
}

async function post(base, path, body) {
  return fetch(new URL(path + base.search, base), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
}

test('concurrent recovery starts only one worker for a document', { timeout: 20000 }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'redpen-concurrent-recovery-'));
  const config = join(temp, 'config');
  const file = join(temp, 'review.md');
  const env = { ...process.env, XDG_CONFIG_HOME: config };
  writeFileSync(file, '# Review\n\nKeep the session.\n');
  const processes = [];
  let base;
  t.after(async () => {
    try {
      if (base) {
        const requestId = 'concurrent-cleanup';
        const response = await post(base, '/submit', { action: 'close', requestId, general: '', annotations: [] });
        if (response.ok) await post(base, '/confirm-close', { requestId });
      }
    } catch { /* The worker may already be closed. */ }
    try { process.kill(record(config).pid, 'SIGKILL'); } catch { /* No saved worker remains. */ }
    for (const item of processes) {
      if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
      await item.exited;
    }
    rmSync(temp, { recursive: true, force: true });
  });

  const initial = launch(file, env); processes.push(initial);
  await until(() => reviewUrl(initial), 'initial URL');
  initial.child.kill('SIGTERM');
  assert.equal((await initial.exited).code, 143);
  process.kill(record(config).pid, 'SIGKILL');
  await pause(100);

  const left = launch(file, env); const right = launch(file, env);
  processes.push(left, right);
  await until(() => [left, right].every((item) => reviewUrl(item)
    || item.child.exitCode !== null || item.child.signalCode !== null), 'one recovery worker and settled callers');
  const urls = [reviewUrl(left), reviewUrl(right)].filter(Boolean);
  assert.equal(new Set(urls).size, 1, 'Both callers must resolve to one worker URL');
  base = new URL(urls[0]);
  for (const rejected of [left, right].filter((item) => !reviewUrl(item))) {
    assert.equal((await rejected.exited).code, 1);
    assert.match(rejected.stderr(), /already recovering|already starting|already running|running but not responding/);
  }
  assert.equal((await fetch(new URL('/session' + base.search, base))).status, 200);

  const requestId = 'concurrent-finished';
  assert.equal((await post(base, '/submit', { action: 'close', requestId, general: '', annotations: [] })).status, 200);
  assert.equal((await post(base, '/confirm-close', { requestId })).status, 200);
  base = null;
  await Promise.all([left, right].filter((item) => reviewUrl(item)).map((item) => item.exited));
});
