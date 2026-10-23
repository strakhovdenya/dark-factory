#!/usr/bin/env node
'use strict';

/**
 * Claude Code PreToolUse hook for Bash and for the GitHub MCP tool issue_write (gate, fails
 * closed).
 *
 * The event is classified first: `git commit` / `git push` and `gh issue create|edit` at the start
 * of a shell segment, or an issue_write tool call. Any other valid event passes silently, without
 * reading the profile; an unparsable event blocks because the action cannot be identified.
 *
 * For a target operation the consumer root (CLAUDE_PROJECT_DIR), session_id and a valid profile
 * are required, and the session marker (skill-marker.js) is read; a damaged marker blocks.
 *  - Commit/push require the task-lifecycle skill, then ask the person to confirm the closure
 *    checks (permissionDecision "ask").
 *  - Issue writes require the issues skill, and a body that is written must pass the issue
 *    linter (v2) against the core contract plus the consumer's overlay
 *    `<root>/.github/verifier/issue-contract.overlay.json`; a damaged overlay blocks. An edit or
 *    update that sends no body only needs the skill.
 *
 * The task-lifecycle skill is not part of the Write|Edit skill gate: research, planning and Ralph
 * coding agents must not be forced through the human-driven lifecycle. Commit/push are the
 * closure boundary.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../profile/load');
const { buildContract, DEFAULT_OVERLAY } = require('../verifier/issue-contract');
const { lint } = require('../verifier/issue-lint');
const { consumerRootOf, isInside } = require('./commands');
const { allow, block, ask, runGate } = require('./run-gate');
const { readLoaded, isLoaded, sessionIdOf } = require('./skill-marker');

const TASK_LIFECYCLE_SKILL = 'task-lifecycle';
const ISSUES_SKILL = 'issues';
const BODY_FILE_HINT = 'use --body-file <path> so the body can be checked against the issue format contract';

const COMMIT_REASON =
  'task-lifecycle closure gate, before committing: ' +
  '(1) Are all applicable Acceptance Criteria checked in the Issue? ' +
  '(2) Is test evidence posted to the Issue? ' +
  '(3) Have you run /code-review against this diff, or explicitly asked the user and gotten "no"? ' +
  '(4) Have you asked whether root README.md needs updating, or already updated it if yes? ' +
  '(5) Were the required implementation metaskills loaded before coding and was the diff checked against them? ' +
  '(6) Will the PR include "Closes #n"? Confirm the task-lifecycle closure gate was actually completed before approving this commit.';
const PUSH_REASON =
  'Pre-push check: task-lifecycle is loaded. Confirm its closure gate has already been satisfied for every commit being pushed, ' +
  'including Issue AC, test evidence, review/README decisions, and eventual PR traceability with "Closes #n".';

// A closure-boundary command is a Git invocation at the start of a shell segment (optionally
// after env assignments and Git global options), not any text that merely mentions it.
const SEGMENT_SEPARATOR = /&&|\|\||[;|\n]/;
const gitSubcommand = (name) =>
  new RegExp(String.raw`^(?:\w+=\S+\s+)*git(?:\s+(?:-C|-c)\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+${name}\b`);
const COMMIT_PATTERN = gitSubcommand('commit');
const PUSH_PATTERN = gitSubcommand('push');
// Only issue create/edit change an issue body; comment/view/list stay open. The binary may be
// gh.exe or an absolute path.
const ISSUE_WRITE_PATTERN = /^(?:\w+=\S+\s+)*(?:\S*[\\/])?gh(?:\.exe)?\s+issue\s+(?<action>create|edit)\b/;

const segmentsOf = (command) => command.split(SEGMENT_SEPARATOR).map((segment) => segment.trim());

const FLAG_WITH_VALUE = /^(--[\w-]+)=(.*)$/;
// gh accepts a shorthand flag glued to its value: -Fpath.md, -btext.
const SHORT_BODY_FILE_GLUED = /^-F(.+)$/;
const SHORT_BODY_GLUED = /^-b(.+)$/;

const tokenizeSegment = (segment) => {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of segment.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
};

// The body for the linter comes only from --body-file/-F; an inline --body/-b is never linted,
// so it is rejected like no body flag at all.
const parseIssueBodyFlags = (segment) => {
  const tokens = tokenizeSegment(segment);
  let bodyFile = null;
  let hasInlineBody = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const gluedBodyFile = token.match(SHORT_BODY_FILE_GLUED);
    if (gluedBodyFile) {
      bodyFile = gluedBodyFile[1];
      continue;
    }
    if (SHORT_BODY_GLUED.test(token)) {
      hasInlineBody = true;
      continue;
    }
    const inline = token.match(FLAG_WITH_VALUE);
    const flag = inline ? inline[1] : token;
    const inlineValue = inline ? inline[2] : null;
    if (flag === '--body-file' || flag === '-F') {
      bodyFile = inlineValue ?? tokens[(index += 1)] ?? '';
    } else if (flag === '--body' || flag === '-b') {
      hasInlineBody = true;
      if (inlineValue === null) index += 1;
    }
  }
  return { bodyFile, hasInlineBody };
};

/** The target operations of an event: issue writes (with their bodies) and commit/push. */
const classify = (input) => {
  const toolName = input?.tool_name;
  if (typeof toolName === 'string' && toolName.endsWith('issue_write')) {
    return { mcpIssueWrite: true, issueWrites: [], isCommit: false, isPush: false };
  }
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command === '') {
    return { mcpIssueWrite: false, issueWrites: [], isCommit: false, isPush: false };
  }
  const segments = segmentsOf(command);
  const issueWrites = segments
    .map((segment) => ({ segment, match: segment.match(ISSUE_WRITE_PATTERN) }))
    .filter(({ match }) => match)
    .map(({ segment, match }) => ({ segment, action: match.groups.action }));
  return {
    mcpIssueWrite: false,
    issueWrites,
    isCommit: segments.some((segment) => COMMIT_PATTERN.test(segment)),
    isPush: segments.some((segment) => PUSH_PATTERN.test(segment)),
  };
};

