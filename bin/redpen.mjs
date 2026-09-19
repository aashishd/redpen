#!/usr/bin/env node
// redpen — annotate a document in the browser; feedback goes to stdout.
//
// Contract: stdout carries only the feedback report. All status and error
// messages go to stderr, so an agent can capture stdout verbatim.

import { createServer } from 'node:http';
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { createReviewSession, sessionCommand, sessionUrl, startReview } from './review-session.mjs';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;
const MARKDOWN_EXTS = ['.md', '.markdown'];
const HTML_EXTS = ['.html', '.htm'];
const TEXT_EXTS = ['.txt'];
const ACCEPTED_FORMATS = '.txt, .md, .markdown, .html, .htm, or an extensionless UTF-8 text file';
const SETTINGS_FILE = settingsFile();
const SESSIONS_DIR = join(dirname(SETTINGS_FILE), 'sessions');
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.svg', 'image/svg+xml'],
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CSS_BYTES = 1024 * 1024;
const MAX_FONT_BYTES = 10 * 1024 * 1024;
const MAX_DATA_BYTES = 256 * 1024;
const MAX_CSS_IMPORTS = 32;
const MAX_TOTAL_CSS_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_CSS_BYTES = 256 * 1024;
const CSS_TYPES = new Map([['.css', 'text/css; charset=utf-8']]);
const FONT_TYPES = new Map([
  ['.woff2', 'font/woff2'], ['.woff', 'font/woff'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
]);
// Files a running HTML page may load from its own folder. Other files, such as
// data or configuration, stay private even while page scripts can use the network.
const LIVE_TYPES = new Map([
  ...IMAGE_TYPES, ...FONT_TYPES, ...CSS_TYPES,
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
]);
const MAX_LIVE_BYTES = 10 * 1024 * 1024;

const AGENTS = {
  claude: {
    file: join(homedir(), '.claude', 'skills', 'redpen', 'SKILL.md'),
  },
  pi: {
    file: join(homedir(), '.pi', 'agent', 'skills', 'redpen', 'SKILL.md'),
  },
  codex: {
    file: join(homedir(), '.agents', 'skills', 'redpen', 'SKILL.md'),
    legacy: { file: join(homedir(), '.codex', 'prompts', 'redpen.md'), template: 'codex.md' },
  },
  opencode: {
    file: join(homedir(), '.config', 'opencode', 'skills', 'redpen', 'SKILL.md'),
    legacy: { file: join(homedir(), '.config', 'opencode', 'command', 'redpen.md'), template: 'opencode.md' },
  },
  gemini: {
    file: join(homedir(), '.gemini', 'skills', 'redpen', 'SKILL.md'),
    legacy: { file: join(homedir(), '.gemini', 'commands', 'redpen.toml'), template: 'gemini.toml' },
  },
};

main(process.argv.slice(2));

function main(argv) {
  const [cmd, ...rest] = argv;
  // Reply text is data, even when the whole message is a CLI flag.
  if (cmd === 'reply' || cmd === 'wait') return sessionCommand(cmd, rest).catch((error) => fail(error.message));
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION);
    return;
  }
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  if (cmd === 'install') return install(rest);
  if (cmd === 'uninstall') return uninstall(rest);
  if (cmd === '__serve' && process.send) return serve(rest);
  runReview(argv).catch((error) => fail(error.message));
}

function printHelp() {
  process.stderr.write(`redpen ${VERSION}: annotate a document in the browser

Usage:
  redpen <file> [options]         Open <file> for annotation; block until the
                                  user submits; print the feedback to stdout.
  redpen reply <session> --turn <n> --message <text>
                                  Reply in the same review page. Use
                                  --message-file <path> for longer replies.
  redpen wait <session> --after <n>
                                  Wait for feedback after turn <n>.
  redpen install <agent...>       Install the RedPen skill for agents.
  redpen uninstall <agent...>     Remove it again.

Agents: ${Object.keys(AGENTS).join(', ')}, or "all".

Options:
  --out <file>    Also write the feedback report to <file>.
  --port <n>      Listen on a fixed port (default: random).
  --no-open       Do not open the browser; print the URL only.
  -v, --version   Print the version.
  -h, --help      Show this help.

Accepted files: ${ACCEPTED_FORMATS}.

Output starts with "ACTION: revise" or "ACTION: close".
SESSION and TURN identify the review page and submitted message.
After revise, reply in that session, then wait for the next turn.
Close ends the session.
`);
}

