'use strict';

// Agent boundary checks owned by the controller. Everything here is deterministic and runs outside
// the agent: the prompt only asks the agent to stay inside its lane, these functions are what
// actually notices when it did not. Pure where possible so boundary.test.js can cover them without
// spawning claude.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isProtectedPath } = require('../profile/path-patterns');

// --- scrubbed environment for the agent and for agent-written code (tests run by the gate) ---

// Exact names (case-insensitive: Windows env keys are case-insensitive and come as `Path`,
// `SystemRoot`, ...). Enough for `claude`, node, npx and git to start; no tokens of any kind.
const AGENT_ENV_NAMES = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'SHELL',
  'USER',
  'USERNAME',
  'LOGNAME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
]);

// `claude` itself reads its API key / OAuth token and settings from these.
const AGENT_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_'];

const isAgentEnvName = (name) => {
  const upper = name.toUpperCase();
  if (AGENT_ENV_NAMES.has(upper)) return true;
  return AGENT_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
};

// One empty directory per controller process, used as GH_CONFIG_DIR so `gh` started by the
// agent or by agent-written tests does not find the operator's stored login.
let emptyGhConfigDir = null;

function getEmptyGhConfigDir() {
  if (emptyGhConfigDir === null) {
    emptyGhConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-gh-config-'));
  }
  return emptyGhConfigDir;
}

// Credentials that live outside env, reached through HOME (which `claude` itself needs):
//  - git's credential helper (Git Credential Manager, osxkeychain, store): an empty
//    `credential.helper` passed via GIT_CONFIG_* resets the helper list, overriding every config
//    file; no terminal or GUI prompt either.
//  - gh's stored token: GH_CONFIG_DIR points at an empty directory.
// The same values are passed into the sandbox containers (agent.js, workspace.js), where HOME holds
// no operator files in the first place.
const CREDENTIAL_ISOLATION_ENV = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};

// GH_TOKEN, GITHUB_TOKEN, cloud keys, DATABASE_URL etc. are never copied: an allowlist, not a
// denylist, so a secret with a name nobody thought of stays out too.
function buildAgentEnv(sourceEnv, ghConfigDir = getEmptyGhConfigDir()) {
  const env = {};
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (value !== undefined && isAgentEnvName(name)) env[name] = value;
  }
  return { ...env, ...CREDENTIAL_ISOLATION_ENV, GH_CONFIG_DIR: ghConfigDir };
}

// --- `git status --porcelain -z -uall` ---

// -z output: `XY path\0`, and for a rename/copy `XY new\0old\0`. Paths are raw (no quoting), so
// names with spaces or non-ASCII characters come through unchanged, unlike the line format.
function parseStatusZ(output) {
  const parts = output.split('\0');
  const entries = [];
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const isRenameOrCopy = status[0] === 'R' || status[0] === 'C';
    const origPath = isRenameOrCopy ? parts[++index] || null : null;
    entries.push({ status, path: entry.slice(3), origPath });
  }
  return entries;
}

/** Both sides of a rename or copy, otherwise the one path of the entry. */
const entryPaths = (entry) => (entry.origPath ? [entry.path, entry.origPath] : [entry.path]);

// Every changed path (either side of a rename) that a protected pattern covers. Matching is the
// profile's glob semantics (profile/path-patterns.js), case-insensitive: on Windows and macOS
// `.GitHub/workflows/x.yml` IS `.github/...`. Status kind and content do not matter: a new, deleted,
// renamed, type-changed or binary file is judged by its path alone.
function findProtectedChanges(entries, protectedPatterns) {
  const hits = [];
  for (const entry of entries) {
    for (const filePath of entryPaths(entry)) {
      if (isProtectedPath(filePath, protectedPatterns)) hits.push(filePath);
    }
  }
  return hits;
}

// --- package.json / tool configs the gate depends on ---

// Fields that change what the gate or `npm install` executes.
const GUARDED_PACKAGE_FIELDS = [
  'scripts',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'overrides',
  'workspaces',
  'jest',
  'eslintConfig',
];

const TOOL_CONFIG_RE =
  /(^|\/)(jest\.config\.[^/]+|vitest\.(config|workspace)\.[^/]+|eslint\.config\.[^/]+|\.eslintrc(\.[^/]+)?|tsconfig(\.[^/]+)?\.json)$/i;

const isPackageJson = (filePath) => filePath === 'package.json' || filePath.endsWith('/package.json');

