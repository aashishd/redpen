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
    process.on(signal, () => {
      // The browser session owns durable state. A foreground tool timeout must
      // not stop it or discard comments that have not been submitted yet.
      child.stderr.destroy();
      if (child.connected) child.disconnect();
      child.unref();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
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

export function createReviewSession({ formatReport, reloadDocument, onFeedback,
  initialState = null, persistState = () => {}, clearState = () => {} }) {
  let link;
  let revision = 0;
  let pending = null;
  let closed = false;
  let closeTimer;
  let turns = [];
  let draft = { general: '', annotations: [] };
  let draftRevision = 0;
  const waiters = new Set();
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const validAnnotation = (annotation, requireId = false) => annotation && typeof annotation.comment === 'string'
    && (!requireId || (Number.isSafeInteger(annotation.id) && annotation.id > 0))
    && (annotation.target === 'element' ? annotation.context && typeof annotation.context === 'object' : typeof annotation.quote === 'string');
  const validFeedback = (body) => body && ['revise', 'close'].includes(body.action) && typeof body.general === 'string'
    && Array.isArray(body.annotations) && body.annotations.length <= 1000
    && body.annotations.every((annotation) => validAnnotation(annotation))
    && (body.requestId === undefined || (typeof body.requestId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(body.requestId)))
    && (body.action !== 'close' || body.requestId !== undefined);
  const validDraft = (value) => value && typeof value.general === 'string' && Array.isArray(value.annotations)
    && value.annotations.length <= 1000 && value.annotations.every((annotation) => validAnnotation(annotation, true));
  const copy = (value) => JSON.parse(JSON.stringify(value));

  if (initialState !== null) {
    if (!initialState || !Number.isSafeInteger(initialState.revision) || initialState.revision < 0
      || !Number.isSafeInteger(initialState.draftRevision) || initialState.draftRevision < 0
      || !validDraft(initialState.draft) || !Array.isArray(initialState.turns)) {
      throw new Error('saved session data is invalid');
    }
    const restored = initialState.turns.map((stored, index) => {
      if (!stored || stored.id !== index + 1 || !validFeedback(stored.feedback)
        || (stored.reply !== null && (typeof stored.reply !== 'string' || !stored.reply.trim() || stored.reply.length > MAX_REPLY_CHARS))) {
        throw new Error('saved session data is invalid');
      }
      return { id: stored.id, feedback: copy(stored.feedback), requestId: stored.feedback.requestId,
        fingerprint: JSON.stringify(stored.feedback), reply: stored.reply };
    });
    const closeTurns = restored.filter((turn) => turn.feedback.action === 'close');
    if (closeTurns.length > 1 || (closeTurns.length === 1
      && (closeTurns[0] !== restored.at(-1) || closeTurns[0].reply !== null))) throw new Error('saved session data is invalid');
    const openTurns = restored.filter((turn) => turn.feedback.action === 'revise' && turn.reply === null);
    closed = closeTurns.length === 1;
    if (openTurns.length > 1 || (openTurns.length === 1 && (openTurns[0] !== restored.at(-1) || closed))) {
      throw new Error('saved session data is invalid');
    }
    revision = initialState.revision;
    turns = restored;
    pending = openTurns[0] || null;
    draft = copy(initialState.draft);
    draftRevision = initialState.draftRevision;
  }

  const snapshot = () => ({ revision, closed, waiting: pending !== null, nextTurn: turns.length + 1,
    history: turns.flatMap((turn) => [
      { role: 'user', turn: turn.id, requestId: turn.requestId, text: turn.feedback.general, annotations: turn.feedback.annotations },
      ...(turn.reply === null ? [] : [{ role: 'agent', turn: turn.id, text: turn.reply }]),
    ]),
  });
  const draftSnapshot = () => ({ revision: draftRevision, draft: copy(draft) });
  const savedState = () => ({ revision, draftRevision, draft: copy(draft),
    turns: turns.map((turn) => ({ id: turn.id, feedback: copy(turn.feedback), reply: turn.reply })) });
  const save = () => persistState(savedState());
  const reportFor = (turn) => formatReport(turn.feedback).replace(/\n\n/, `\nSESSION: ${link}\nTURN: ${turn.id}\n\n`);

  function deliverWaiters() {
    for (const waiter of waiters) {
      const turn = turns.find((item) => item.id > waiter.after);
      if (turn) { clearTimeout(waiter.timer); waiters.delete(waiter); json(waiter.res, 200, { report: reportFor(turn) }); }
    }
  }
  function updateDraft(body, res) {
    if (!body || !Number.isSafeInteger(body.revision) || body.revision < 0 || !validDraft(body.draft)) {
      return json(res, 400, { error: 'Invalid draft.' });
    }
    if (body.revision !== draftRevision) {
      return json(res, 409, { error: 'The draft changed in another browser.', ...draftSnapshot() });
    }
    const nextDraft = copy(body.draft);
    if (JSON.stringify(nextDraft) === JSON.stringify(draft)) return json(res, 200, draftSnapshot());
    const previousDraft = draft;
    const previousRevision = draftRevision;
    draft = nextDraft;
    draftRevision++;
    try { save(); } catch (error) {
      draft = previousDraft;
      draftRevision = previousRevision;
      throw error;
    }
    json(res, 200, draftSnapshot());
  }
  function submit(body, res) {
    if (!validFeedback(body)) return json(res, 400, { error: 'Invalid feedback.' });
    const fingerprint = JSON.stringify(body);
    const previous = body.requestId && turns.find((turn) => turn.requestId === body.requestId);
    if (previous) return json(res, previous.fingerprint === fingerprint ? 200 : 409,
      previous.fingerprint === fingerprint ? { ok: true, draftRevision } : { error: 'Submission ID already used.' });
    if (closed || pending || (body.turn !== undefined && body.turn !== turns.length + 1)) {
      return json(res, 409, { error: 'Wait for the current reply before sending more feedback.' });
    }
    const savedDraftExists = Boolean(draft.general || draft.annotations.length);
    if ((body.draftRevision === undefined && savedDraftExists)
      || (body.draftRevision !== undefined && body.draftRevision !== draftRevision)) {
      return json(res, 409, { error: 'The draft changed in another browser.', ...draftSnapshot() });
    }
    const id = turns.length + 1;
    const turn = { id, feedback: copy(body), requestId: body.requestId, fingerprint, reply: null };
    const previousDraft = draft;
    const previousDraftRevision = draftRevision;
    turns.push(turn);
    pending = body.action === 'revise' ? turn : null;
    closed = body.action === 'close';
    draft = { general: '', annotations: [] };
    draftRevision++;
    try {
      save();
      onFeedback(reportFor(turn), body.action);
    } catch (error) {
      turns.pop();
      pending = null;
      closed = false;
      draft = previousDraft;
      draftRevision = previousDraftRevision;
      try { save(); } catch { /* Preserve the original failure. */ }
      throw error;
    }
    deliverWaiters();
    if (closed) {
      // A receipt window lets the browser reconcile a lost response and confirm
      // that the durable close record can be removed.
      closeTimer = setTimeout(() => process.exit(0), 30000);
    }
    json(res, 200, { ok: true, draftRevision });
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
    try { save(); } catch (error) {
      turn.reply = null;
      revision--;
      pending = turn;
      throw error;
    }
    json(res, 200, { ok: true });
  }
  function confirmClose(body, res) {
    if (!closed || !body?.requestId || body.requestId !== turns.at(-1)?.requestId) {
      return json(res, 409, { error: 'No matching closed submission.' });
    }
    clearState();
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => process.exit(0), 100);
    json(res, 200, { ok: true });
  }
  function wait(body, res) {
    if (!body || !Number.isSafeInteger(body.after) || body.after < 0 || body.after > turns.length) {
      return json(res, 400, { error: 'Invalid previous turn.' });
    }
    const turn = turns.find((item) => item.id > body.after);
    if (turn) return json(res, 200, { report: reportFor(turn) });
    if (waiters.size >= 16) return json(res, 429, { error: 'Too many waiting commands.' });
    const waiter = { res, after: body.after };
    waiter.timer = setTimeout(() => { waiters.delete(waiter); json(res, 200, { report: null }); }, 25000);
    res.on('close', () => { clearTimeout(waiter.timer); waiters.delete(waiter); });
    waiters.add(waiter);
  }
  return {
    setLink(value) { link = value; save(); },
    get revision() { return revision; },
    get submitted() { return turns.length > 0; },
    get pendingReport() { return pending || closed ? reportFor(pending || turns.at(-1)) : null; },
    handle(req, res, pathname) {
      if (req.method === 'GET' && pathname === '/session') { json(res, 200, snapshot()); return true; }
      if (req.method === 'GET' && pathname === '/draft') { json(res, 200, draftSnapshot()); return true; }
      const handlers = { '/draft': updateDraft, '/submit': submit, '/reply': reply, '/wait': wait, '/confirm-close': confirmClose };
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
        let parsed;
        try { parsed = JSON.parse(body); }
        catch { return json(res, 400, { error: 'Could not read the message.' }); }
        try { handlers[pathname](parsed, res); }
        catch { if (!res.writableEnded) json(res, 400, { error: 'Could not read the message or save the review session.' }); }
      });
      return true;
    },
  };
}
