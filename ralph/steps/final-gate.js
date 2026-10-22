'use strict';

// Base step `final-gate`: the profile's gate commands of every touched app, right before commit —
// code, not a model. The controller synchronizes dependencies before it and hands it the current
// diff; a doc-only diff skips it.

const workspace = require('../workspace');

const finalGate = {
  name: 'final-gate',
  kind: 'check',
  skipOnDocOnly: true,
  blockedStatus: 'final_gate_blocked',
  run: (ctx) => {
    console.log(`🔒 Финальный гейт перед коммитом для issue #${ctx.chosen.id}...`);
    const gate = workspace.runProjectGateForPorcelain(ctx.runDir, ctx.profile, ctx.diff, ctx.gateRunner);
    if (!gate.ok) return { kind: 'blocked', reason: `Финальный гейт перед коммитом красный — PR не создаётся:\n\n${gate.output}` };
    console.log(`✅ Финальный гейт зелёный для issue #${ctx.chosen.id}.`);
    return { kind: 'passed' };
  },
};

module.exports = { finalGate };