const parseJsonOrNull = (text) => {
  if (text === null) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Guarded fields whose value differs between the two texts (`null` text = file absent).
function changedPackageFields(beforeText, afterText) {
  const before = parseJsonOrNull(beforeText);
  const after = parseJsonOrNull(afterText);
  if (before === null || after === null) return ['(unparseable package.json)'];
  return GUARDED_PACKAGE_FIELDS.filter(
    (field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null),
  );
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The path must appear as its own token in `## Affects` — plain substring matching would let
// `pkg/package.json` in Affects excuse a change to the root `package.json`.
function isNamedInAffects(filePath, affectsText) {
  const pattern = new RegExp(`(^|[\\s\`'"(,])${escapeRegExp(filePath)}($|[\\s\`'"),:;])`, 'm');
  return pattern.test(affectsText || '');
}

// `readBefore(path)` -> content at HEAD or null; `readAfter(path)` -> working-tree content or null.
function findUndeclaredToolingChanges(entries, affectsText, readBefore, readAfter) {
  const violations = [];
  for (const entry of entries) {
    for (const filePath of entryPaths(entry)) {
      if (isNamedInAffects(filePath, affectsText)) continue;
      if (isPackageJson(filePath)) {
        const fields = changedPackageFields(readBefore(filePath), readAfter(filePath));
        if (fields.length > 0) violations.push(`${filePath} (${fields.join(', ')})`);
      } else if (TOOL_CONFIG_RE.test(filePath)) {
        violations.push(filePath);
      }
    }
  }
  return violations;
}

// --- .git/ fingerprint (git status never reports changes inside .git itself) ---

// Git's own caches, rewritten by the controller's `git status`/`git show` between turns and not
// able to change what the repository does: the index stat cache, content-addressed objects
// (unreachable without a ref change, which IS fingerprinted), reflogs and lock files. Everything
// else (content and file mode) — config (remotes, hooksPath), hooks, info/exclude (can hide files from git status),
// info/attributes, HEAD, refs, packed-refs — is part of the fingerprint.
const GIT_VOLATILE_RE = /^(index|objects\/.*|logs\/.*|.*\.lock|FETCH_HEAD|ORIG_HEAD)$/;

function listFilesRecursive(dir) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...listFilesRecursive(full));
    else files.push(full);
  }
  return files;
}

function gitMetaFingerprint(runDir) {
  const gitDir = path.join(runDir, '.git');
  const relFiles = listFilesRecursive(gitDir)
    .map((file) => path.relative(gitDir, file).replace(/\\/g, '/'))
    .filter((rel) => !GIT_VOLATILE_RE.test(rel))
    .sort();
  const hash = crypto.createHash('sha256');
  for (const rel of relFiles) {
    hash.update(rel);
    hash.update('\0');
    try {
      const file = path.join(gitDir, rel);
      // Mode too: `chmod +x` on an existing hook makes git run it without changing its content.
      hash.update(String(fs.statSync(file).mode));
      hash.update('\0');
      hash.update(fs.readFileSync(file));
    } catch {
      hash.update('(unreadable)');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

// --- whole-task budget (all agent calls of one issue together) ---

function createTaskBudget({ maxWallClockMs, maxUsd, now = Date.now }) {
  const startedAt = now();
  let spentUsd = 0;

  const remainingMs = () => maxWallClockMs - (now() - startedAt);
  const remainingUsd = () => ((maxUsd ?? null) === null ? null : maxUsd - spentUsd);

  const record = (costUsd) => {
    if (typeof costUsd === 'number' && Number.isFinite(costUsd)) spentUsd += costUsd;
  };

  const exhaustedReason = () => {
    if (remainingMs() <= 0) return `task time budget of ${Math.round(maxWallClockMs / 60000)} min exhausted`;
    const usd = remainingUsd();
    if (usd !== null && usd <= 0) return `task cost budget of $${maxUsd} exhausted (spent $${spentUsd.toFixed(2)})`;
    return null;
  };

  return { record, remainingMs, remainingUsd, exhaustedReason, spentUsd: () => spentUsd };
}

module.exports = {
  CREDENTIAL_ISOLATION_ENV,
  buildAgentEnv,
  parseStatusZ,
  entryPaths,
  escapeRegExp,
  findProtectedChanges,
  changedPackageFields,
  isNamedInAffects,
  findUndeclaredToolingChanges,
  gitMetaFingerprint,
  createTaskBudget,
};
