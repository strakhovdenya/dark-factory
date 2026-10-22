'use strict';

// Ralph's state machine: one GitHub issue, start to finish. Everything below is orchestration;
// each capability lives in its own module:
//   config.js    — core constants, local run config, state snapshot, lock
//   github.js    — every git/gh call (the agent never does these itself), all with an explicit cwd
//   workspace.js — the per-issue clone: installs, dependency sync, gate, DEL_RALPH, permissions
//   prompts.js   — every word the agent is told, for all four passes
//   parsing.js   — pure parsing of the agent's output and of git porcelain
//   agent.js     — runs `claude -p` in the sandbox and streams its output
//   sandbox.js   — the Docker runtime (the only module that calls Docker)
//   boundary.js  — controller-side checks after every agent turn
//
// `ctx` of a run: { consumerRoot, profile, settings (local run config), sandboxEnv, originUrl, env,
// echo? (where the agent's live output goes; the process streams by default) }.

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_REVIEW_MAX_TURNS,
  MAX_REVIEW_FIX_ATTEMPTS,
  MAX_CODE_REVIEW_FIX_ATTEMPTS,
  DEFAULT_AGENT_TIMEOUT_MINUTES,
  DEFAULT_TASK_MAX_MINUTES,
  DEFAULT_TASK_MAX_USD,
  protectedPatternsFor,
} = require('./config');
const {
  git,
  gitPorcelainStatus,
  reviewDiff,
  defaultBranchOf,
  listRemoteBranches,
  branchesOfIssue,
  resolveBaseRef,
  postBlockedComment,
  postTestEvidenceComment,
  checkOffAcceptanceCriteria,
  postOutOfScopeNote,
  commitChanges,
  pushBranch,
  createPr,
} = require('./github');
const workspace = require('./workspace');
const { buildPrompt, buildFixPrompt, buildReviewPrompt, buildCodeReviewPrompt, missingRequiredSkills } = require('./prompts');
const {
  hasCodeChanges,
  parseVerdict,
  parseReviewVerdict,
  parseCodeReviewVerdict,
  extractAffectsSection,
  extractAcceptanceCriteriaItems,
  parseAcceptanceCriteriaSelfReport,
  reconcileAcceptanceCriteria,
  summarizeSelfReportedCoverage,
} = require('./parsing');
const { runAgent } = require('./agent');
const sandbox = require('./sandbox');
const { buildAgentEnv, parseStatusZ, findProtectedChanges, findUndeclaredToolingChanges, gitMetaFingerprint, createTaskBudget } = require('./boundary');
const { branchNameFor } = require('../profile/branch');

// Agent's self-reported AC progress for a BLOCKED comment. `agentOutput` must be the output of the
// agent call that produced the state being blocked on. null (the comment omits the line) when there
// is no output, no self-report or no AC list — never a fake "0 of N".
function coverageFor(chosen, agentOutput) {
  if (!agentOutput) return null;
  try {
    const acItems = extractAcceptanceCriteriaItems(chosen.body);
    const selfReport = parseAcceptanceCriteriaSelfReport(agentOutput);
    if (selfReport.length === 0) return null;
    return summarizeSelfReportedCoverage(acItems, selfReport);
  } catch {
    return null;
  }
}

// Every BLOCKED outcome: comment and labels on the issue (best effort — the result is BLOCKED
// either way), no commit and no PR. The run dir is kept for a human; the next run re-clones.
function block(ctx, chosen, reason, { status = 'blocked', humanNeeded = false, coverage = null } = {}) {
  try {
    postBlockedComment(ctx, chosen.id, reason, { humanNeeded, coverage });
  } catch (error) {
    console.log(`⚠️ Не удалось записать BLOCKED в issue #${chosen.id}: ${error.message}`);
  }
  return { status, reason, humanNeeded };
}

