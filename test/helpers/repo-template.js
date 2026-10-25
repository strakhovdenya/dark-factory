'use strict';

// Fixture repositories built once per test process and copied for each test. A template is made by
// real git (the build callback runs git; nothing here writes objects, refs or HEAD); a copy is a
// plain directory copy where only the template's own path inside `.git/config` (remote urls,
// `url.<path>.insteadOf` and the section name `url "<path>"`) is rewritten to the path of the copy.
// Template directories live in the system temporary directory and are removed when the process ends.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const realExecFileSync = childProcess.execFileSync;

/** Git in `cwd`, as it was before any test replaced child_process; trimmed output. */
const git = (cwd, ...args) => String(realExecFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();

/** @type {string | null} */
let root = null;
/** @type {Map<string, string>} */
const templates = new Map();
let builds = 0;
let serial = 0;

const templateRoot = () => {
  if (root) return root;
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-templates-')));
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // a leftover temporary directory never fails the process
    }
  });
  root = dir;
  return root;
};

const sortedKeys = (_key, value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
};

/**
 * Runs `build(dir, git)` in a fresh directory. This is the only place where git runs for a template,
 * so the count of builds is raised here. A failed build leaves nothing behind and nothing cached.
 */
const buildTemplate = (build) => {
  builds += 1;
  serial += 1;
  const dir = path.join(templateRoot(), `t${serial}`);
  fs.mkdirSync(dir);
  try {
    build(dir, git);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const posix = (target) => target.split(path.sep).join('/');

/** Config files of the repositories in `dir` and one level below: non-bare (`.git/config`) and bare (`config` beside `HEAD` and `objects`). */
const configFiles = (dir) => {
  const found = [];
  const visit = (current, depth) => {
    if (fs.existsSync(path.join(current, '.git', 'config'))) found.push(path.join(current, '.git', 'config'));
    if (['HEAD', 'objects', 'config'].every((name) => fs.existsSync(path.join(current, name)))) found.push(path.join(current, 'config'));
    if (depth === 0) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') visit(path.join(current, entry.name), depth - 1);
    }
  };
  visit(dir, 1);
  return found;
};

/** The template path as git may have written it (native, native with escaped backslashes, posix) with its replacement. */
const spellings = (from, to) => {
  const pairs = [
    [from.replaceAll('\\', '\\\\'), to.replaceAll('\\', '\\\\')],
    [from, to],
    [posix(from), posix(to)],
  ];
  return pairs.filter(([text], index) => pairs.findIndex(([other]) => other === text) === index);
};

const rewriteConfigs = (from, to) => {
  const pairs = spellings(from, to);
  for (const file of configFiles(to)) {
    let text = fs.readFileSync(file, 'utf8');
    for (const [a, b] of pairs) text = text.replace(new RegExp(`${escapeRegExp(a)}(?![A-Za-z0-9_.-])`, process.platform === 'win32' ? 'gi' : 'g'), () => b);
    fs.writeFileSync(file, text);
  }
};

/**
 * Copies the template for (`kind`, `args`) into the existing directory `dest`. The key is the hash of
 * the whole `args` value, so a new builder option is part of it without any change here. The template
 * is built by `build(dir, git)` on first use and is never handed out.
 */
const copyTemplate = (kind, args, build, dest) => {
  const key = crypto.createHash('sha256').update(JSON.stringify([kind, args ?? null], sortedKeys)).digest('hex');
  let template = templates.get(key);
  if (!template) {
    template = buildTemplate(build);
    templates.set(key, template);
  }
  fs.cpSync(template, dest, { recursive: true, verbatimSymlinks: true });
  rewriteConfigs(template, dest);
  return dest;
};

/** How many templates git has built in this process. */
const templateBuilds = () => builds;

module.exports = { copyTemplate, templateBuilds, templateRoot, git };