function fail(msg) {
  process.stderr.write(`redpen: error: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- serve

function reviewOptions(args) {
  let file;
  let out;
  let port = 0;
  let open = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') out = args[++i];
    else if (a === '--port') port = Number(args[++i]);
    else if (a === '--no-open') open = false;
    else if (a.startsWith('-')) fail(`unknown option: ${a}`);
    else if (file) fail('only one file can be annotated at a time');
    else file = a;
  }
  if (!file) fail('no file given (usage: redpen <file>)');
  if (out === undefined && args.includes('--out')) fail('--out needs a file path');
  if (Number.isNaN(port)) fail('--port needs a number');
  const filePath = resolve(file);
  if (!existsSync(filePath)) fail(`file not found: ${filePath}`);
  const extension = extname(filePath).toLowerCase();
  if (extension && !MARKDOWN_EXTS.includes(extension) && !HTML_EXTS.includes(extension)
    && !TEXT_EXTS.includes(extension)) fail(`unsupported file type; accepted formats: ${ACCEPTED_FORMATS}`);
  return { filePath, extension, out, port, open };
}

function sessionStateFile(realFilePath) {
  return join(SESSIONS_DIR, createHash('sha256').update(realFilePath).digest('hex') + '.json');
}

function validateSessionRecord(record, realFilePath) {
  if (!record || record.version !== 1 || record.file !== realFilePath || !Number.isSafeInteger(record.pid) || record.pid < 1) {
    throw new Error('saved data is invalid');
  }
  if (record.starting === true) return record;
  if (typeof record.link !== 'string' || !record.state || typeof record.state !== 'object') throw new Error('saved data is invalid');
  sessionUrl(record.link);
  return record;
}

function readSessionRecord(realFilePath, path = sessionStateFile(realFilePath)) {
  try { return validateSessionRecord(JSON.parse(readFileSync(path, 'utf8')), realFilePath); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot recover the unfinished review: ${error.message}`);
  }
}

function processRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function sessionClaimFiles(realFilePath) {
  const name = basename(sessionStateFile(realFilePath)) + '.claim-';
  try { return readdirSync(SESSIONS_DIR).filter((entry) => entry.startsWith(name)).map((entry) => join(SESSIONS_DIR, entry)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function claimSessionRecord(realFilePath) {
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  const destination = sessionStateFile(realFilePath);
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = readSessionRecord(realFilePath);
    if (existing?.starting) {
      if (processRunning(existing.pid)) throw new Error('another review session is already starting for this document');
      rmSync(destination, { force: true });
      continue;
    }
    if (existing) {
      if (processRunning(existing.pid)) throw new Error('another review session is already running for this document');
      const claim = `${destination}.claim-${process.pid}-${randomBytes(6).toString('hex')}`;
      try { renameSync(destination, claim); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      return { record: readSessionRecord(realFilePath, claim), claim };
    }
    const claims = sessionClaimFiles(realFilePath);
    const liveClaim = claims.find((path) => {
      const pid = Number(path.match(/\.claim-(\d+)-/)?.[1]);
      return Number.isSafeInteger(pid) && processRunning(pid);
    });
    if (liveClaim) throw new Error('another review session is already recovering this document');
    if (claims.length) {
      try { renameSync(claims[0], destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      continue;
    }
    let descriptor;
    try {
      descriptor = openSync(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      writeFileSync(descriptor, JSON.stringify({ version: 1, file: realFilePath, pid: process.pid, starting: true }) + '\n');
      closeSync(descriptor);
      return { record: null, claim: null };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('another review session is already starting for this document');
}

function clearSessionClaims(realFilePath) {
  for (const path of sessionClaimFiles(realFilePath)) rmSync(path, { force: true });
}

function writeSessionRecord(realFilePath, link, state) {
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  const destination = sessionStateFile(realFilePath);
  const temporary = join(SESSIONS_DIR, `.session-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, file: realFilePath, link, pid: process.pid, state }) + '\n', { mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

async function runReview(args) {
  const options = reviewOptions(args);
  const realFilePath = realpathSync(options.filePath);
  const record = readSessionRecord(realFilePath);
  if (record?.starting && processRunning(record.pid)) throw new Error('a review session is already starting for this document');
  if (record && !record.starting) {
    try {
      const url = sessionUrl(record.link);
      const [sessionResponse, documentResponse] = await Promise.all([
        fetch(new URL('/session' + url.search, url), { signal: AbortSignal.timeout(1500) }),
        fetch(new URL('/doc' + url.search, url), { signal: AbortSignal.timeout(1500) }),
      ]);
      if (!sessionResponse.ok || !documentResponse.ok) throw new Error('session unavailable');
      const state = await sessionResponse.json();
      const document = await documentResponse.json();
      if (realpathSync(document.path) !== realFilePath) throw new Error('saved session points to another document');
      process.stderr.write(`redpen: resuming ${options.filePath}\nredpen: ${url.href}\nredpen: waiting for feedback from the browser...\n`);
      if (options.open) openBrowser(url.href);
      const after = state.waiting || state.closed ? Math.max(0, state.nextTurn - 2) : state.nextTurn - 1;
      await sessionCommand('wait', [url.href, '--after', String(after)]);
      return;
    } catch (error) {
      if (error.message === 'saved session points to another document') throw error;
      if (processRunning(record.pid)) throw new Error('the saved review session is running but not responding');
      // The durable state below starts a replacement worker and URL.
    }
  }
  startReview(fileURLToPath(import.meta.url), args);
}

function serve(args) {
  const { filePath, extension, out, port, open } = reviewOptions(args);
  let text;
  try {
    const bytes = readFileSync(filePath);
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('binary content');
  } catch (e) {
    fail(`cannot read ${filePath}: ${e.message}`);
  }
  const rendering = MARKDOWN_EXTS.includes(extension) ? 'markdown'
    : HTML_EXTS.includes(extension) ? 'html' : 'plain';
  let assetRoot;
  try {
    // Asset access is rooted at the document's real directory, not a path that
    // happens to contain a symlink to it.
    assetRoot = dirname(realpathSync(filePath));
  } catch (error) {
    fail(`cannot resolve document directory: ${error.message}`);
  }
  const realFilePath = realpathSync(filePath);
  const claimedSession = claimSessionRecord(realFilePath);
  const savedSession = claimedSession.record;
  let sessionLink = savedSession?.link || '';
  const token = randomBytes(16).toString('hex');
  // The running page gets its own key. It never sees the session token, so its
  // scripts cannot read or change the review.
  const livePrefix = `/live/${randomBytes(16).toString('hex')}/`;
  const livePage = livePrefix + encodeURIComponent(basename(realFilePath));
  const liveSnapshotJs = readFileSync(join(PKG_ROOT, 'ui', 'live-snapshot.js'), 'utf8');
  const resourceState ={ token, cssRequests: new Set(), cssPaths: new Set(), cssBytes: 0, cssEdges: new Map(), warnings: new Map() };
  const html = readFileSync(join(PKG_ROOT, 'ui', 'index.html'), 'utf8').replaceAll('__REDPEN_TOKEN__', token);
  const markedJs = readFileSync(join(PKG_ROOT, 'ui', 'marked.min.js'), 'utf8');
  const mermaidJs = readFileSync(join(PKG_ROOT, 'ui', 'mermaid.min.js'), 'utf8');
  const favicon = readFileSync(join(PKG_ROOT, 'ui', 'pen.svg'), 'utf8');
  const session = createReviewSession({
    formatReport: (feedback) => formatReport(feedback, filePath),
    reloadDocument() {
      if (realpathSync(filePath) !== realFilePath) throw new Error('document target changed');
      const updated = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(filePath));
      if (updated.includes('\0')) throw new Error('binary content');
      text = updated;
      for (const value of Object.values(resourceState)) if (value instanceof Map || value instanceof Set) value.clear();
      resourceState.cssBytes = 0;
    },
    onFeedback(report) {
      if (out) writeFileSync(resolve(out), report);
      if (process.connected) process.send({ type: 'feedback', report });
    },
    initialState: savedSession?.state || null,
    persistState(state) { writeSessionRecord(realFilePath, sessionLink, state); },
    clearState() { rmSync(sessionStateFile(realFilePath), { force: true }); },
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (rendering === 'html' && url.pathname.startsWith(livePrefix)) {
      if (url.pathname === livePage) return sendLivePage(req, res, text, liveSnapshotJs);
      return handleLiveAsset(req, res, url.pathname.slice(livePrefix.length), assetRoot);
    }
    // Do not accept a token mixed with additional query parameters.
    if (url.search !== `?t=${token}`) return send(res, 403, 'text/plain', 'forbidden');
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${server.address().port}`) {
      return send(res, 403, 'text/plain', 'forbidden');
    }
    if (session.handle(req, res, url.pathname)) return;
    if (req.method === 'GET' && url.pathname === '/pen.svg') return send(res, 200, 'image/svg+xml', favicon);
    if (req.method === 'GET' && url.pathname === '/marked.min.js') {
      return send(res, 200, 'text/javascript; charset=utf-8', markedJs);
    }
    if (req.method === 'GET' && url.pathname === '/mermaid.min.js') {
      return send(res, 200, 'text/javascript; charset=utf-8', mermaidJs);
    }
    if (url.pathname.startsWith('/asset/')) return handleAsset(req, res, url, assetRoot, resourceState, 'image');
    if (url.pathname.startsWith('/background/')) return handleAsset(req, res, url, assetRoot, resourceState, 'background');
    if (url.pathname.startsWith('/svg/')) return handleAsset(req, res, url, assetRoot, resourceState, 'svg');
    if (url.pathname.startsWith('/css/')) return handleCss(req, res, url, assetRoot, resourceState);
    if (url.pathname.startsWith('/font/')) return handleFont(req, res, url, assetRoot, resourceState);
    if (req.method === 'POST' && url.pathname === '/css-inline') return handleInlineCss(req, res, resourceState);
    if (req.method === 'GET' && url.pathname === '/warnings') return send(res, 200, 'application/json', JSON.stringify(compactWarnings(resourceState)));
    if (req.method === 'POST' && url.pathname === '/warn') return handleWarning(req, res, resourceState);
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', html);
    }
    if (req.method === 'GET' && url.pathname === '/settings/theme') {
      return send(res, 200, 'application/json', JSON.stringify({ theme: readThemeSetting() }));
    }
    if (req.method === 'POST' && url.pathname === '/settings/theme') {
      return handleThemeSetting(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/doc') {
      const live = rendering === 'html' ? livePage : null;
      const body = JSON.stringify({ name: basename(filePath), path: filePath, rendering, text, base: '', revision: session.revision, live });
      return send(res, 200, 'application/json', body);
    }
    send(res, 404, 'text/plain', 'not found');
  });

  function handleThemeSetting(req, res) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let theme;
      try {
        ({ theme } = JSON.parse(body));
      } catch {
        return send(res, 400, 'application/json', JSON.stringify({ error: 'Theme must be auto, light, or dark.' }));
      }
      if (!['auto', 'light', 'dark'].includes(theme)) {
        return send(res, 400, 'application/json', JSON.stringify({ error: 'Theme must be auto, light, or dark.' }));
      }
      try {
        writeThemeSetting(theme);
      } catch (error) {
        return send(res, 500, 'application/json', JSON.stringify({ error: `Could not save theme setting: ${error.message}` }));
      }
      send(res, 200, 'application/json', JSON.stringify({ theme }));
    });
  }

  server.listen(port, '127.0.0.1', () => {
    const link = `http://127.0.0.1:${server.address().port}/?t=${token}`;
    sessionLink = link;
    session.setLink(link);
    clearSessionClaims(realFilePath);
    process.stderr.write(`redpen: annotating ${filePath}\n`);
    process.stderr.write(`redpen: ${link}\n`);
    process.stderr.write('redpen: waiting for feedback from the browser...\n');
    if (open) openBrowser(link);
    const pendingReport = session.pendingReport;
    if (pendingReport && process.connected) process.send({ type: 'feedback', report: pendingReport });
  });
}

function settingsFile() {
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'redpen', 'settings.json');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'redpen', 'settings.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'redpen', 'settings.json');
  return join(homedir(), '.config', 'redpen', 'settings.json');
}

function readThemeSetting() {
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    return ['auto', 'light', 'dark'].includes(settings?.theme) ? settings.theme : 'auto';
  } catch {
    return 'auto';
  }
}

function writeThemeSetting(theme) {
  const dir = dirname(SETTINGS_FILE);
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `.settings-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ theme }) + '\n', { mode: 0o600 });
    renameSync(temporary, SETTINGS_FILE);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // The app is intentionally self-contained: only bundled scripts, its own
    // tokenized endpoints, sanitized blob images, and checked small data images
    // may load. The HTML review frame inherits this policy.
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'self'; media-src 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function decodeAssetPath(url, prefix, extensions) {
  const encoded = url.pathname.slice(prefix.length);
  let localPath;
  try { localPath = decodeURIComponent(encoded); } catch { return null; }
  if (encodeURIComponent(localPath) !== encoded || !isSafeAssetPath(localPath, extensions)) return null;
  return localPath;
}

function handleAsset(req, res, url, root, state, category) {
  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed', { allow: 'GET' });
  const prefix = category === 'background' ? '/background/' : category === 'svg' ? '/svg/' : '/asset/';
  const extensions = category === 'svg' ? new Map([['.svg', IMAGE_TYPES.get('.svg')]]) : IMAGE_TYPES;
  const localPath = decodeAssetPath(url, prefix, extensions);
  if (!localPath) return missing(res, state, category);
  const type = IMAGE_TYPES.get(extname(localPath).toLowerCase());
  let fd;
  try {
    const candidate = resolve(root, localPath);
    const target = realpathSync(candidate);
    if (!isContainedAsset(root, target)) return missing(res, state, category);
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const descriptorStat = fstatSync(fd);
    if (!descriptorStat.isFile() || descriptorStat.size > MAX_IMAGE_BYTES) return missing(res, state, category);
    const postOpenTarget = realpathSync(candidate);
    if (!isContainedAsset(root, postOpenTarget)) return missing(res, state, category);
    const pathStat = statSync(postOpenTarget);
    if (!pathStat.isFile() || pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) return missing(res, state, category);
    const bytes = readOpenFile(fd, descriptorStat.size);
    if (type === 'image/svg+xml' ? !hasSafeSvgRoot(bytes) : !hasImageMagic(bytes, localPath)) return missing(res, state, category);
    return send(res, 200, type, bytes, type === 'image/svg+xml' ? { 'content-security-policy': "default-src 'none'; style-src 'none'; script-src 'none'; img-src 'none'" } : {});
  } catch { return missing(res, state, category); } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Descriptor is already unusable. */ }
    }
  }
}

// The page runs in a sandboxed frame with an opaque origin, even if it is
// opened directly. It may use the network, but it cannot submit forms, open
// windows, reach the review page, or leak its key through the Referer header.
function sendLivePage(req, res, text, snapshotJs) {
  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed', { allow: 'GET' });
  const script = `<script>${snapshotJs}</script>`;
  const head = /<head\b[^>]*>/i.exec(text);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(text);
  const at = head ? head.index + head[0].length : doctype ? doctype[0].length : 0;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox allow-scripts allow-forms; form-action 'none'; frame-ancestors 'self'",
    'referrer-policy': 'no-referrer',
  });
  res.end(text.slice(0, at) + script + text.slice(at));
}

function handleLiveAsset(req, res, encoded, root) {
  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed', { allow: 'GET' });
  let localPath;
  try { localPath = encoded.split('/').map((part) => decodeURIComponent(part)).join('/'); } catch { return send(res, 404, 'text/plain', 'not found'); }
  // Hidden files and folders often hold configuration, so the page never gets them.
  const parts = localPath.split('/');
  if (parts.length !== encoded.split('/').length || parts.some((part) => part.startsWith('.')) || !isSafeAssetPath(localPath, LIVE_TYPES)) {
    return send(res, 404, 'text/plain', 'not found');
  }
  const extension = extname(localPath).toLowerCase();
  try {
    const bytes = readVerifiedAsset(root, localPath, MAX_LIVE_BYTES);
    if (IMAGE_TYPES.has(extension) && (extension === '.svg' ? !hasSafeSvgRoot(bytes) : !hasImageMagic(bytes, localPath))) throw new Error('bad image');
    if (FONT_TYPES.has(extension) && !hasFontMagic(bytes, localPath)) throw new Error('bad font');
    // Fonts load in CORS mode, and the sandboxed page has an opaque origin.
    const headers = FONT_TYPES.has(extension) ? { 'access-control-allow-origin': '*' }
      : extension === '.svg' ? { 'content-security-policy': "default-src 'none'; style-src 'none'; script-src 'none'; img-src 'none'" } : {};
    return send(res, 200, LIVE_TYPES.get(extension), bytes, headers);
  } catch { return send(res, 404, 'text/plain', 'not found'); }
}

function isContainedAsset(root, target) {
  const pathFromRoot = relative(root, target);
  return pathFromRoot !== '' && !pathFromRoot.startsWith('..') && resolve(root, pathFromRoot) === target;
}

function readOpenFile(fd, size) {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw new Error('asset changed while reading');
    offset += count;
  }
  return bytes;
}

function isSafeAssetPath(value, extensions) {
  if (!value || value.length > 1024 || /[%\\\u0000-\u001f\u007f-\u009f]/.test(value)
    || value.startsWith('/') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..')
    && extensions.has(extname(value).toLowerCase());
}

function isSafeImagePath(value) { return isSafeAssetPath(value, IMAGE_TYPES); }

async function handleCss(req, res, url, root, state) {
  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed', { allow: 'GET' });
  const localPath = decodeAssetPath(url, '/css/', CSS_TYPES);
  if (!localPath) return missing(res, state, 'css');
  if (!state.cssRequests.has(localPath)) {
    if (state.cssRequests.size >= MAX_CSS_IMPORTS) return missing(res, state, 'css');
    state.cssRequests.add(localPath);
  }
  try {
    const bytes = readVerifiedAsset(root, localPath, MAX_CSS_BYTES);
    const css = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (css.includes('\0')) throw new Error('NUL in CSS');
    if (!state.cssPaths.has(localPath) && state.cssBytes + bytes.length > MAX_TOTAL_CSS_BYTES) throw new Error('CSS session budget');
    if (!state.cssPaths.has(localPath)) { state.cssPaths.add(localPath); state.cssBytes += bytes.length; }
    return send(res, 200, 'text/css; charset=utf-8', await rewriteCss(css, localPath, url.searchParams.get('t'), state));
  } catch { return missing(res, state, 'css'); }
}

function handleFont(req, res, url, root, state) {
  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'method not allowed', { allow: 'GET' });
  const localPath = decodeAssetPath(url, '/font/', FONT_TYPES);
  if (!localPath) return missing(res, state, 'font');
  try {
    const bytes = readVerifiedAsset(root, localPath, MAX_FONT_BYTES);
    if (!hasFontMagic(bytes, localPath)) throw new Error('bad font signature');
    return send(res, 200, FONT_TYPES.get(extname(localPath).toLowerCase()), bytes);
  } catch { return missing(res, state, 'font'); }
}

function readVerifiedAsset(root, localPath, maxBytes) {
  let fd;
  try {
    const candidate = resolve(root, localPath);
    const target = realpathSync(candidate);
    if (!isContainedAsset(root, target)) throw new Error('outside root');
    fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('invalid file');
    const post = realpathSync(candidate);
    const pathStat = statSync(post);
    if (!isContainedAsset(root, post) || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) throw new Error('changed');
    return readOpenFile(fd, stat.size);
  } finally { if (fd !== undefined) closeSync(fd); }
}

async function rewriteCss(css, sourcePath, token = '__REDPEN_TOKEN__', state, declaration = false) {
  const root = postcss.parse(declaration ? `:root{${css}}` : css);
  root.walkAtRules('import', (rule) => {
    const parsed = valueParser(rule.params);
    const node = parsed.nodes.find((item) => item.type === 'string' || (item.type === 'function' && item.value.toLowerCase() === 'url'));
    const raw = node?.type === 'string' ? node.value : urlNodeValue(node?.nodes);
    const target = localResourcePath(raw, sourcePath, CSS_TYPES);
    const route = target && localResourceUrl(raw, sourcePath, 'css', token);
    if (!route || !registerCssImport(state, sourcePath, target)) { recordWarning(state, 'css'); rule.remove(); return; }
    node.type = 'string'; node.quote = '"'; node.value = route; node.nodes = undefined;
    rule.params = parsed.toString();
  });
  root.walkDecls((decl) => {
    const parsed = valueParser(decl.value);
    parsed.walk((node) => {
      if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
      const raw = urlNodeValue(node.nodes);
      const category = FONT_TYPES.has(extname(raw.split(/[?#]/, 1)[0]).toLowerCase()) ? 'font' : 'background';
      const route = localResourceUrl(raw, sourcePath, undefined, token, category);
      if (!route) { recordWarning(state, category); node.type = 'word'; node.value = 'none'; node.nodes = undefined; return; }
      node.nodes = [{ type: 'string', quote: '"', value: route }];
    });
    decl.value = parsed.toString();
  });
  if (!declaration) return root.toString();
  const block = root.first?.toString() || '';
  return block.slice(block.indexOf('{') + 1, -1);
}

function urlNodeValue(nodes = []) {
  return nodes.length === 1 && nodes[0].type === 'string' ? nodes[0].value : valueParser.stringify(nodes).trim();
}

function localResourcePath(raw, sourcePath, extensions) {
  if (!raw || /^data:/i.test(raw) || /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  const clean = raw.split(/[?#]/, 1)[0];
  const target = clean.startsWith('/') ? clean.slice(1) : sourcePath ? join(dirname(sourcePath), clean) : clean;
  return isSafeAssetPath(target, extensions) ? target : null;
}

function registerCssImport(state, source, target) {
  if (!state || !source || !target) return true;
  if (source === target) return false;
  const pending = [target];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === source) return false;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(state.cssEdges.get(current) || []));
  }
  if (!state.cssEdges.has(source)) state.cssEdges.set(source, new Set());
  state.cssEdges.get(source).add(target);
  return true;
}

function localResourceUrl(raw, sourcePath, force, token = '__REDPEN_TOKEN__', category = 'background') {
  if (!raw || /^data:/i.test(raw)) return safeDataUrl(raw) ? raw : null;
  if (force !== 'css' && /^#[\w:.-]+$/.test(raw)) return raw;
  const target = localResourcePath(raw, sourcePath, force === 'css' ? CSS_TYPES : new Map([...IMAGE_TYPES, ...FONT_TYPES]));
  if (!target) return null;
  const extension = extname(target).toLowerCase();
  const kind = force === 'css' ? 'css' : FONT_TYPES.has(extension) ? 'font' : category === 'background' ? 'background' : 'asset';
  return `/${kind}/${encodeURIComponent(target)}?t=${token}`;
}

function safeDataUrl(value) {
  if (!/^data:(?:image\/(?:png|jpeg|gif|webp|avif)|font\/(?:woff2?|ttf|otf));base64,[a-z\d+/=]+$/i.test(value || '')) return false;
  return Buffer.byteLength(value, 'utf8') <= MAX_DATA_BYTES;
}

function recordWarning(state, category) {
  if (state && ['css', 'font', 'background', 'image', 'svg'].includes(category)) {
    state.warnings.set(category, (state.warnings.get(category) || 0) + 1);
  }
}

function compactWarnings(state) {
  return Object.fromEntries([...state.warnings].sort(([first], [second]) => first.localeCompare(second)));
}

function missing(res, state, category) {
  recordWarning(state, category);
  return send(res, 404, 'text/plain', 'not found');
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > maxBytes) return reject(new Error('request too large'));
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('bad JSON')); }
    });
    req.on('error', reject);
  });
}

async function handleInlineCss(req, res, state) {
  try {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Error('content type');
    const { css, declaration = false } = await readJsonBody(req, MAX_INLINE_CSS_BYTES);
    if (typeof css !== 'string' || typeof declaration !== 'boolean' || Buffer.byteLength(css, 'utf8') > MAX_INLINE_CSS_BYTES || css.includes('\0')) throw new Error('bad CSS');
    const text = await rewriteCss(css, '', state.token, state, declaration);
    return send(res, 200, 'application/json', JSON.stringify({ css: text }));
  } catch {
    recordWarning(state, 'css');
    return send(res, 400, 'application/json', JSON.stringify({ error: 'bad CSS' }));
  }
}

async function handleWarning(req, res, state) {
  try {
    const { category } = await readJsonBody(req, 256);
    if (!['css', 'font', 'background', 'image', 'svg'].includes(category)) throw new Error('bad warning');
    recordWarning(state, category);
    return send(res, 204, 'text/plain', '');
  } catch { return send(res, 400, 'text/plain', 'bad warning'); }
}

function hasFontMagic(bytes, sourcePath) {
  const ext = extname(sourcePath).toLowerCase();
  const tag = bytes.subarray(0, 4).toString();
  if (ext === '.woff') return bytes.length >= 44 && tag === 'wOFF' && bytes.readUInt32BE(8) === bytes.length;
  if (ext === '.woff2') return bytes.length >= 48 && tag === 'wOF2' && bytes.readUInt32BE(8) === bytes.length;
  if (ext === '.ttf' || ext === '.otf') {
    const expected = ext === '.otf' ? 'OTTO' : null;
    return bytes.length >= 12 && (expected ? tag === expected : tag === 'true' || bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])))
      && bytes.length >= 12 + bytes.readUInt16BE(4) * 16;
  }
  return false;
}

function hasSafeSvgRoot(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return !text.includes('\0') && !/<!doctype/i.test(text) && /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text);
  } catch { return false; }
}

function hasImageMagic(bytes, sourcePath) {
  const ext = extname(sourcePath).toLowerCase();
  if (ext === '.png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === '.jpg' || ext === '.jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (ext === '.gif') return bytes.length >= 6 && (bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a');
  if (ext === '.webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (ext === '.avif') {
    if (bytes.length < 16 || bytes.subarray(4, 8).toString() !== 'ftyp') return false;
    const brands = bytes.subarray(8, Math.min(bytes.length, 64)).toString('ascii');
    return /avif|avis/.test(brands);
  }
  return false;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The URL is already on stderr; the user can open it by hand.
  }
}

function reportText(value, limit) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}
function reportContextValue(value, limit) {
  const text = reportText(value, limit);
  return /(?:token|nonce|session|secret|password|authorization)/i.test(text) ? '' : text;
}
function safeHtmlExcerpt(value) {
  const html = reportText(value, 1200);
  if (!html.startsWith('<') || /<(?:script|style|template|textarea|option)\b/i.test(html)
    || /\s(?:hidden|inert|data-[a-z\d_-]+|on[a-z\d_-]+|srcdoc|value|selected|href|src|style|action|formaction|nonce)\b/i.test(html)) return '';
  const allowed = new Set(['id', 'class', 'role', 'aria-label', 'alt', 'type']);
  const tags = html.match(/<\/?[a-z][^>]*>/gi);
  if (!tags) return '';
  for (const tag of tags) {
    const names = [...tag.matchAll(/\s([a-z][a-z\d:-]*)(?:\s*=|\s|>)/gi)].map((match) => match[1].toLowerCase());
    if (names.some((name) => !allowed.has(name))) return '';
    const classValue = tag.match(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (classValue && /(?:^|\s)(?:block-hover|image-placeholder)(?:\s|$)/.test(classValue[1] ?? classValue[2] ?? classValue[3])) return '';
  }
  return /(?:token|nonce|session|secret|password|authorization)/i.test(html) ? '' : html;
}
function reportLocationValue(value, limit) {
  const text = reportContextValue(value, limit);
  return /(?:url\s*\(|(?:https?|javascript|data|vbscript):|\/\/)/i.test(text) ? '' : text;
}
function reportLocationIdentity(value, limit) {
  const text = reportLocationValue(value, limit);
  return /^[a-z\d_-]+$/i.test(text) ? text : '';
}
function reportLocationRole(value) {
  const text = reportLocationValue(value, 80);
  return /^[a-z][a-z\d-]*$/i.test(text) ? text : '';
}
function validReportLocationSelector(selector) {
  return typeof selector === 'string' && selector.length <= 800
    && /^body(?: #(?:[a-z_][a-z\d_-]*|-[a-z_][a-z\d_-]*|--[a-z\d_-]+)|(?: > [a-z][a-z\d-]*:nth-of-type\([1-9]\d{0,4}\))+)$/i.test(selector);
}
function reportElementLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const tag = reportLocationValue(value.tag, 40).toLowerCase();
  const selector = reportLocationValue(value.selector, 800);
  if (typeof value.selector !== 'string' || value.selector.length > 800
    || !/^[a-z][a-z\d-]*$/.test(tag) || !validReportLocationSelector(selector)) return null;
  const id = reportLocationIdentity(value.id, 120);
  const idSelector = /^body #(.+)$/i.exec(selector);
  const structuralSelector = / > ([a-z][a-z\d-]*):nth-of-type\([1-9]\d{0,4}\)$/i.exec(selector);
  if (idSelector ? id !== idSelector[1] : tag !== structuralSelector?.[1].toLowerCase()) return null;
  const role = reportLocationRole(value.role);
  const classes = Array.isArray(value.classes) ? value.classes.map((item) => reportLocationIdentity(item, 80))
    .filter(Boolean).slice(0, 8) : [];
  return { selector, tag, role, id, classes };
}
function reportElementContext(value) {
  if (!value || typeof value !== 'object') return null;
  const tag = reportContextValue(value.tag, 40).toLowerCase();
  const selector = reportContextValue(value.selector, 800);
  if (!/^[a-z][a-z\d-]*$/.test(tag) || !selector.startsWith('body ')) return null;
  const classes = Array.isArray(value.classes) ? value.classes.map((item) => reportContextValue(item, 80))
    .filter((item) => /^[a-z\d_-]+$/i.test(item)).slice(0, 8) : [];
  return {
    selector, tag, role: reportContextValue(value.role, 80), id: reportContextValue(value.id, 120), classes,
    text: reportText(value.text, 500), html: safeHtmlExcerpt(value.html),
  };
}

function formatReport({ action, general, annotations = [] }, filePath) {
  const safeAnnotations = Array.isArray(annotations) ? annotations.slice(0, 200) : [];
  const lines = [`ACTION: ${action}`, `FILE: ${filePath}`, ''];
  const generalText = typeof general === 'string' ? general.trim() : '';
  if (generalText) lines.push('## General Comment', '', generalText, '');
  if (safeAnnotations.length > 0) {
    lines.push(`## Annotations (${safeAnnotations.length})`, '');
    safeAnnotations.forEach((annotation, index) => {
      const elementTarget = annotation?.target === 'element';
      const context = elementTarget ? reportElementContext(annotation.context) : null;
      lines.push(`### Annotation ${index + 1}`, '');
      if (annotation?.unavailable) lines.push('Reference unavailable: this comment refers to an earlier document version. Confirm its target before editing.', '');
      if (elementTarget) {
        const safe = context || { selector: '(unavailable)', tag: '(unavailable)', role: '', id: '', classes: [], text: '', html: '' };
        lines.push(
          'Element Context:', '', `Selector: ${safe.selector}`, `Tag: ${safe.tag}`,
          `Role: ${safe.role || '(none)'}`, `Id: ${safe.id || '(none)'}`,
          `Classes: ${safe.classes.length ? safe.classes.join(', ') : '(none)'}`,
          '', 'Visible Text:', '', `> ${safe.text || '(none)'}`,
          '', 'HTML Excerpt:', '', `    ${safe.html || '(none)'}`,
          '', 'Comment:', '', String(annotation.comment ?? '').trim(), '',
        );
        return;
      }
      const quote = String(annotation?.quote ?? '');
      lines.push('Quote:', '');
      for (const line of quote.split('\n')) lines.push(`> ${line}`);
      lines.push('', 'Location:', '');
      if (annotation?.unavailable) {
        lines.push('This quote no longer has a confirmed match.', '');
      } else if (Number(annotation?.occurrences) > 1) {
        const before = reportText(annotation.prefix, 200);
        const after = reportText(annotation.suffix, 200);
        lines.push(`This quote appears ${Math.min(Number(annotation.occurrences), 10000)} times. This one follows "${before}" and precedes "${after}".`, '');
      } else {
        lines.push('This quote has a unique match.', '');
      }
      const elementLocation = !elementTarget ? reportElementLocation(annotation?.elementLocation) : null;
      if (elementLocation) {
        lines.push(
          'Element Location:', '', `Selector: ${elementLocation.selector}`, `Tag: ${elementLocation.tag}`,
          `Role: ${elementLocation.role || '(none)'}`, `Id: ${elementLocation.id || '(none)'}`,
          `Classes: ${elementLocation.classes.length ? elementLocation.classes.join(', ') : '(none)'}`, '',
        );
      }
      lines.push('Comment:', '', String(annotation?.comment ?? '').trim(), '');
    });
  }
  if (!generalText && safeAnnotations.length === 0) lines.push('No comments were left. The user accepts the document as-is.', '');
  return lines.join('\n');
}