function readAtHead(runDir, filePath) {
  try {
    return git(['show', `HEAD:${filePath}`], { cwd: runDir, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function readWorkingTree(runDir, filePath) {
  try {
    return fs.readFileSync(path.join(runDir, filePath), 'utf8');
  } catch {
    return null;
  }
}

// Deterministic check after every agent turn — the prompt asks the agent to stay out of these
// places, this is what enforces it. Returns a reason string, or null when clean:
//  - any change (either side of a rename) under a protected path (core + profile);
//  - anything inside .git/ changed except git's own caches (git status never lists .git itself);
//  - package.json scripts/dependencies or a tool config changed without its path in Affects.
function findBoundaryViolation(runDir, profile, chosen, gitFingerprint) {
  // Fingerprint first, before any host git command reads the clone's .git: a changed config could
  // make that command run something (fsmonitor, hooks) on the host.
  if (gitMetaFingerprint(runDir) !== gitFingerprint) {
    return "Agent boundary violated (controller check after the agent's turn) — no commit, no PR:\n- .git/ was modified (config, hooks, info/, HEAD, refs or similar)";
  }
  const entries = parseStatusZ(workspace.gitStatusZ(runDir));
  const problems = [];
  const protectedHits = findProtectedChanges(entries, protectedPatternsFor(profile));
  if (protectedHits.length > 0) problems.push(`changes in protected paths: ${protectedHits.join(', ')}`);
  const tooling = findUndeclaredToolingChanges(
    entries,
    extractAffectsSection(chosen.body),
    (filePath) => readAtHead(runDir, filePath),
    (filePath) => readWorkingTree(runDir, filePath),
  );
  if (tooling.length > 0) {
    problems.push(`package.json scripts/dependencies or tool configs changed without being named in ## Affects: ${tooling.join(', ')}`);
  }
  if (problems.length === 0) return null;
  return `Agent boundary violated (controller check after the agent's turn) — no commit, no PR:\n- ${problems.join('\n- ')}`;
}

// Floor for a sandbox step's time limit when the task budget is (nearly) spent: the step still
// starts and fails on its timeout instead of getting a zero or negative limit.
const MIN_SANDBOX_STEP_MS = 60000;

const RUN_OPS = {
  listRemoteBranches,
  prepareClone: workspace.prepareClone,
  defaultBranchOf,
  createTaskBranch: workspace.createTaskBranch,
  startProxy: (spec, options) => sandbox.startProxy(spec, options),
  createSandboxGateRunner: workspace.createSandboxGateRunner,
  installDependencies: workspace.installDependencies,
  listInstalledSkillNames: workspace.listInstalledSkillNames,
  writeAgentPermissions: workspace.writeAgentPermissions,
  runIssueInClone: (ctx, chosen, run) => runIssueInClone(ctx, chosen, run),
};

// Prepares the clone and runs the issue in it. The run's egress proxy (and its internal network)
// lives exactly as long as this call. `ops` is injectable so core.test.js can assert the order of
// the prepare steps.
async function runIssue(ctx, byId, chosen, ops = RUN_OPS) {
  const { consumerRoot, profile, settings, sandboxEnv } = ctx;
  const branchName = branchNameFor(profile.branchTemplate, chosen.id, chosen.title);
  const runDir = workspace.runDirFor(sandboxEnv.runsRoot, chosen.id);
  const sessionsRoot = workspace.runSessionsDirFor(sandboxEnv.runsRoot, chosen.id);
  const { sandboxConfig, docker } = sandboxEnv;
  // Every sandbox step is capped like an agent call; once the task budget exists
  // (runIssueInClone) the cap also never exceeds what is left of it.
  const agentTimeoutMs = (settings.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES) * 60000;
  const stepLimit = { remainingMs: () => agentTimeoutMs };
  const base = {
    image: sandboxConfig.image,
    rootKey: sandboxEnv.rootKey,
    runLabel: `issue-${chosen.id}`,
    timeoutMs: () => stepLimit.remainingMs(),
    docker,
  };

  // A task branch left on the remote by an earlier run (whatever its slug) stops the issue here: no
  // clone, no agent, no push — a human decides what to do with that branch.
  try {
    const leftovers = branchesOfIssue(ops.listRemoteBranches(consumerRoot), profile.branchTemplate, chosen.id);
    if (leftovers.length > 0) {
      return { status: 'branch_exists', reason: `Ветка ${leftovers.join(', ')} уже есть на remote (остаток прошлого запуска). Удалите её или разберите вручную, затем перезапустите Ральфа.` };
    }
  } catch (error) {
    return { status: 'prepare_failed', error: `Не удалось проверить ветки issue #${chosen.id} на remote: ${error.message}` };
  }

  let baseRef;
  try {
    ops.prepareClone(sandboxEnv.runsRoot, runDir, ctx.originUrl);
    baseRef = resolveBaseRef(profile, byId, chosen, ops.defaultBranchOf(runDir));
    ops.createTaskBranch(runDir, branchName, baseRef);
  } catch (error) {
    return { status: 'prepare_failed', error: error.message, runDir };
  }
  console.log(`🌱 Клон ${runDir}, ветка ${branchName} от ${baseRef}.`);

  let proxy = null;
  try {
    let run;
    try {
      proxy = ops.startProxy({ ...base, allowedHosts: sandboxConfig.allowedHosts }, { docker });
      const networked = { ...base, network: proxy.network, proxyUrl: proxy.proxyUrl };
      run = {
        runDir,
        sessionsRoot,
        branchName,
        baseRef,
        agentTimeoutMs,
        agentModel: sandboxEnv.agentModel,
        stepLimit,
        agentSandbox: networked,
        installBox: { ...networked, installEnv: sandboxConfig.installEnv, logsDir: sessionsRoot },
        gateRunner: ops.createSandboxGateRunner(runDir, base),
        skillNames: [],
      };
    } catch (error) {
      return { status: 'prepare_failed', error: error.message, runDir };
    }
    try {
      ops.installDependencies(runDir, profile, run.installBox);
    } catch (error) {
      if (error instanceof workspace.InstallError) {
        return block(ctx, chosen, `Dependency installation failed before the agent — no agent, no gate, no PR: ${error.message}`);
      }
      return { status: 'prepare_failed', error: error.message, runDir };
    }
    // Until the package sets up skills in the clone, a required skill that is not installed stops
    // the issue before the agent: the agent could not load it.
    run.skillNames = ops.listInstalledSkillNames(runDir).filter((name) => name !== 'code-review');
    const missingSkills = missingRequiredSkills(profile, chosen.body, run.skillNames);
    if (missingSkills.length > 0) {
      return block(ctx, chosen, `Required skills are not installed in the clone: ${missingSkills.join(', ')} — the agent was not started.`);
    }
    ops.writeAgentPermissions(runDir, profile, run.skillNames);
    return await ops.runIssueInClone(ctx, chosen, run);
  } finally {
    if (proxy) proxy.stop();
  }
}

async function runIssueInClone(ctx, chosen, run) {
  const { profile, settings } = ctx;
  const { runDir, sessionsRoot, branchName, baseRef, agentTimeoutMs, agentModel, stepLimit, agentSandbox, installBox, gateRunner, skillNames } = run;
  const reviewMaxTurns = settings.reviewMaxTurns ?? DEFAULT_REVIEW_MAX_TURNS;
  const docOnlyPatterns = profile.docOnlyPathPatterns || [];
  const verdictName = profile.ralph.humanNeededVerdict;
  const promptCtx = { profile, maxTurns: settings.maxTurns, skillNames };

  // Baseline for the .git/ check, taken after the controller's own setup (clone, push URL, deps).
  const gitFingerprint = gitMetaFingerprint(runDir);
  const agentEnv = buildAgentEnv(ctx.env || process.env);
  const budget = createTaskBudget({
    maxWallClockMs: (settings.taskMaxMinutes ?? DEFAULT_TASK_MAX_MINUTES) * 60000,
    maxUsd: settings.taskMaxUsd === undefined ? DEFAULT_TASK_MAX_USD : settings.taskMaxUsd,
  });
  stepLimit.remainingMs = () => Math.max(MIN_SANDBOX_STEP_MS, Math.min(agentTimeoutMs, budget.remainingMs()));

  // Every agent call of this issue: whole-task budget first (no new call once it is spent), then
  // the scrubbed env, the per-call timeout and what is left of the USD budget. Each call gets its
  // own session dir, named `<seq>-<pass>`.
  let agentCallSeq = 0;
  const callAgent = async (prompt, maxTurns, pass) => {
    const exhausted = budget.exhaustedReason();
    if (exhausted) return { ok: false, error: exhausted, output: '' };
    const maxBudgetUsd = budget.remainingUsd();
    agentCallSeq++;
    const sessionsDir = workspace.prepareAgentSessionDir(sessionsRoot, `${String(agentCallSeq).padStart(2, '0')}-${pass}`);
    const result = await runAgent(prompt, runDir, maxTurns, {
      env: agentEnv,
      sandbox: { ...agentSandbox, sessionsDir },
      timeoutMs: Math.min(agentTimeoutMs, budget.remainingMs()),
      maxBudgetUsd,
      model: agentModel,
      echo: ctx.echo,
    });
    // A call killed by the timeout never sends its `result` event, so its cost is unknown. Count
    // the cap it ran under rather than zero, so the next call cannot get the full budget again.
    budget.record(result.costUsd ?? maxBudgetUsd);
    return result;
  };

  const blockOnBoundary = (agentOutput) => {
    const reason = findBoundaryViolation(runDir, profile, chosen, gitFingerprint);
    return reason ? block(ctx, chosen, reason, { coverage: coverageFor(chosen, agentOutput) }) : null;
  };

  // Read-only passes must leave the tree exactly as they found it.
  const runReadOnlyPass = async (prompt, pass) => {
    const statusBefore = workspace.gitStatusZ(runDir);
    const result = await callAgent(prompt, reviewMaxTurns, pass);
    const boundaryBlock = blockOnBoundary(null);
    if (boundaryBlock) return { result, blocked: boundaryBlock };
    if (workspace.gitStatusZ(runDir) !== statusBefore) {
      return { result, blocked: block(ctx, chosen, 'A read-only review pass changed the working tree (git status differs before/after) — no commit, no PR.') };
    }
    return { result, blocked: null };
  };

  // DEL_RALPH renames after a DONE; a still-red gate afterwards is BLOCKED.
  const applyDelRalph = (diff, agentOutput) => {
    const delRalph = workspace.handleDelRalphMarkers(runDir, profile, diff, gateRunner);
    if (!delRalph.blockedReason) return { diff: delRalph.porcelain, blocked: null };
    return { diff: delRalph.porcelain, blocked: block(ctx, chosen, delRalph.blockedReason, { coverage: coverageFor(chosen, agentOutput) }) };
  };

  // A BLOCKED or human-needed verdict of the implementer or of a fixer.
  const blockOnVerdict = (verdict, agentOutput) =>
    block(ctx, chosen, verdict.reason, { humanNeeded: verdict.kind === 'human-needed', coverage: coverageFor(chosen, agentOutput) });
  const isBlockedVerdict = (verdict) => verdict.kind === 'blocked' || verdict.kind === 'human-needed';

  const agentResult = await callAgent(buildPrompt(chosen, promptCtx), settings.maxTurns, 'implement');
  {
    const boundaryBlock = blockOnBoundary(agentResult.output);
    if (boundaryBlock) return boundaryBlock;
  }
  if (!agentResult.ok) {
    return { status: 'agent_failed', error: agentResult.error, runDir };
  }

  // `verdict` stays the implementation's DONE for the rest of the run: its TYPE/SUMMARY name the
  // commit and the PR. A review-driven fix is recorded in `reviewFixSummaries` instead, shown in
  // the issue comment. `finalOutput` follows the latest agent call: its self-report reflects the
  // code as it stands, for the acceptance report.
  const verdict = parseVerdict(agentResult.output, verdictName);
  const reviewFixSummaries = [];
  let finalOutput = agentResult.output;

  if (isBlockedVerdict(verdict)) return blockOnVerdict(verdict, null);
  if (verdict.kind !== 'done') {
    return { status: 'agent_failed', error: 'agent did not return DONE or BLOCKED', runDir, output: agentResult.output.slice(-2000) };
  }

  let diff = gitPorcelainStatus({ cwd: runDir });
  if (!diff) {
    return { status: 'validate_failed', error: 'agent said DONE but produced no diff', runDir };
  }
  {
    const result = applyDelRalph(diff, finalOutput);
    diff = result.diff;
    if (result.blocked) return result.blocked;
  }

  // One review loop: a read-only pass, and on a real finding up to `maxFixes` point-fix ->
  // re-review cycles (a separate agent call each) before BLOCKED. Doc-only diffs skip it.
  const reviewLoop = async ({ name, maxFixes, buildReview, writePermissions, parseReview, passName, fixPassName, blockedStatus, failedStatus }) => {
    let attempt = 0;
    for (;;) {
      console.log(`🔎 ${name} для issue #${chosen.id} (попытка ${attempt + 1}/${maxFixes + 1})...`);
      writePermissions(runDir, profile);
      const pass = await runReadOnlyPass(buildReview(), passName);
      if (pass.blocked) return pass.blocked;
      if (!pass.result.ok) return { status: failedStatus, error: pass.result.error, runDir };

      const reviewVerdict = parseReview(pass.result.output);
      if (reviewVerdict.kind === 'pass') {
        console.log(`✅ ${name} пройден для issue #${chosen.id}.`);
        return null;
      }
      if (reviewVerdict.kind === 'pass-out-of-scope') {
        console.log(`✅ ${name} пройден для issue #${chosen.id} — есть находки вне скоупа этой issue, не блокируют: ${reviewVerdict.reason}`);
        try {
          postOutOfScopeNote(ctx, chosen.id, reviewVerdict.reason);
        } catch (error) {
          console.log(`⚠️ Не удалось записать out-of-scope находку в issue #${chosen.id}: ${error.message}`);
        }
        return null;
      }
      const isUnparseable = reviewVerdict.kind !== 'fail';
      if (isUnparseable || attempt >= maxFixes) {
        const reason = isUnparseable
          ? `${name} did not return a clear PASS/FAIL verdict — treating as blocked out of caution.`
          : `${name} still found a real issue after ${attempt} fix attempt(s): ${reviewVerdict.reason}`;
        return block(ctx, chosen, reason, { status: blockedStatus, coverage: coverageFor(chosen, finalOutput) });
      }

      console.log(`🔧 ${name} нашёл проблему для issue #${chosen.id}, пробую точечный фикс: ${reviewVerdict.reason}`);
      workspace.writeAgentPermissions(runDir, profile, skillNames);
      const fixResult = await callAgent(buildFixPrompt(chosen, reviewVerdict.reason, promptCtx), settings.maxTurns, fixPassName);
      const boundaryBlock = blockOnBoundary(fixResult.output);
      if (boundaryBlock) return boundaryBlock;
      if (!fixResult.ok) return { status: 'agent_failed', error: fixResult.error, runDir };

      const fixVerdict = parseVerdict(fixResult.output, verdictName);
      if (isBlockedVerdict(fixVerdict)) return blockOnVerdict(fixVerdict, finalOutput);
      if (fixVerdict.kind !== 'done') {
        return { status: 'agent_failed', error: `${fixPassName} agent did not return DONE or BLOCKED`, runDir, output: fixResult.output.slice(-2000) };
      }
      diff = gitPorcelainStatus({ cwd: runDir });
      if (!diff) return { status: 'validate_failed', error: `${fixPassName} agent said DONE but produced no diff`, runDir };
      const delRalph = applyDelRalph(diff, fixResult.output);
      diff = delRalph.diff;
      if (delRalph.blocked) return delRalph.blocked;

      reviewFixSummaries.push(fixVerdict.summary);
      finalOutput = fixResult.output;
      attempt++;
    }
  };

  if (hasCodeChanges(diff, docOnlyPatterns)) {
    const stopped = await reviewLoop({
      name: 'Self-review (Ralph loop review pass)',
      maxFixes: MAX_REVIEW_FIX_ATTEMPTS,
      buildReview: () => buildReviewPrompt(chosen, reviewDiff(runDir), promptCtx),
      writePermissions: workspace.writeReviewerPermissions,
      parseReview: parseReviewVerdict,
      passName: 'self-review',
      fixPassName: 'review-fix',
      blockedStatus: 'review_blocked',
      failedStatus: 'review_failed',
    });
    if (stopped) return stopped;
  }

  // The second, independent pass runs only after self-review passed; `diff` is current (a fix may
  // have changed it).
  if (hasCodeChanges(diff, docOnlyPatterns)) {
    const stopped = await reviewLoop({
      name: 'Code-review (Ralph loop, code-review skill)',
      maxFixes: MAX_CODE_REVIEW_FIX_ATTEMPTS,
      buildReview: () => buildCodeReviewPrompt(chosen, promptCtx),
      writePermissions: workspace.writeCodeReviewPermissions,
      parseReview: parseCodeReviewVerdict,
      passName: 'code-review',
      fixPassName: 'code-review-fix',
      blockedStatus: 'code_review_blocked',
      failedStatus: 'code_review_failed',
    });
    if (stopped) return stopped;
  }

  // Dependency sync after the last agent pass and before the final gate: the agent cannot install,
  // so a manifest it changed is synchronized here with the profile's commands, in the sandbox.
  {
    const sync = workspace.syncDependencies(runDir, profile, gitPorcelainStatus({ cwd: runDir }), installBox);
    if (!sync.ok) {
      return block(ctx, chosen, sync.blockedReason, { status: 'dependency_sync_blocked', coverage: coverageFor(chosen, finalOutput) });
    }
    if (sync.ran) diff = gitPorcelainStatus({ cwd: runDir });
  }

  // Independent final gate right before commit/push/PR, after every review/fix cycle — not the
  // agent's self-report and not an earlier, possibly stale result. Skipped only for a doc-only diff.
  if (hasCodeChanges(diff, docOnlyPatterns)) {
    console.log(`🔒 Финальный гейт перед коммитом для issue #${chosen.id}...`);
    const finalGate = workspace.runProjectGateForPorcelain(runDir, profile, diff, gateRunner);
    if (!finalGate.ok) {
      return block(ctx, chosen, `Финальный гейт перед коммитом красный — PR не создаётся:\n\n${finalGate.output}`, { status: 'final_gate_blocked', coverage: coverageFor(chosen, finalOutput) });
    }
    console.log(`✅ Финальный гейт зелёный для issue #${chosen.id}.`);
  }

  // The controller's own commit/push run git on the host next. Nothing that ran after the last
  // agent turn (DEL_RALPH re-gate, dependency sync, final gate) may have changed .git/ or a
  // protected path, so the boundary is checked once more right here.
  {
    const boundaryBlock = blockOnBoundary(finalOutput);
    if (boundaryBlock) return boundaryBlock;
  }

  return publishChanges(ctx, { runDir, chosen, verdict, branchName, baseRef, finalOutput, reviewFixSummaries });
}

// What the controller reports about the acceptance criteria after a successful PR. Boxes are
// checked only when the latest self-report is a complete 1:1 match with the issue's AC list.
// Best effort: the PR already exists, so a failure is logged, not fatal.
function reportAfterPr(ctx, { chosen, verdict, branchName, finalOutput, pr, reviewFixSummaries }, ops) {
  let acItems = [];
  let selfReport = [];
  let allCovered = false;
  let checkedOff = false;
  try {
    acItems = extractAcceptanceCriteriaItems(chosen.body);
    if (acItems.length > 0) {
      selfReport = parseAcceptanceCriteriaSelfReport(finalOutput);
      ({ allCovered } = reconcileAcceptanceCriteria(acItems, selfReport));
      if (allCovered) {
        ops.checkOffAcceptanceCriteria(ctx, chosen.id);
        checkedOff = true;
      }
    }
  } catch (error) {
    console.log(`⚠️ Не удалось сверить/отметить Acceptance Criteria для issue #${chosen.id}: ${error.message}`);
  }

  try {
    ops.postTestEvidenceComment(ctx, { chosen, verdict, branchName, acItems, selfReport, allCovered, checkedOff, pr, reviewFixSummaries });
  } catch (error) {
    console.log(`⚠️ Не удалось запостить test evidence комментарий в issue #${chosen.id}: ${error.message}`);
  }
}

const PUBLISH_OPS = {
  commitChanges,
  enablePush: workspace.enablePush,
  pushBranch,
  createPr,
  checkOffAcceptanceCriteria,
  postTestEvidenceComment,
  removeRunDirIfExists: workspace.removeRunDirIfExists,
};

// Commit, push, PR — then, only once the PR exists, the issue-side effects (checking off AC boxes
// and the evidence comment that links the PR). A failure at any earlier step leaves the issue
// untouched. `ops` is injectable so core.test.js can assert the order.
function publishChanges(ctx, { runDir, chosen, verdict, branchName, baseRef, finalOutput, reviewFixSummaries = [] }, ops = PUBLISH_OPS) {
  let commitMessage;
  try {
    commitMessage = ops.commitChanges(runDir, chosen, verdict);
  } catch (error) {
    return { status: 'commit_failed', error: error.message, runDir };
  }

  try {
    ops.enablePush(runDir, ctx.originUrl);
    ops.pushBranch(runDir, branchName);
  } catch (error) {
    return { status: 'push_failed', error: error.message, runDir };
  }

  let pr;
  try {
    pr = ops.createPr(ctx, chosen, branchName, baseRef, commitMessage);
  } catch (error) {
    return { status: 'pr_failed', error: error.message, runDir };
  }

  reportAfterPr(ctx, { chosen, verdict, branchName, finalOutput, pr, reviewFixSummaries }, ops);
  ops.removeRunDirIfExists(runDir);
  return { status: 'done', pr };
}

module.exports = {
  runIssue,
  runIssueInClone,
  publishChanges,
  findBoundaryViolation,
};