const isTarget = (operations) =>
  operations.mcpIssueWrite || operations.issueWrites.length > 0 || operations.isCommit || operations.isPush;

// The Bash tool runs Git Bash on Windows, so a path in the command may be /c/Users/...; Node on
// win32 would read the leading "/" as the root of the current drive.
const normalizeGitBashPath = (filePath) => {
  if (process.platform !== 'win32') return filePath;
  const match = filePath.match(/^\/([a-zA-Z])\/(.*)$/);
  return match ? `${match[1]}:\\${match[2]}` : filePath;
};

// The command text is untrusted: a body file is read only from the command's working directory
// or the OS temp directory, checked on the real path so a symlink cannot point outside them.
const readBodyFile = (bodyFile, cwd) => {
  if (typeof cwd !== 'string' || cwd === '') throw new Error('hook input has no cwd to resolve --body-file');
  const absolute = path.resolve(cwd, normalizeGitBashPath(bodyFile));
  const real = fs.realpathSync(absolute);
  const allowedRoots = [path.resolve(cwd), os.tmpdir()].map((root) => fs.realpathSync(root));
  if (!allowedRoots.some((root) => isInside(root, real))) {
    throw new Error(
      `--body-file path is outside the allowed roots (the command's working directory or the OS temp directory): ${absolute}`,
    );
  }
  return fs.readFileSync(real, 'utf8');
};

/** The issue contract of the consumer: core plus its overlay, by an explicit path from the root. */
const contractOf = (root) => {
  const overlay = path.join(root, DEFAULT_OVERLAY);
  try {
    return buildContract(overlay);
  } catch (error) {
    throw new Error(`issue contract overlay ${overlay} is invalid: ${error.message}`, { cause: error });
  }
};

/** A block message for a body that fails the linter, or null. */
const lintBody = (body, root, contextLabel) => {
  const result = lint(body, contractOf(root), { requireV2: true });
  if (result.problems.length === 0) return null;
  const problems = result.problems.map((problem) => `- ${problem}`).join('\n');
  return `Blocked: ${contextLabel} issue body failed issue-lint (format v2 required):\n${problems}`;
};

const ghIssueWriteProblem = ({ segment, action }, root, cwd) => {
  const { bodyFile, hasInlineBody } = parseIssueBodyFlags(segment);
  // An inline body blocks even next to --body-file: which one gh applies is not this hook's to assume.
  if (hasInlineBody) return `Blocked: gh issue ${action} must use --body-file <path>, not inline --body/-b; ${BODY_FILE_HINT}.`;
  if (bodyFile === '-') return `Blocked: gh issue ${action} --body-file - (stdin) is not supported; ${BODY_FILE_HINT}.`;
  if (bodyFile === null || bodyFile === '') {
    if (action === 'edit') return null;
    return `Blocked: gh issue ${action} must use --body-file <path>; ${BODY_FILE_HINT}.`;
  }
  let body;
  try {
    body = readBodyFile(bodyFile, cwd);
  } catch (error) {
    return `Blocked: could not verify the gh issue ${action} body (${error.message}).`;
  }
  return lintBody(body, root, `gh issue ${action}`);
};

const mcpIssueWriteProblem = (toolInput, root) => {
  const method = toolInput?.method;
  const body = toolInput?.body;
  if (method === 'create') return lintBody(typeof body === 'string' ? body : '', root, 'MCP issue_write (create)');
  if (typeof body === 'string') return lintBody(body, root, `MCP issue_write (${method ?? 'update'})`);
  return null;
};

const MISSING_ISSUES_SKILL =
  'Blocked: gh issue create/edit (and MCP issue_write) requires the issues skill to be loaded first ' +
  '(issue format and verifiability rules). Load issues, then repeat the command.';
const MISSING_LIFECYCLE =
  'Blocked: task closure requires the task-lifecycle skill to be reloaded before git commit/push. ' +
  'Load task-lifecycle, complete its closure gate, then repeat the command.';

/** @type {import('./run-gate').GateHandler} */
const decide = (raw, env) => {
  const input = JSON.parse(raw);
  const operations = classify(input);
  if (!isTarget(operations)) return allow();

  const root = consumerRootOf(env);
  const sessionId = sessionIdOf(input);
  loadProfile(root);
  const loaded = readLoaded(sessionId);

  if (operations.mcpIssueWrite || operations.issueWrites.length > 0) {
    if (!isLoaded(loaded, ISSUES_SKILL)) return block(MISSING_ISSUES_SKILL);
    const problems = operations.mcpIssueWrite
      ? [mcpIssueWriteProblem(input.tool_input, root)]
      : operations.issueWrites.map((write) => ghIssueWriteProblem(write, root, input.cwd));
    const problem = problems.find((message) => message !== null);
    if (problem !== undefined) return block(problem);
  }

  if (!operations.isCommit && !operations.isPush) return allow();
  if (!isLoaded(loaded, TASK_LIFECYCLE_SKILL)) return block(MISSING_LIFECYCLE);
  return ask(operations.isCommit ? COMMIT_REASON : PUSH_REASON);
};

if (require.main === module) runGate('closure-gate', decide);

module.exports = { decide, classify, parseIssueBodyFlags };
