'use strict';

// The per-issue clone of the consumer repository: its lifecycle, dependency installs, dependency
// sync after the agent's edits, the project gate, the DEL_RALPH marker and the agent's
// permissions. Every command that runs project or agent code goes through the sandbox runtime
// (sandbox.js) with the controller's policy; nothing here runs it on the host. Project values
// (install, gate and sync commands, protected paths) come only from the trusted profile.

const fs = require('node:fs');
const path = require('node:path');
const { allChangedPaths, changedFilePathsFromPorcelain } = require('./parsing');
const { git, gitPorcelainStatus } = require('./github');
const { CREDENTIAL_ISOLATION_ENV, parseStatusZ, entryPaths } = require('./boundary');
const { protectedPatternsFor } = require('./config');
const { denyGlobOf, normalizePath } = require('../profile/path-patterns');
const sandbox = require('./sandbox');

const gitStatusZ = (runDir) => gitPorcelainStatus({ cwd: runDir });

// --- per-issue clone ---

// Clone and session journals sit side by side under the runs root: the journals dir is outside
// the clone, so nothing in it ever shows up in the clone's git status.
function runDirFor(runsRoot, id) {
  return path.join(runsRoot, `issue-${id}`);
}

function sessionsRootFor(runsRoot, id) {
  return path.join(runsRoot, `issue-${id}-sessions`);
}

const timestampForFile = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');

// One subfolder per run of an issue (start time), so a re-run never mixes its journals and install
// logs with an earlier run's, and nothing from an earlier run is deleted.
function runSessionsDirFor(runsRoot, id, startedAt = new Date()) {
  return path.join(sessionsRootFor(runsRoot, id), timestampForFile(startedAt));
}

// `box.timeoutMs` is a number or a function returning the time left for one sandbox step.
const stepTimeoutMs = (box) => (typeof box.timeoutMs === 'function' ? box.timeoutMs() : box.timeoutMs);

// Never throws: a best-effort cleanup called from the happy path and from error paths. A process
// left behind can hold a lock on files in runDir (EBUSY on Windows); a leftover directory is
// harmless (the next run for the issue re-clones over it), a crashed controller drops the queue.
function removeRunDirIfExists(runDir) {
  if (!fs.existsSync(runDir)) return;
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch (error) {
    console.log(`⚠️ Не удалось удалить ${runDir} (не критично, продолжаю): ${error.message}`);
  }
}

// While agents run, `origin` has an unusable push URL: git credentials come from the OS credential
// helper, not from env, so a scrubbed env alone would not stop `git push`. The controller restores
// the real URL with enablePush() right before its own pushBranch().
const DISABLED_PUSH_URL = 'no-push://ralph-agent-push-disabled';

// `originUrl` is the origin of the consumer root (github.js originUrlOf()).
function prepareClone(runsRoot, runDir, originUrl) {
  fs.mkdirSync(runsRoot, { recursive: true });
  removeRunDirIfExists(runDir);
  git(['clone', originUrl, runDir], { cwd: runsRoot });
  git(['remote', 'set-url', '--push', 'origin', DISABLED_PUSH_URL], { cwd: runDir });
}

function createTaskBranch(runDir, branchName, baseRef) {
  git(['checkout', '-b', branchName, baseRef], { cwd: runDir });
}

function enablePush(runDir, originUrl) {
  git(['remote', 'set-url', '--push', 'origin', originUrl], { cwd: runDir });
}

// The agent's claude reads its config from CLAUDE_CONFIG_DIR, which is this call's own session dir,
// so the workspace-trust entry is written there for the container path of the clone — the
// operator's ~/.claude.json is never read or written. An untrusted directory silently drops
// permissions.allow entries (Skill(code-review) among them). One fresh dir per agent call: a session
// dir the implementer could write into (settings, hooks) is never reused by a later read-only pass.
function prepareAgentSessionDir(sessionsRoot, label) {
  const dir = path.join(sessionsRoot, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const config = { projects: { [sandbox.CONTAINER_WORKDIR]: { hasTrustDialogAccepted: true } } };
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(config, null, 2) + '\n');
  return dir;
}

// --- apps of the profile ---

// A profile path relative to the root with "/" separators; '' is the root itself.
const rootRelative = (value) => normalizePath(value).replace(/\/+$/, '').replace(/^\.$/, '');

// Whether an app's directory covers a changed path (whole segments; path "." covers everything).
const appCovers = (app, filePath) => {
  const appPath = rootRelative(app.path);
  const target = normalizePath(filePath);
  return appPath === '' || target === appPath || target.startsWith(`${appPath}/`);
};