// ------------------------------------------------------ install/uninstall

function resolveAgentNames(names) {
  const known = Object.keys(AGENTS);
  if (names.length === 0) {
    fail(`specify agents: ${known.join(', ')}, or "all"`);
  }
  if (names.length === 1 && names[0] === 'all') return known;
  for (const n of names) {
    if (!AGENTS[n]) fail(`unknown agent: ${n} (known: ${known.join(', ')})`);
  }
  return [...new Set(names)];
}

function removeOwnedLegacy(name, legacy) {
  if (!legacy || !existsSync(legacy.file)) return;
  const expected = readFileSync(join(PKG_ROOT, 'agents', legacy.template), 'utf8');
  try {
    if (readFileSync(legacy.file, 'utf8') !== expected) throw new Error('modified');
  } catch {
    process.stderr.write(`redpen: warning: preserved modified legacy file for ${name}: ${legacy.file}\n`);
    return;
  }
  rmSync(legacy.file);
  process.stderr.write(`redpen: removed legacy file for ${name}: ${legacy.file}\n`);
}

function install(names) {
  const content = readFileSync(join(PKG_ROOT, 'agents', 'skill.md'), 'utf8');
  for (const name of resolveAgentNames(names)) {
    const { file, legacy } = AGENTS[name];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    process.stderr.write(`redpen: installed for ${name}: ${file}\n`);
    removeOwnedLegacy(name, legacy);
  }
}

function uninstall(names) {
  for (const name of resolveAgentNames(names)) {
    const { file, legacy } = AGENTS[name];
    if (!existsSync(file)) {
      process.stderr.write(`redpen: not installed for ${name}\n`);
    } else {
      rmSync(file);
      const dir = dirname(file);
      if (basename(dir) === 'redpen' && readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true });
      }
      process.stderr.write(`redpen: removed for ${name}: ${file}\n`);
    }
    removeOwnedLegacy(name, legacy);
  }
}
