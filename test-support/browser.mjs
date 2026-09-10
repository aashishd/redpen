import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Release consumers before their dependencies, even if one cleanup fails.
export function cleanupAfter(t) {
  const callbacks = [];
  t.after(async () => {
    const errors = [];
    for (const callback of callbacks.reverse()) {
      try { await callback(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Test cleanup failed');
  });
  return (callback) => callbacks.push(callback);
}

async function bounded(promise, timeout, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

export async function stopChild(child, exited) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  try { await bounded(exited, 5000, 'Test child did not exit after SIGTERM'); }
  catch (error) {
    child.kill('SIGKILL');
    await bounded(exited, 5000, 'Test child did not exit after SIGKILL');
    throw error;
  }
}

class Cdp {
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map(); this.events = [];
    this.closed = new Promise((resolve) => socket.addEventListener('close', () => {
      this.rejectPending(new Error('Browser connection closed'));
      resolve();
    }, { once: true }));
    socket.addEventListener('error', () => this.rejectPending(new Error('Browser connection failed')));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) { this.events.push(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser command timed out: ' + method)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async close() {
    this.rejectPending(new Error('Test ended'));
    this.socket.close();
    await bounded(this.closed, 5000, 'Browser connection did not close');
  }
}

export async function startBrowser(chrome, profile, cleanup) {
  // Chrome selects an unused port. Reading this profile's port file also
  // prevents accidentally connecting to a different browser test.
  const browser = spawn(chrome, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let startupError;
  browser.once('error', (error) => { startupError = error; });
  const exited = new Promise((resolve) => browser.once('close', resolve));
  cleanup(() => stopChild(browser, exited));
  let port;
  const deadline = Date.now() + 10000;
  while (!port) {
    if (startupError) throw startupError;
    if (browser.exitCode !== null || browser.signalCode !== null) throw new Error('Chrome exited before startup');
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* Chrome has not written its port yet. */ }
    if (port) break;
    if (Date.now() >= deadline) throw new Error('Chrome did not publish its debugging port');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  const cdp = new Cdp(socket);
  cleanup(() => cdp.close());
  await bounded(new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  }), 5000, 'Browser connection did not open');
  return cdp;
}