/** Apps of the profile (in profile order) whose directory covers one of the changed paths. */
function determineTouchedApps(profile, files) {
  return profile.apps.filter((app) => files.some((file) => appCovers(app, file)));
}

/** Every gate command of the profile with its app, in profile order. */
const gateCommandsOf = (profile) => profile.apps.flatMap((app) => (app.gate || []).map((command) => ({ app, command })));

const commandLabel = (command) => `${command.argv.join(' ')} (cwd: ${command.cwd})`;

// --- gate ---

// Gate commands run in the sandbox with no network at all: the tests are agent-written code.
// `.git` is mounted read-only, the profile's installEnv is not passed, every command has a time
// limit. argv goes as it is: no shell and no substitution (`{file}` stays a literal). Returns
// stdout, throws an error carrying stdout/stderr on failure. `box`: { image, rootKey, runLabel,
// timeoutMs?, docker? }.
function createSandboxGateRunner(runDir, box) {
  return (command) => {
    const result = sandbox.runInSandboxSync(
      {
        image: box.image,
        rootKey: box.rootKey,
        runLabel: box.runLabel,
        runDir,
        workdir: rootRelative(command.cwd),
        network: 'none',
        readOnlyGit: true,
        publicEnv: { ...CREDENTIAL_ISOLATION_ENV },
        command: [...command.argv],
      },
      { docker: box.docker, timeoutMs: stepTimeoutMs(box) },
    );
    if (result.status === 0) return result.stdout;
    const reason = result.error ? result.error.message : `exit ${result.status}`;
    throw Object.assign(new Error(`${commandLabel(command)} failed in the sandbox (${reason})`), { stdout: result.stdout, stderr: result.stderr });
  };
}

const secondsSince = (startMs) => Math.round((Date.now() - startMs) / 1000);

// "Is the real project gate green right now" — not the agent's self-report of it. The gate fails
// when the working tree changed while it ran (a check rewriting files is not a green gate). Each
// command is announced before it starts and reported with its duration.
function runProjectGate(runDir, touchedApps, runCommand, log = console.log) {
  if (touchedApps.length === 0) {
    return { ok: true, output: '(no app files touched — gate skipped)' };
  }
  const statusBefore = gitStatusZ(runDir);
  const outputs = [];
  for (const app of touchedApps) {
    for (const command of app.gate || []) {
      const label = `${app.name}: ${commandLabel(command)}`;
      log(`   ⏳ ${label}...`);
      const startMs = Date.now();
      try {
        const out = runCommand(command);
        log(`   ✅ ${label} — ${secondsSince(startMs)}s`);
        outputs.push(`✅ ${label}\n${String(out).slice(-2000)}`);
      } catch (error) {
        log(`   ❌ ${label} — ${secondsSince(startMs)}s`);
        const detail = `${error.stdout || ''}${error.stderr || error.message || ''}`.slice(-4000);
        outputs.push(`❌ ${label}\n${detail}`);
        return { ok: false, output: outputs.join('\n\n') };
      }
    }
  }
  if (gitStatusZ(runDir) !== statusBefore) {
    outputs.push('❌ git status changed while the gate was running — a check modified the working tree.');
    return { ok: false, output: outputs.join('\n\n') };
  }
  return { ok: true, output: outputs.join('\n\n') };
}

// The gate of every app that the porcelain touches: each path of each entry, both sides of a
// rename, deleted and binary files included.
function runProjectGateForPorcelain(runDir, profile, porcelain, runCommand, log) {
  return runProjectGate(runDir, determineTouchedApps(profile, allChangedPaths(porcelain)), runCommand, log);
}

// --- DEL_RALPH marker: the agent marks a file for removal, the controller renames it ---
//
// The agent has no rm/mv permissions: irreversible file mutations are owned by the controller,
// reacting to an explicit, checkable signal. The agent writes `DEL_RALPH: <reason>` as the FIRST
// line of the file it wants removed; the controller finds such files among the run's changed files
// only, renames them to `del_ralph_<name>` (content survives, shows as a rename) and re-runs the
// project gate itself, since the agent's own check ran against the still-conflicting layout.

