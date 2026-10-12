// Per-connection state: the current analysis, its workflow steps, the results the user confirmed
// (the only things a report may contain), and pending confirmations.
import { workflowSteps } from './engine/learnContent.js';
import { UserError } from './data.js';

export const MODES = ['hypothesis_test', 'explore'];

/** The six "Bring it all together" steps from the app's Learn tab, plus how the MCP carries each out. */
export const STEP_ACTIONS = [
  { tool: 'state_hypotheses', skippable: false },
  { tool: 'check_assumptions', skippable: false },
  { tool: 'check_spread', skippable: false },
  { tool: 'power_analysis', skippable: true, skipHint: 'only if the user cannot say what size of effect matters, or the test has no power calculation here' },
  { tool: 'run_test', skippable: false },
  { tool: 'base_rate_check', skippable: true, skipHint: 'when the question is not about detecting a rare event (fraud, defects, diagnoses, churn)' },
];
export const STEPS = workflowSteps.map((s, i) => ({ number: i + 1, title: s.title, detail: s.detail, ...STEP_ACTIONS[i] }));

export class Session {
  constructor(config) {
    this.config = config;
    this.analyses = [];
    this.current = null;
    this.results = [];
    this.confirmed = new Set(); // canonical selections the user already approved
    this.pending = new Map();   // token -> canonical selection awaiting approval
    this.seq = { analysis: 0, result: 0 };
  }

  startAnalysis({ question, mode, file }) {
    const a = {
      id: `A${++this.seq.analysis}`, question, mode, file: file || null,
      startedAt: new Date().toISOString(),
      steps: STEPS.map((s) => ({ number: s.number, title: s.title, status: 'pending', note: null, resultId: null })),
      plan: null, // step 1: the confirmed test, data selection and hypotheses
    };
    this.analyses.push(a);
    this.current = a;
    return a;
  }

  requireAnalysis(mode) {
    const a = this.current;
    if (!a) {
      throw new UserError('No analysis has been started. Call start_analysis first: decide from the user\'s request whether they want a hypothesis test (is a difference / effect / relationship real?) or to explore the data (describe, visualize, estimate), and pass that as mode.');
    }
    if (mode && a.mode !== mode) {
      throw new UserError(mode === 'hypothesis_test'
        ? `The current analysis (${a.id}) is an exploration, so it has no hypotheses. If the user now wants to know whether an effect is real, call start_analysis again with mode "hypothesis_test".`
        : `The current analysis (${a.id}) is a hypothesis test.`);
    }
    return a;
  }

  step(n) { return this.current.steps[n - 1]; }

  /** Throws unless every earlier step is done (or validly skipped). */
  requireStepsBefore(n) {
    const a = this.requireAnalysis('hypothesis_test');
    for (const s of a.steps.slice(0, n - 1)) {
      if (s.status === 'pending') {
        const def = STEPS[s.number - 1];
        throw new UserError(`Follow the steps in order. Step ${s.number} ("${s.title}") is not done yet: call ${def.tool}${def.skippable ? ` (or skip_step with a reason, ${def.skipHint})` : ''}.`);
      }
    }
    return a;
  }

  completeStep(n, { note = null, resultId = null, status = 'done' } = {}) {
    Object.assign(this.step(n), { status, note, resultId });
  }

  /** Re-stating hypotheses (a principled revision after checking assumptions) resets the later steps. */
  resetStepsFrom(n) {
    for (const s of this.current.steps.slice(n - 1)) Object.assign(s, { status: 'pending', note: null, resultId: null });
  }

  addResult({ kind, title, data, summary, svg = null, selection = null }) {
    const r = { id: `R${++this.seq.result}`, analysisId: this.current?.id || null, mode: this.current?.mode || null, kind, title, data, summary, svg, selection, createdAt: new Date().toISOString() };
    this.results.push(r);
    return r;
  }

  statusText() {
    const a = this.current;
    if (!a) return 'No analysis started.';
    const lines = [`Analysis ${a.id} (${a.mode === 'hypothesis_test' ? 'hypothesis test' : 'exploration'}): "${a.question}"`];
    if (a.mode === 'hypothesis_test') {
      for (const s of a.steps) lines.push(`  ${s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : '○'} Step ${s.number}: ${s.title}${s.note ? ` (${s.note})` : ''}`);
      const next = a.steps.find((s) => s.status === 'pending');
      if (next) lines.push(`Next: step ${next.number}, call ${STEPS[next.number - 1].tool}.`);
      else lines.push('All six steps are done. Offer build_report if the user wants a report.');
    }
    const own = this.results.filter((r) => r.analysisId === a.id);
    if (own.length) lines.push(`Results: ${own.map((r) => `${r.id} ${r.title}`).join('; ')}`);
    return lines.join('\n');
  }
}
