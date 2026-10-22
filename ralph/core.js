'use strict';

// Ralph's state machine: one GitHub issue, start to finish. Everything below is orchestration;
// each capability lives in its own module:
//   config.js    — core constants, local run config, state snapshot, lock
//   github.js    — every git/gh call (the agent never does these itself), all with an explicit cwd
//   workspace.js — the per-issue clone: installs, dependency sync, gate, DEL_RALPH, permissions
//   steps/       — the step registry and the base steps; the pipeline the profile selects
//   prompts.js   — every word the agent is told, for all four passes
//   parsing.js   — pure parsing of the agent's output and of git porcelain
//   agent.js     — runs `claude -p` in the sandbox and streams its output
//   sandbox.js   — the Docker runtime (the only module that calls Docker)
//   boundary.js  — controller-side checks after every agent turn
//
// `ctx` of a run: { consumerRoot, profile, settings (local run config), sandboxEnv, originUrl, env,
// echo? (where the agent's live output goes; the process streams by default), stepRegistry? (the
// default registry when absent) }.

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_REVIEW_MAX_TURNS,
  DEFAULT_AGENT_TIMEOUT_MINUTES,
  DEFAULT_TASK_MAX_MINUTES,
  DEFAULT_TASK_MAX_USD,
  protectedPatternsFor,
} = require('./config');
const {
  git,
  gitPorcelainStatus,
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
const { missingRequiredSkills } = require('./prompts');
const {
  hasCodeChanges,
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
const { assertBaseProfileMatches } = require('./trusted-profile');
const { DEFAULT_REGISTRY, STEP_OUTCOMES, resolvePipeline } = require('./steps/registry');

const PASSED = ['passed', 'passed-out-of-scope'];

// An outcome of a kind the controller does not know is treated as an unreadable verdict.
const checkedOutcome = (outcome) => (STEP_OUTCOMES.includes(outcome?.kind) ? outcome : { kind: 'unparseable' });

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
  assertBaseProfile: assertBaseProfileMatches,
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
  let branchName;
  try {
    branchName = branchNameFor(profile.branchTemplate, chosen.id, chosen.title);
  } catch (error) {
    return { status: 'prepare_failed', error: `Configuration error: branchTemplate: ${error.message}` };
  }
  let pipeline;
  try {
    pipeline = resolvePipeline(profile, ctx.stepRegistry ?? DEFAULT_REGISTRY);
  } catch (error) {
    return { status: 'prepare_failed', error: error.message };
  }
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
  let remoteBranches;
  try {
    remoteBranches = ops.listRemoteBranches(consumerRoot);
    const leftovers = branchesOfIssue(remoteBranches, profile.branchTemplate, chosen.id);
    if (leftovers.length > 0) {
      return { status: 'branch_exists', reason: `Ветка ${leftovers.join(', ')} уже есть на remote (остаток прошлого запуска). Удалите её или разберите вручную, затем перезапустите Ральфа.` };
    }
  } catch (error) {
    return { status: 'prepare_failed', error: `Не удалось проверить ветки issue #${chosen.id} на remote: ${error.message}` };
  }

  let baseRef;
  try {
    ops.prepareClone(sandboxEnv.runsRoot, runDir, ctx.originUrl);
    baseRef = resolveBaseRef(profile, byId, chosen, ops.defaultBranchOf(runDir), remoteBranches);
    ops.createTaskBranch(runDir, branchName, baseRef);
    // The checked-out base must carry the trusted profile, before the proxy, installs and the agent.
    ops.assertBaseProfile({ snapshot: profile, consumerRoot, runDir, baseRef });
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
        pipeline,
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
  const { runDir, sessionsRoot, branchName, baseRef, agentTimeoutMs, agentModel, stepLimit, agentSandbox, installBox, gateRunner, skillNames, pipeline } = run;
  const reviewMaxTurns = settings.reviewMaxTurns ?? DEFAULT_REVIEW_MAX_TURNS;
  const docOnlyPatterns = profile.docOnlyPathPatterns || [];
  const promptCtx = { profile, maxTurns: settings.maxTurns, skillNames };

  // Baseline for the .git/ check, taken after the controller's own setup (clone, push URL, deps).
  const gitFingerprint = gitMetaFingerprint(runDir);
  const agentEnv = buildAgentEnv(ctx.env || process.env);
  const budget = createTaskBudget({
    maxWallClockMs: (settings.taskMaxMinutes ?? DEFAULT_TASK_MAX_MINUTES) * 60000,
    maxUsd: settings.taskMaxUsd === undefined ? DEFAULT_TASK_MAX_USD : settings.taskMaxUsd,
  });
  stepLimit.remainingMs = () => Math.max(MIN_SANDBOX_STEP_MS, Math.min(agentTimeoutMs, budget.remainingMs()));

  // Every agent call of this issue, of any step or fix: whole-task budget first (no new call once
  // it is spent), then the scrubbed env, the per-call timeout and what is left of the USD budget.
  // Each call gets its own session dir, named `<seq>-<pass>`.
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

  // Read-only calls must leave the tree exactly as they found it — compared with the state right
  // before this call, so an allowed fix between two review calls does not count.
  const runReadOnlyCall = async (prompt, pass) => {
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
  const applyDelRalph = (porcelain, agentOutput) => {
    const delRalph = workspace.handleDelRalphMarkers(runDir, profile, porcelain, gateRunner);
    if (!delRalph.blockedReason) return { diff: delRalph.porcelain, blocked: null };
    return { diff: delRalph.porcelain, blocked: block(ctx, chosen, delRalph.blockedReason, { coverage: coverageFor(chosen, agentOutput) }) };
  };

  // A BLOCKED or human-needed verdict of a write call.
  const blockOnVerdict = (outcome, agentOutput) =>
    block(ctx, chosen, outcome.reason, { humanNeeded: outcome.kind === 'human-needed', coverage: coverageFor(chosen, agentOutput) });

  // `verdict` is the first passed write call (implement, always the first step) for the rest of
  // the run: its TYPE/SUMMARY name the commit and the PR. A review fix is recorded in
  // `reviewFixSummaries` instead, shown in the issue comment. `finalOutput` follows the latest
  // write call: its self-report reflects the code as it stands, for the acceptance report. `diff`
  // is the current porcelain; the steps read it through `stepCtx`.
  let verdict = null;
  const reviewFixSummaries = [];
  let finalOutput = '';
  let diff = '';
  const stepCtx = Object.freeze({
    chosen,
    profile,
    runDir,
    gateRunner,
    promptCtx,
    get diff() {
      return diff;
    },
  });
  const steps = [];
  const finish = (result) => ({ ...result, steps });
  const stop = (stopped, kind) => ({ stopped, outcome: { kind } });

  // One call with write access (a writes step or a fix): the named permission profile, the call,
  // the boundary, the verdict, then a non-empty diff and DEL_RALPH.
  const runWriteCall = async ({ pass, prompt, permissions, parseOutput, who }) => {
    workspace.writePermissionProfile(permissions, runDir, profile, skillNames);
    const result = await callAgent(prompt, settings.maxTurns, pass);
    const boundaryBlock = blockOnBoundary(result.output);
    if (boundaryBlock) return stop(boundaryBlock, 'blocked');
    if (!result.ok) return stop({ status: 'agent_failed', error: result.error, runDir }, 'error');
    const outcome = checkedOutcome(parseOutput(result.output, stepCtx));
    if (outcome.kind === 'blocked' || outcome.kind === 'human-needed') return stop(blockOnVerdict(outcome, result.output), outcome.kind);
    if (outcome.kind !== 'passed') {
      return stop({ status: 'agent_failed', error: `${who} did not return DONE or BLOCKED`, runDir, output: result.output.slice(-2000) }, outcome.kind);
    }
    const porcelain = gitPorcelainStatus({ cwd: runDir });
    if (!porcelain) return stop({ status: 'validate_failed', error: `${who} said DONE but produced no diff`, runDir }, 'error');
    const delRalph = applyDelRalph(porcelain, result.output);
    diff = delRalph.diff;
    if (delRalph.blocked) return stop(delRalph.blocked, 'blocked');
    finalOutput = result.output;
    return { stopped: null, outcome };
  };

  // A step outcome that stops the run: BLOCKED with the step's status.
  const blockOnOutcome = (step, outcome, fixes) => {
    const label = step.label ?? step.name;
    const details = outcome.reason ?? `${label} returned ${outcome.kind}`;
    let reason = details;
    if (outcome.kind === 'unparseable') reason = `${label} did not return a clear PASS/FAIL verdict — treating as blocked out of caution.`;
    if (outcome.kind === 'failed' && step.kind === 'agent') reason = `${label} still found a real issue after ${fixes} fix attempt(s): ${details}`;
    const humanNeeded = outcome.kind === 'human-needed';
    return block(ctx, chosen, reason, { status: step.blockedStatus ?? 'blocked', humanNeeded, coverage: coverageFor(chosen, finalOutput) });
  };

  const runWritesStep = async (step) => {
    const prompt = step.buildPrompt(stepCtx);
    const call = await runWriteCall({ pass: step.name, prompt, permissions: step.permissions, parseOutput: step.parseOutput, who: 'agent' });
    if (!call.stopped && verdict === null) verdict = call.outcome;
    return call;
  };

  // A read-only call and, on a fixable failure, up to the step's budget of fix -> re-check cycles
  // (a separate write call each) before BLOCKED.
  const runReadOnlyStep = async (step) => {
    const label = step.label ?? step.name;
    const maxFixes = step.fix ? pipeline.budgets.get(step.name) : 0;
    for (let fixes = 0; ; fixes++) {
      console.log(`🔎 ${label} для issue #${chosen.id} (попытка ${fixes + 1}/${maxFixes + 1})...`);
      workspace.writePermissionProfile(step.permissions, runDir, profile, skillNames);
      const call = await runReadOnlyCall(step.buildPrompt(stepCtx), step.name);
      if (call.blocked) return stop(call.blocked, 'blocked');
      if (!call.result.ok) return stop({ status: step.failedStatus ?? 'agent_failed', error: call.result.error, runDir }, 'error');
      const outcome = checkedOutcome(step.parseOutput(call.result.output, stepCtx));
      if (PASSED.includes(outcome.kind)) {
        console.log(`✅ ${label} пройден для issue #${chosen.id}.`);
        return { stopped: null, outcome };
      }
      if (outcome.kind !== 'failed' || fixes >= maxFixes) return stop(blockOnOutcome(step, outcome, fixes), outcome.kind);

      console.log(`🔧 ${label} нашёл проблему для issue #${chosen.id}, пробую точечный фикс: ${outcome.reason}`);
      const { fix } = step;
      const prompt = fix.buildPrompt(stepCtx, outcome.reason ?? '');
      const fixCall = await runWriteCall({ pass: fix.pass, prompt, permissions: fix.permissions, parseOutput: fix.parseOutput, who: `${fix.pass} agent` });
      if (fixCall.stopped) return fixCall;
      reviewFixSummaries.push(fixCall.outcome.summary ?? `${fix.pass} (no summary)`);
    }
  };

  const runCheckStep = async (step) => {
    // A throw is not an outcome: like any controller error it ends the run as `crashed`, it does
    // not block the issue.
    const outcome = checkedOutcome(await step.run(stepCtx));
    if (PASSED.includes(outcome.kind)) return { stopped: null, outcome };
    return stop(blockOnOutcome(step, outcome, 0), outcome.kind);
  };

  const runStep = (step) => {
    if (step.kind === 'check') return runCheckStep(step);
    if (step.mode === 'writes') return runWritesStep(step);
    return runReadOnlyStep(step);
  };

  for (const [index, step] of pipeline.steps.entries()) {
    // Dependency sync after every earlier step and right before the last one (the final gate),
    // doc-only diffs included: the agent cannot install, so a manifest it changed is synchronized
    // here with the profile's commands, in the sandbox. The gate sees the refreshed diff.
    if (index === pipeline.steps.length - 1) {
      const sync = workspace.syncDependencies(runDir, profile, gitPorcelainStatus({ cwd: runDir }), installBox);
      if (!sync.ok) {
        steps.push({ name: step.name, outcome: 'blocked' });
        return finish(block(ctx, chosen, sync.blockedReason, { status: 'dependency_sync_blocked', coverage: coverageFor(chosen, finalOutput) }));
      }
      if (sync.ran) diff = gitPorcelainStatus({ cwd: runDir });
    }
    if (step.skipOnDocOnly && !hasCodeChanges(diff, docOnlyPatterns)) {
      steps.push({ name: step.name, outcome: 'skipped' });
      continue;
    }
    const { stopped, outcome } = await runStep(step);
    steps.push({ name: step.name, outcome: outcome.kind });
    if (stopped) return finish(stopped);
    if (outcome.kind === 'passed-out-of-scope') {
      console.log(`✅ ${step.label ?? step.name}: находки вне скоупа issue #${chosen.id}, не блокируют: ${outcome.reason}`);
      try {
        postOutOfScopeNote(ctx, chosen.id, outcome.reason);
      } catch (error) {
        console.log(`⚠️ Не удалось записать out-of-scope находку в issue #${chosen.id}: ${error.message}`);
      }
    }
  }

  // The controller's own commit/push run git on the host next. Nothing that ran after the last
  // agent turn (DEL_RALPH re-gate, dependency sync, final gate) may have changed .git/ or a
  // protected path, so the boundary is checked once more right here.
  {
    const boundaryBlock = blockOnBoundary(finalOutput);
    if (boundaryBlock) return finish(boundaryBlock);
  }

  return finish(publishChanges(ctx, { runDir, chosen, verdict, branchName, baseRef, finalOutput, reviewFixSummaries }));
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