// Matches ONE line: the bare form or one after a comment token (`//`, `#`, `/*`, `<!--`, `--`).
const DEL_RALPH_MARKER_RE = /^\s*(?:\/\/|#|\/\*|<!--|--)?\s*DEL_RALPH:\s*(.*)$/;

function hasDelRalphMarker(head) {
  const firstLine = head.replace(/^﻿/, '').split(/\r?\n/, 1)[0];
  return DEL_RALPH_MARKER_RE.test(firstLine);
}

// A read right after a failed build in the same dir can transiently get EPERM/EBUSY on Windows;
// two short retries ride out that race without masking a persistent failure.
const MARKER_READ_RETRY_DELAYS_MS = [100, 250];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ENOENT is never retried; any other error is retried, then logged explicitly instead of being
// silently treated as "file removed".
function readFileHeadForMarker(absPath) {
  let lastError;
  for (let attempt = 0; attempt <= MARKER_READ_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return fs.readFileSync(absPath, 'utf8').slice(0, 200);
    } catch (error) {
      lastError = error;
      if (error.code === 'ENOENT') throw error;
      if (attempt < MARKER_READ_RETRY_DELAYS_MS.length) {
        sleepSync(MARKER_READ_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  console.log(`⚠️ DEL_RALPH: не удалось прочитать ${absPath} после ${MARKER_READ_RETRY_DELAYS_MS.length} повторных попыток (${lastError.code || lastError.message}) — файл пропущен, маркер (если он там есть) не будет найден в этом прогоне.`);
  throw lastError;
}

function findDelRalphMarkedFiles(runDir, porcelain) {
  const files = changedFilePathsFromPorcelain(porcelain);
  const marked = [];
  for (const file of files) {
    let head;
    try {
      head = readFileHeadForMarker(path.join(runDir, file));
    } catch {
      continue; // removed, or unreadable after retries (logged above)
    }
    if (hasDelRalphMarker(head)) marked.push(file);
  }
  return marked;
}

// Renames every marked file, then re-runs the gate for whatever the CURRENT diff touches. The
// returned porcelain is refreshed after the rename.
function applyDelRalphRenames(runDir, profile, porcelain, runCommand) {
  const marked = findDelRalphMarkedFiles(runDir, porcelain);
  if (marked.length === 0) return { applied: false, porcelain, gateOk: true, gateOutput: '' };

  for (const file of marked) {
    const absPath = path.join(runDir, file);
    const renamedPath = path.join(path.dirname(absPath), `del_ralph_${path.basename(absPath)}`);
    console.log(`🗑️ DEL_RALPH: переименовываю ${file} -> ${path.relative(runDir, renamedPath).replace(/\\/g, '/')}`);
    fs.renameSync(absPath, renamedPath);
  }

  const gate = runProjectGateForPorcelain(runDir, profile, porcelain, runCommand);
  const freshPorcelain = gitStatusZ(runDir);
  return { applied: true, porcelain: freshPorcelain, gateOk: gate.ok, gateOutput: gate.output };
}

// A still-red gate after the renames becomes a BLOCKED reason: the controller never lets a PR out
// with a build it knows is red.
function handleDelRalphMarkers(runDir, profile, porcelain, runCommand) {
  const result = applyDelRalphRenames(runDir, profile, porcelain, runCommand);
  if (!result.applied) return { porcelain, blockedReason: null };
  if (!result.gateOk) {
    const reason = `DEL_RALPH: renamed marked file(s), but the project gate is still red afterwards — not safe to proceed:\n\n${result.gateOutput}`;
    return { porcelain: result.porcelain, blockedReason: reason };
  }
  console.log('✅ DEL_RALPH: rename applied, project gate green.');
  return { porcelain: result.porcelain, blockedReason: null };
}

// --- dependency installs and sync (sandbox, run network with the proxy) ---

// One install or sync command in the sandbox on the run's proxy network, with the profile's
// validated installEnv as public env (git isolation last, so an entry cannot switch it off). The
// full output goes to a log file in the run's sessions root (outside the clone), named in any
// failure message. `.git` is mounted read-only. `box`: { image, rootKey, runLabel, network,
// proxyUrl, installEnv, logsDir, timeoutMs?, docker? }.
function runInstallStep(runDir, box, { label, command }) {
  fs.mkdirSync(box.logsDir, { recursive: true });
  const logPath = path.join(box.logsDir, `install-${label.replace(/[^A-Za-z0-9_-]+/g, '_')}-${timestampForFile()}.log`);
  const where = commandLabel(command);
  console.log(`📦 ${label}: ${where} (песочница, лог: ${logPath})...`);
  const result = sandbox.runInSandboxSync(
    {
      image: box.image,
      rootKey: box.rootKey,
      runLabel: box.runLabel,
      runDir,
      workdir: rootRelative(command.cwd),
      network: box.network,
      proxyUrl: box.proxyUrl,
      readOnlyGit: true,
      publicEnv: { ...(box.installEnv || {}), ...CREDENTIAL_ISOLATION_ENV },
      command: [...command.argv],
    },
    { docker: box.docker, timeoutMs: stepTimeoutMs(box) },
  );
  const reason = result.error ? result.error.message : `exit ${result.status}`;
  const log = [`$ ${where}  (container: ${result.name})`, '--- stdout', result.stdout, '--- stderr', result.stderr, `--- ${reason}`, ''].join('\n');
  fs.writeFileSync(logPath, log);
  if (result.status === 0) return { ok: true, logPath, error: null };
  return { ok: false, logPath, error: `${label} failed: ${where} (${reason}); full output: ${logPath}` };
}

class InstallError extends Error {
  constructor(message, { step, logPath }) {
    super(message);
    this.name = 'InstallError';
    this.step = step;
    this.logPath = logPath;
  }
}

// The profile's install steps in a fresh clone: the root `install` once, then each app's `install`
// in profile order, commands in array order. Nothing is guessed: an absent list means no command,
// and a given command runs whether or not a manifest exists. The first failure stops everything
// after it (InstallError naming the step, its cwd and the log); there is no host fallback.
function installDependencies(runDir, profile, box) {
  const steps = [
    ...(profile.install || []).map((command, index) => ({ label: `install[${index}]`, command })),
    ...profile.apps.flatMap((app, appIndex) => (app.install || []).map((command, index) => ({ label: `apps[${appIndex}].install[${index}]`, command }))),
  ];
  for (const step of steps) {
    const result = runInstallStep(runDir, box, step);
    if (!result.ok) throw new InstallError(result.error, { step: step.label, logPath: result.logPath });
  }
}

const MANIFEST = 'package.json';

// Areas that serve a changed manifest: the root manifest is served by the root dependencySync and
// by an app with path "."; `<app.path>/package.json` by that app. null for a manifest outside both.
function servingAreasOf(profile, manifestPath) {
  if (manifestPath === MANIFEST) {
    const rootApps = profile.apps.map((app, index) => ({ app, index })).filter(({ app }) => rootRelative(app.path) === '');
    return [{ key: 'root', field: 'dependencySync', commands: profile.dependencySync || [] }, ...rootApps.map(areaOfApp)];
  }
  const owners = profile.apps.map((app, index) => ({ app, index })).filter(({ app }) => rootRelative(app.path) !== '' && `${rootRelative(app.path)}/${MANIFEST}` === manifestPath);
  return owners.length > 0 ? owners.map(areaOfApp) : null;
}

const areaOfApp = ({ app, index }) => ({ key: `app:${index}`, field: `apps[${index}].dependencySync`, commands: app.dependencySync || [], appIndex: index });

// Dependency sync after the agent's last pass and before the final gate. The trigger is decided by
// the core: an entry of git status (either side of a rename, deletions included) whose path is the
// root package.json or exactly `<app.path>/package.json`. Each affected area runs its profile
// commands once (root first, then apps in profile order). Ordinary installs are not repeated.
// BLOCKED (returned as `blockedReason`): a changed manifest none of whose areas has a command, a
// package.json outside the root and the app paths, or any failing command (step, cwd, log).
function syncDependencies(runDir, profile, porcelain, box) {
  const manifests = [...new Set(parseStatusZ(porcelain).flatMap(entryPaths))].filter((file) => path.posix.basename(file) === MANIFEST);
  if (manifests.length === 0) return { ok: true, ran: false, blockedReason: null };

  const affected = new Map();
  for (const manifest of manifests) {
    const areas = servingAreasOf(profile, manifest);
    if (areas === null) {
      return { ok: false, ran: false, blockedReason: `${manifest} changed, but it is neither the root package.json nor <app.path>/package.json of an app in the profile — dependency sync cannot serve it, no commit, no PR.` };
    }
    const withCommands = areas.filter((area) => area.commands.length > 0);
    if (withCommands.length === 0) {
      const fields = areas.map((area) => area.field).join(' or ');
      return { ok: false, ran: false, blockedReason: `${manifest} changed, but the profile has no dependency sync command for it (${fields} is missing) — no commit, no PR.` };
    }
    for (const area of withCommands) affected.set(area.key, area);
  }

  const ordered = [...affected.values()].sort((a, b) => (a.key === 'root' ? -1 : b.key === 'root' ? 1 : a.appIndex - b.appIndex));
  for (const area of ordered) {
    for (const [index, command] of area.commands.entries()) {
      const result = runInstallStep(runDir, box, { label: `${area.field}[${index}]`, command });
      if (!result.ok) {
        return { ok: false, ran: true, blockedReason: `Dependency sync failed before the final gate — no commit, no PR: ${result.error}` };
      }
    }
  }
  return { ok: true, ran: true, blockedReason: null };
}

// --- skills and agent permissions ---

// The real .claude/skills/ directory of the clone, so the permission list and the prompt always
// match the skills that exist there.
function listInstalledSkillNames(runDir) {
  const skillsDir = path.join(runDir, '.claude', 'skills');
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// Git the agent may read: implementation and fix passes get status/diff/log, the review passes
// also show. No commit, push or any other git command, and no gh at all.
const READ_ONLY_GIT = ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)'];
const REVIEW_GIT = [...READ_ONLY_GIT, 'Bash(git show:*)'];

// Denied for every pass, whatever allow says.
const COMMON_DENY = ['Bash(git push*)', 'Bash(git commit*)', 'Bash(gh *)'];

// Check commands come only from the profile's gate: for each command exactly the argv joined by
// single spaces and the same with ` *` for extra arguments. No broad rule (`Bash`, `npm run`, a
// bare package runner) is ever added, and install or sync commands are never granted.
function gateCommandRules(profile) {
  const rules = gateCommandsOf(profile).flatMap(({ command }) => {
    const text = command.argv.join(' ');
    return [`Bash(${text})`, `Bash(${text} *)`];
  });
  return [...new Set(rules)];
}

// Edit/Write deny rules from the protected paths (core and profile); "X/" becomes "X/**". The
// controller's check after every turn decides, these only stop the ordinary attempt early.
const protectedEditDeny = (profile) => protectedPatternsFor(profile).map(denyGlobOf).flatMap((glob) => [`Edit(${glob})`, `Write(${glob})`]);

// settings.local.json is gitignored, so a link planted there by code the run executed would not
// show in git status. The controller never writes through a link: the `.claude` dir must resolve
// inside the clone, an existing file or link is removed first, then the file is created
// exclusively.
function writeSettings(runDir, permissions) {
  const dir = path.join(runDir, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const relative = path.relative(fs.realpathSync(runDir), fs.realpathSync(dir));
  const isInsideClone = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (!isInsideClone) throw new Error(`refusing to write agent settings: ${dir} resolves outside the clone`);
  const file = path.join(dir, 'settings.local.json');
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify({ permissions }, null, 2) + '\n', { flag: 'wx' });
}

// Implementation and fix passes. `skillNames` are the installed skills granted as Skill(<name>),
// never `code-review` (it has its own report-only pass). Edit and Write are separate tools; both
// are needed to change and to create files. `Agent` lets the agent call the read-only subagents.
function writeAgentPermissions(runDir, profile, skillNames) {
  const granted = skillNames.filter((name) => name !== 'code-review');
  writeSettings(runDir, {
    allow: ['Edit', 'Write', ...READ_ONLY_GIT, ...gateCommandRules(profile), ...granted.map((name) => `Skill(${name})`), 'Agent'],
    deny: [...protectedEditDeny(profile), ...COMMON_DENY],
  });
}

// The self-review pass is strictly read-only: no Edit/Write in allow and an explicit Edit(**) /
// Write(**) deny. core.js additionally blocks when the working tree changed during the pass.
function writeReviewerPermissions(runDir, profile) {
  writeSettings(runDir, {
    allow: [...REVIEW_GIT, ...gateCommandRules(profile)],
    deny: ['Edit(**)', 'Write(**)', 'NotebookEdit', ...COMMON_DENY],
  });
}

// Same read-only profile plus the `code-review` skill, which this pass runs in report-only mode.
function writeCodeReviewPermissions(runDir, profile) {
  writeSettings(runDir, {
    allow: [...REVIEW_GIT, ...gateCommandRules(profile), 'Skill(code-review)'],
    deny: ['Edit(**)', 'Write(**)', 'NotebookEdit', ...COMMON_DENY],
  });
}

module.exports = {
  gitStatusZ,
  runDirFor,
  sessionsRootFor,
  runSessionsDirFor,
  removeRunDirIfExists,
  DISABLED_PUSH_URL,
  prepareClone,
  createTaskBranch,
  enablePush,
  prepareAgentSessionDir,
  appCovers,
  determineTouchedApps,
  gateCommandsOf,
  createSandboxGateRunner,
  runProjectGate,
  runProjectGateForPorcelain,
  hasDelRalphMarker,
  findDelRalphMarkedFiles,
  applyDelRalphRenames,
  handleDelRalphMarkers,
  runInstallStep,
  InstallError,
  installDependencies,
  syncDependencies,
  listInstalledSkillNames,
  READ_ONLY_GIT,
  REVIEW_GIT,
  COMMON_DENY,
  gateCommandRules,
  writeAgentPermissions,
  writeReviewerPermissions,
  writeCodeReviewPermissions,
};
