#!/usr/bin/env node
// redpen — annotate a document in the browser; feedback goes to stdout.
//
// Contract: stdout carries only the feedback report. All status and error
// messages go to stderr, so an agent can capture stdout verbatim.

import { createServer } from 'node:http';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version;
const MARKDOWN_EXTS = ['.md', '.markdown'];
const HTML_EXTS = ['.html', '.htm'];
const TEXT_EXTS = ['.txt'];
const ACCEPTED_FORMATS = '.txt, .md, .markdown, .html, .htm, or an extensionless UTF-8 text file';
const SETTINGS_FILE = settingsFile();

const AGENTS = {
  claude: {
    file: join(homedir(), '.claude', 'skills', 'redpen', 'SKILL.md'),
    template: 'skill.md',
  },
  pi: {
    file: join(homedir(), '.pi', 'agent', 'skills', 'redpen', 'SKILL.md'),
    template: 'skill.md',
  },
  codex: {
    file: join(homedir(), '.codex', 'prompts', 'redpen.md'),
    template: 'codex.md',
  },
  opencode: {
    file: join(homedir(), '.config', 'opencode', 'command', 'redpen.md'),
    template: 'opencode.md',
  },
  gemini: {
    file: join(homedir(), '.gemini', 'commands', 'redpen.toml'),
    template: 'gemini.toml',
  },
};

main(process.argv.slice(2));

function main(argv) {
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION);
    return;
  }
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  const [cmd, ...rest] = argv;
  if (cmd === 'install') return install(rest);
  if (cmd === 'uninstall') return uninstall(rest);
  serve(argv);
}

function printHelp() {
  process.stderr.write(`redpen ${VERSION}: annotate a document in the browser

Usage:
  redpen <file> [options]         Open <file> for annotation; block until the
                                  user submits; print the feedback to stdout.
  redpen install <agent...>       Install the /redpen command for agents.
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
`);
}

function fail(msg) {
  process.stderr.write(`redpen: error: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- serve

function serve(args) {
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
    && !TEXT_EXTS.includes(extension)) {
    fail(`unsupported file type; accepted formats: ${ACCEPTED_FORMATS}`);
  }
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
  const token = randomBytes(16).toString('hex');
  const html = readFileSync(join(PKG_ROOT, 'ui', 'index.html'), 'utf8');
  const markedJs = readFileSync(join(PKG_ROOT, 'ui', 'marked.min.js'), 'utf8');

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/marked.min.js') {
      return send(res, 200, 'text/javascript; charset=utf-8', markedJs);
    }
    if (url.searchParams.get('t') !== token) {
      return send(res, 403, 'text/plain', 'forbidden');
    }
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
      const body = JSON.stringify({ name: basename(filePath), path: filePath, rendering, text });
      return send(res, 200, 'application/json', body);
    }
    if (req.method === 'POST' && url.pathname === '/submit') {
      return handleSubmit(req, res);
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

  function handleSubmit(req, res) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let feedback;
      try {
        feedback = JSON.parse(body);
        if (!['revise', 'close'].includes(feedback.action)) throw new Error('bad action');
      } catch {
        return send(res, 400, 'text/plain', 'bad request');
      }
      const report = formatReport(feedback, filePath);
      process.stdout.write(report);
      if (out) writeFileSync(resolve(out), report);
      process.stderr.write(`redpen: feedback received (${feedback.action})\n`);
      res.on('finish', () => setTimeout(() => process.exit(0), 100));
      send(res, 200, 'application/json', '{"ok":true}');
    });
  }

  server.listen(port, '127.0.0.1', () => {
    const link = `http://127.0.0.1:${server.address().port}/?t=${token}`;
    process.stderr.write(`redpen: annotating ${filePath}\n`);
    process.stderr.write(`redpen: ${link}\n`);
    process.stderr.write('redpen: waiting for feedback from the browser...\n');
    if (open) openBrowser(link);
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

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
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

function formatReport({ action, general, annotations = [] }, filePath) {
  const lines = [`ACTION: ${action}`, `FILE: ${filePath}`, ''];
  const generalText = typeof general === 'string' ? general.trim() : '';
  if (generalText) {
    lines.push('## General Comment', '', generalText, '');
  }
  if (annotations.length > 0) {
    lines.push(`## Annotations (${annotations.length})`, '');
    annotations.forEach((a, i) => {
      lines.push(`### Annotation ${i + 1}`, '', 'Quote:', '');
      for (const q of String(a.quote ?? '').split('\n')) lines.push(`> ${q}`);
      lines.push('');
      if (a.occurrences > 1) {
        const before = String(a.prefix ?? '').trim();
        const after = String(a.suffix ?? '').trim();
        lines.push(
          `Note: this quote appears ${a.occurrences} times in the document. `
          + `This one follows "${before}" and precedes "${after}".`,
          '',
        );
      }
      lines.push('Comment:', '', String(a.comment ?? '').trim(), '');
    });
  }
  if (!generalText && annotations.length === 0) {
    lines.push('No comments were left. The user accepts the document as-is.', '');
  }
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

function install(names) {
  for (const name of resolveAgentNames(names)) {
    const { file, template } = AGENTS[name];
    const content = readFileSync(join(PKG_ROOT, 'agents', template), 'utf8');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    process.stderr.write(`redpen: installed for ${name}: ${file}\n`);
  }
}

function uninstall(names) {
  for (const name of resolveAgentNames(names)) {
    const { file } = AGENTS[name];
    if (!existsSync(file)) {
      process.stderr.write(`redpen: not installed for ${name}\n`);
      continue;
    }
    rmSync(file);
    const dir = dirname(file);
    if (basename(dir) === 'redpen' && readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true });
    }
    process.stderr.write(`redpen: removed for ${name}: ${file}\n`);
  }
}
