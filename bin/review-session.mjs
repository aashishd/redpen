import { fork } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

const MAX_REPLY_CHARS = 65536;
const MAX_REPLY_BYTES = MAX_REPLY_CHARS * 4;

function readReplyFile(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_REPLY_BYTES) throw new Error('reply file must be a regular UTF-8 file of at most 256 KiB');
    const bytes = Buffer.alloc(MAX_REPLY_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_REPLY_BYTES) throw new Error('reply file is too large');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally { closeSync(descriptor); }
}

// The foreground command returns feedback. The worker owns the browser session
// until Close. An interrupted first command must not leave a worker behind.
export function startReview(script, args) {
  const child = fork(script, ['__serve', ...args], {
    detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let received = false;
  child.stderr.pipe(process.stderr);
  child.on('error', (error) => { process.stderr.write(`redpen: ${error.message}\n`); process.exitCode = 1; });
  child.on('exit', (code) => { if (!received) process.exitCode = code || 1; });
  child.on('message', (message) => {
    if (message.type !== 'feedback' || received) return;
    received = true;
    process.stdout.write(message.report, () => {
      child.stderr.destroy();
      if (child.connected) child.disconnect();
      child.unref();
    });
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { child.kill(signal); process.exit(signal === 'SIGINT' ? 130 : 143); });
  }
}

export function sessionUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.hash
    || !/^\?t=[a-f0-9]{32}$/.test(url.search)) throw new Error('expected a RedPen localhost session URL');
  return url;
}

