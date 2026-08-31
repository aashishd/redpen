import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'redpen.mjs');
const SKILL = readFileSync(join(ROOT, 'agents', 'skill.md'), 'utf8');
const LEGACY = {
  codex: { file: '.codex/prompts/redpen.md', template: 'codex.md' },
  opencode: { file: '.config/opencode/command/redpen.md', template: 'opencode.md' },
  gemini: { file: '.gemini/commands/redpen.toml', template: 'gemini.toml' },
};
const SKILL_FILES = [
  '.claude/skills/redpen/SKILL.md',
  '.pi/agent/skills/redpen/SKILL.md',
  '.agents/skills/redpen/SKILL.md',
  '.config/opencode/skills/redpen/SKILL.md',
  '.gemini/skills/redpen/SKILL.md',
];

function withHome(t) {
  const temp = mkdtempSync(join(tmpdir(), 'redpen-install-'));
  const home = join(temp, 'home');
  mkdirSync(home);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return home;
}

function write(home, file, content) {
  const path = join(home, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function legacyTemplate(agent) {
  return readFileSync(join(ROOT, 'agents', LEGACY[agent].template), 'utf8');
}

function run(home, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('install all writes the shared native skill for every harness', (t) => {
  const home = withHome(t);
  run(home, 'install', 'all');

  for (const file of SKILL_FILES) assert.equal(readFileSync(join(home, file), 'utf8'), SKILL, file);
  assert.match(SKILL, /^---\nname: redpen\ndescription: .+\n---/);
});

for (const agent of Object.keys(LEGACY)) {
  test(`install removes an exact ${agent} legacy template`, (t) => {
    const home = withHome(t);
    write(home, LEGACY[agent].file, legacyTemplate(agent));

    run(home, 'install', agent);

    assert.equal(existsSync(join(home, LEGACY[agent].file)), false);
  });

  test(`uninstall removes an exact ${agent} legacy template`, (t) => {
    const home = withHome(t);
    run(home, 'install', agent);
    write(home, LEGACY[agent].file, legacyTemplate(agent));

    run(home, 'uninstall', agent);

    assert.equal(existsSync(join(home, LEGACY[agent].file)), false);
  });
}

for (const agent of Object.keys(LEGACY)) {
  test(`install preserves a modified ${agent} legacy file`, (t) => {
    const home = withHome(t);
    const modified = `user-maintained ${agent} legacy file\n`;
    write(home, LEGACY[agent].file, modified);

    const result = run(home, 'install', agent);

    assert.equal(readFileSync(join(home, LEGACY[agent].file), 'utf8'), modified);
    assert.match(result.stderr, new RegExp(`warning: preserved modified legacy file for ${agent}`));
  });

  test(`uninstall preserves a modified ${agent} legacy file`, (t) => {
    const home = withHome(t);
    const modified = `user-maintained ${agent} legacy file\n`;
    run(home, 'install', agent);
    write(home, LEGACY[agent].file, modified);

    const result = run(home, 'uninstall', agent);

    assert.equal(readFileSync(join(home, LEGACY[agent].file), 'utf8'), modified);
    assert.match(result.stderr, new RegExp(`warning: preserved modified legacy file for ${agent}`));
  });
}

test('uninstall keeps a non-empty native skill directory', (t) => {
  const home = withHome(t);
  run(home, 'install', 'claude');
  const skillDirectory = '.claude/skills/redpen';
  write(home, `${skillDirectory}/notes.txt`, 'user content\n');

  run(home, 'uninstall', 'claude');

  assert.equal(existsSync(join(home, `${skillDirectory}/SKILL.md`)), false);
  assert.equal(readFileSync(join(home, `${skillDirectory}/notes.txt`), 'utf8'), 'user content\n');
});

test('help describes skills rather than universal slash commands', (t) => {
  const home = withHome(t);
  const result = run(home, '--help');
  assert.match(result.stderr, /Install the RedPen skill for agents/);
  assert.doesNotMatch(result.stderr, /Install the \/redpen command/);
});