export async function sessionCommand(command, args) {
  const url = sessionUrl(args[0]);
  let turn;
  let after = 0;
  let message;
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const option = args[i];
    if (seen.has(option) || args[i + 1] === undefined) throw new Error(`invalid option: ${option}`);
    seen.add(option);
    const value = args[++i];
    if (command === 'reply' && option === '--turn') turn = Number(value);
    else if (command === 'wait' && option === '--after') after = Number(value);
    else if (command === 'reply' && ['--message', '--message-file'].includes(option) && message === undefined) {
      message = option === '--message-file' ? readReplyFile(value) : value;
    } else throw new Error(`unknown option: ${option}`);
  }
  async function request(path, body) {
    const target = new URL(path + url.search, url);
    const response = await fetch(target, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(35000), redirect: 'error',
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  if (command === 'reply') {
    if (!Number.isSafeInteger(turn) || turn < 1 || typeof message !== 'string' || !message.trim() || message.length > MAX_REPLY_CHARS) {
      throw new Error('reply needs --turn <number> and --message <text> or --message-file <path>');
    }
    await request('/reply', { turn, message });
    process.stderr.write('redpen: reply delivered\n');
  } else {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('--after needs a non-negative turn number');
    for (;;) {
      const { report } = await request('/wait', { after });
      if (report !== null) { process.stdout.write(report); return; }
    }
  }
}

export function createReviewSession({ formatReport, reloadDocument, onFeedback }) {
  let link;
  let revision = 0;
  let pending = null;
  let closed = false;
  let closeTimer;
  const turns = [];
  const waiters = new Set();
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const snapshot = () => ({ revision, closed, waiting: pending !== null, nextTurn: turns.length + 1,
    history: turns.flatMap((turn) => [
      { role: 'user', turn: turn.id, requestId: turn.requestId, text: turn.feedback.general, annotations: turn.feedback.annotations },
      ...(turn.reply === null ? [] : [{ role: 'agent', turn: turn.id, text: turn.reply }]),
    ]),
  });
  function deliverWaiters() {
    for (const waiter of waiters) {
      const turn = turns.find((item) => item.id > waiter.after);
      if (turn) { clearTimeout(waiter.timer); waiters.delete(waiter); json(waiter.res, 200, { report: turn.report }); }
    }
  }
  function submit(body, res) {
    if (!body || !['revise', 'close'].includes(body.action) || typeof body.general !== 'string'
      || !Array.isArray(body.annotations) || body.annotations.length > 1000
      || body.annotations.some((a) => !a || typeof a.comment !== 'string'
        || (a.target === 'element' ? !a.context || typeof a.context !== 'object' : typeof a.quote !== 'string'))
      || (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(body.requestId)))) {
      return json(res, 400, { error: 'Invalid feedback.' });
    }
    const fingerprint = JSON.stringify(body);
    const previous = body.requestId && turns.find((turn) => turn.requestId === body.requestId);
    if (previous) return json(res, previous.fingerprint === fingerprint ? 200 : 409,
      previous.fingerprint === fingerprint ? { ok: true } : { error: 'Submission ID already used.' });
    if (closed || pending || (body.turn !== undefined && body.turn !== turns.length + 1)) {
      return json(res, 409, { error: 'Wait for the current reply before sending more feedback.' });
    }
    const id = turns.length + 1;
    const report = formatReport(body).replace(/\n\n/, `\nSESSION: ${link}\nTURN: ${id}\n\n`);
    const turn = { id, feedback: body, requestId: body.requestId, fingerprint, report, reply: null };
    // Persist output before accepting the submission, so a failed --out write
    // leaves the browser draft editable and does not partially submit feedback.
    onFeedback(report, body.action);
    turns.push(turn);
    pending = body.action === 'revise' ? turn : null;
    closed = body.action === 'close';
    deliverWaiters();
    if (closed) {
      // A short receipt window lets the browser reconcile a lost response.
      // Legacy submissions without request IDs retain one-shot shutdown.
      closeTimer = setTimeout(() => process.exit(0), body.requestId ? 30000 : 100);
    }
    json(res, 200, { ok: true });
  }
  function reply(body, res) {
    if (!body || !Number.isSafeInteger(body.turn) || typeof body.message !== 'string'
      || !body.message.trim() || body.message.length > MAX_REPLY_CHARS) return json(res, 400, { error: 'Invalid reply.' });
    const turn = turns.find((item) => item.id === body.turn);
    if (turn?.reply !== null && turn?.reply !== undefined) {
      return json(res, turn.reply === body.message ? 200 : 409,
        turn.reply === body.message ? { ok: true } : { error: 'This turn already has a reply.' });
    }
    if (!turn || turn !== pending || closed) return json(res, 409, { error: 'No matching turn is waiting for a reply.' });
    reloadDocument();
    turn.reply = body.message;
    revision++;
    pending = null;
    json(res, 200, { ok: true });
  }
  function confirmClose(body, res) {
    if (!closed || !body?.requestId || body.requestId !== turns.at(-1)?.requestId) {
      return json(res, 409, { error: 'No matching closed submission.' });
    }
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => process.exit(0), 100);
    json(res, 200, { ok: true });
  }
  function wait(body, res) {
    if (!body || !Number.isSafeInteger(body.after) || body.after < 0 || body.after > turns.length) {
      return json(res, 400, { error: 'Invalid previous turn.' });
    }
    const turn = turns.find((item) => item.id > body.after);
    if (turn) return json(res, 200, { report: turn.report });
    if (waiters.size >= 16) return json(res, 429, { error: 'Too many waiting commands.' });
    const waiter = { res, after: body.after };
    waiter.timer = setTimeout(() => { waiters.delete(waiter); json(res, 200, { report: null }); }, 25000);
    res.on('close', () => { clearTimeout(waiter.timer); waiters.delete(waiter); });
    waiters.add(waiter);
  }
  return {
    setLink(value) { link = value; },
    get revision() { return revision; },
    get submitted() { return turns.length > 0; },
    handle(req, res, pathname) {
      if (req.method === 'GET' && pathname === '/session') { json(res, 200, snapshot()); return true; }
      const handlers = { '/submit': submit, '/reply': reply, '/wait': wait, '/confirm-close': confirmClose };
      if (req.method !== 'POST' || !Object.hasOwn(handlers, pathname)) return false;
      let body = '';
      let size = 0;
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > 1024 * 1024) {
          if (!res.writableEnded) json(res, 413, { error: 'Message is too large.' });
        } else body += chunk;
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        try { handlers[pathname](JSON.parse(body), res); }
        catch { if (!res.writableEnded) json(res, 400, { error: 'Could not read the message or updated document.' }); }
      });
      return true;
    },
  };
}
