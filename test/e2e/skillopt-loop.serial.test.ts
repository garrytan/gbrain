/**
 * SkillOpt loop E2E: happy path + 5 orchestrator-visible failure modes.
 *
 * Sibling to `skillopt-pglite.serial.test.ts`. That file pins the three
 * v1 paths (dry-run, all-reject, manual revertAllPending). THIS file
 * proves the full optimization loop can actually improve a skill end-to-end
 * AND that each failure mode the loop is supposed to catch actually does
 * the right thing.
 *
 * Stub strategy: install one composite chat transport via
 * `__setChatTransportForTests`. The stub branches on `chatOpts.system`:
 *
 *   - If system starts with "You are SkillOpt's optimizer", the call is
 *     a reflect call. Branches further on FAILURE vs SUCCESS prompt.
 *   - Otherwise, the call is a target-agent rollout. The stub emits
 *     deterministic markdown based on which sections appear in the skill,
 *     so applied edits change the rollout output → change the score.
 *
 * Hermetic: no real LLM calls, no `DATABASE_URL`, no API keys. PGLite
 * in-memory engine + tempdir SKILL.md + tempdir benchmark JSONL.
 *
 * .serial.test.ts because the stub installs module-state (the chat
 * transport) and the orchestrator walks multi-epoch shared disk state.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';
import {
  __setChatTransportForTests,
  type ChatOpts,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import { runSkillOpt } from '../../src/core/skillopt/orchestrator.ts';
import {
  bestPath,
  loadHistory,
  skillPath,
} from '../../src/core/skillopt/version-store.ts';
import { loadRejectedBuffer } from '../../src/core/skillopt/rejected-buffer.ts';
import type { EditOp } from '../../src/core/skillopt/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(() => {
  // Belt-and-suspenders: ensure no test leaks a stub transport into the
  // next test. Every test path also clears explicitly in its finally block,
  // but a failed assertion mid-stub would skip that; this catches the
  // skipped-cleanup case.
  __setChatTransportForTests(null);
});

// ─── Fixture helpers ────────────────────────────────────────────────────────

const SKILL = 'e2e-loop-skill';

/** A skill with only `## People`. Half the benchmark fails at baseline. */
const SKILL_PEOPLE_ONLY = `---
name: e2e-loop-skill
version: 0.1.0
description: Test skill for E2E SkillOpt loop.
triggers:
  - "do the loop task"
brain_first: exempt
---

# E2E Loop Test Skill

When asked, produce a structured output.

## People
List people mentioned.
`;

/** A skill with both sections. Full benchmark passes at baseline. */
const SKILL_BOTH_SECTIONS = `---
name: e2e-loop-skill
version: 0.1.0
description: Test skill for E2E SkillOpt loop.
triggers:
  - "do the loop task"
brain_first: exempt
---

# E2E Loop Test Skill

When asked, produce a structured output.

## People
List people mentioned.

## Citations
Cite sources.
`;

/**
 * 50 tasks alternating People/Citations rule checks. The benchmark's
 * deterministic structure makes baseline scores predictable: with a
 * People-only skill, only People-tasks pass → score = 0.5 on any sufficiently
 * mixed sample. Split [4,1,5] = 20 train / 5 sel / 25 test (satisfies D17
 * floor).
 */
const SAMPLE_BENCHMARK = Array.from({ length: 50 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0');
  const op = i % 2 === 0 ? 'People' : 'Citations';
  return {
    task_id: `e2e-${n}`,
    task: `Process task ${i + 1}`,
    judge: { kind: 'rule' as const, checks: [{ op: 'contains' as const, arg: op }] },
  };
});

interface Fixture {
  skillsDir: string;
  benchmarkPath: string;
  cleanup: () => void;
}

function setupFixture(skillBody: string = SKILL_PEOPLE_ONLY): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-loop-e2e-'));
  const skillDir = path.join(tmp, SKILL);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillBody);
  const benchmarkPath = path.join(skillDir, 'skillopt-benchmark.jsonl');
  fs.writeFileSync(
    benchmarkPath,
    SAMPLE_BENCHMARK.map((t) => JSON.stringify(t)).join('\n') + '\n',
  );
  return {
    skillsDir: tmp,
    benchmarkPath,
    cleanup: () => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ─── Stub builder ───────────────────────────────────────────────────────────

interface StubOpts {
  /** Edit returned by the FAILURE reflect call. Null/undefined → empty edits. */
  failureEdit?: EditOp | null;
  /** Edit returned by the SUCCESS reflect call. Null/undefined → empty edits. */
  successEdit?: EditOp | null;
  /**
   * Raw text returned by the optimizer (overrides failureEdit + successEdit).
   * Used for the malformed-JSON test case.
   */
  optimizerRaw?: string;
  /**
   * Target-agent text emitter. Defaults to "emit text based on which sections
   * exist in the skill". Override to simulate broken/idiosyncratic agents.
   */
  targetText?: (skillText: string) => string;
  /**
   * Optional per-call usage override for the budget-exhaustion test. When
   * set, every chat call reports this usage (driving cumulative cost up
   * fast against a tight cap).
   */
  perCallUsage?: { input: number; output: number };
}

const REFLECT_OPTIMIZER_PREFIX = "You are SkillOpt's optimizer.";
const FAILURE_REFLECT_MARKER = 'FAILURE TRAJECTORIES';

function defaultTargetText(skillText: string): string {
  // Faithful agent: read the skill's body, emit sections that exist there.
  // Rule-check `contains: 'People'` passes when the section header is present
  // in the rollout's final_text (since the header literal contains 'People').
  const parts: string[] = [];
  if (skillText.includes('## People')) parts.push('## People\nAlice attended the meeting.');
  if (skillText.includes('## Citations')) parts.push('## Citations\nSource: example.com');
  return parts.join('\n\n') || 'No structured output produced.';
}

function makeChatResult(
  text: string,
  model: string,
  usage: { input: number; output: number } = { input: 100, output: 20 },
): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model,
    providerId: 'anthropic',
  };
}

function installStub(opts: StubOpts): void {
  const usage = opts.perCallUsage ?? { input: 100, output: 20 };
  __setChatTransportForTests(async (chatOpts: ChatOpts): Promise<ChatResult> => {
    const sys = chatOpts.system ?? '';
    const isOptimizerCall = sys.startsWith(REFLECT_OPTIMIZER_PREFIX);

    if (isOptimizerCall) {
      const model = chatOpts.model ?? 'anthropic:claude-opus-4-7';
      if (opts.optimizerRaw !== undefined) {
        return makeChatResult(opts.optimizerRaw, model, usage);
      }
      const isFailureMode = sys.includes(FAILURE_REFLECT_MARKER);
      const edit = isFailureMode ? opts.failureEdit : opts.successEdit;
      const text = JSON.stringify({ edits: edit ? [edit] : [] });
      return makeChatResult(text, model, usage);
    }

    // Target-agent rollout.
    const model = chatOpts.model ?? 'anthropic:claude-sonnet-4-6';
    const fn = opts.targetText ?? defaultTargetText;
    return makeChatResult(fn(sys), model, usage);
  });
}

function uninstallStub(): void {
  __setChatTransportForTests(null);
}

// ─── Common runSkillOpt invocation ──────────────────────────────────────────

interface RunOptsOverride {
  maxCostUsd?: number;
  epochs?: number;
  batchSize?: number;
}

async function runOnce(fixture: Fixture, over: RunOptsOverride = {}) {
  return runSkillOpt({
    engine,
    skillName: SKILL,
    skillsDir: fixture.skillsDir,
    benchmarkPath: fixture.benchmarkPath,
    epochs: over.epochs ?? 1,
    batchSize: over.batchSize ?? 2,
    lr: 4,
    lrSchedule: 'constant',
    split: [4, 1, 5],
    optimizerModel: 'anthropic:claude-opus-4-7',
    targetModel: 'anthropic:claude-sonnet-4-6',
    judgeModel: 'anthropic:claude-sonnet-4-6',
    mode: 'patch',
    dryRun: false,
    noMutate: false,
    allowMutateBundled: true,
    bootstrapReviewed: false,
    json: true,
    maxCostUsd: over.maxCostUsd ?? 100,
    maxRuntimeMin: 1,
    force: true, // bypass dirty-tree (tempdir isn't a git repo)
  });
}

// ─── Cases ──────────────────────────────────────────────────────────────────

describe('skillopt full-loop E2E (happy path + broken cases)', () => {
  test('happy path: optimizer proposes a real edit, gate accepts, SKILL.md mutated', async () => {
    const fixture = setupFixture(SKILL_PEOPLE_ONLY);
    try {
      // Optimizer (FAILURE mode) proposes adding a ## Citations section right
      // after the ## People heading. After apply, the agent emits both sections
      // → every rollout passes → sel score goes from 0.5 (baseline) to 1.0,
      // delta = 0.5 ≫ epsilon=0.05 → ACCEPT.
      installStub({
        failureEdit: {
          op: 'add',
          anchor: 'People',
          content: '## Citations\nCite the source for every claim.',
          reason: 'agent failed Citations tasks because no Citations section exists',
        },
        successEdit: null, // success-mode reflect produces no edits
      });
      try {
        await withEnv({ GBRAIN_AUDIT_DIR: fixture.skillsDir }, async () => {
          const result = await runOnce(fixture);

          // Outcome contract: accepted + mutated.
          expect(result.outcome).toBe('accepted');
          expect(result.mutatedSkillFile).toBe(true);

          // SKILL.md on disk now has BOTH sections.
          const finalSkill = fs.readFileSync(skillPath(fixture.skillsDir, SKILL), 'utf8');
          expect(finalSkill).toContain('## People');
          expect(finalSkill).toContain('## Citations');
          // Frontmatter preserved (D5: edits never touch frontmatter).
          expect(finalSkill).toContain('name: e2e-loop-skill');
          expect(finalSkill).toContain('brain_first: exempt');

          // best.md mirrors the on-disk SKILL.md content.
          expect(fs.readFileSync(bestPath(fixture.skillsDir, SKILL), 'utf8')).toBe(finalSkill);

          // History has exactly one committed row with the right shape.
          const history = loadHistory(fixture.skillsDir, SKILL);
          const committed = history.filter((r) => r.status === 'committed');
          expect(committed).toHaveLength(1);
          expect(committed[0]!.version_n).toBe(1);
          expect(committed[0]!.delta).toBeGreaterThan(0.05); // > epsilon
          expect(committed[0]!.sel_score).toBeGreaterThan(committed[0]!.delta); // monotone

          // The committed row records the actual edit applied (not just an empty proposal).
          expect(committed[0]!.edits).toHaveLength(1);
          expect(committed[0]!.edits[0]).toMatchObject({ op: 'add', anchor: 'People' });

          // Receipt sel_score reflects the accepted candidate's score.
          expect(result.receipt.best_sel_score).toBeGreaterThan(0.9);
          expect(result.receipt.outcome).toBe('accepted');
          expect(result.receipt.epochs_completed).toBe(1);
        });
      } finally {
        uninstallStub();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('broken: below-baseline regression edit (gate rejects, SKILL.md unchanged)', async () => {
    // Start with a skill that already scores 1.0. The optimizer (in SUCCESS
    // mode — failures=[] since baseline is perfect) proposes a destructive
    // edit that removes the ## People section. The candidate's sel score
    // collapses to 0.5; the gate rejects with reason=below_baseline; the
    // on-disk SKILL.md MUST stay byte-identical to the baseline.
    const fixture = setupFixture(SKILL_BOTH_SECTIONS);
    try {
      installStub({
        failureEdit: null,
        successEdit: {
          op: 'delete',
          target: '## People\nList people mentioned.\n',
          reason: 'mistakenly thinks the People section is redundant',
        },
      });
      try {
        await withEnv({ GBRAIN_AUDIT_DIR: fixture.skillsDir }, async () => {
          const result = await runOnce(fixture);

          // Outcome contract: no acceptance + no mutation.
          expect(result.outcome).toBe('no_improvement');
          expect(result.mutatedSkillFile).toBe(false);

          // SKILL.md on disk is byte-identical to baseline.
          expect(fs.readFileSync(skillPath(fixture.skillsDir, SKILL), 'utf8'))
            .toBe(SKILL_BOTH_SECTIONS);

          // History is empty (no committed rows; rejected edits don't enter history).
          const history = loadHistory(fixture.skillsDir, SKILL);
          expect(history.filter((r) => r.status === 'committed')).toHaveLength(0);

          // The destructive edit landed in the rejected-edits buffer for
          // anti-bias context on future runs (the optimizer learns).
          const rejected = loadRejectedBuffer(fixture.skillsDir, SKILL);
          expect(rejected.length).toBeGreaterThan(0);
          expect(rejected.some((e) => e.reason.startsWith('validation_gate'))).toBe(true);
          // The recorded edit shape matches the destructive proposal so the
          // optimizer's anti-bias prompt sees the actual edit, not a stub.
          expect(rejected.some((e) =>
            e.edits.some((edit) => edit.op === 'delete' && (edit as { target: string }).target.includes('## People')),
          )).toBe(true);
        });
      } finally {
        uninstallStub();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('broken: malformed reflect JSON (no edits parsed, no acceptance)', async () => {
    // The optimizer returns syntactically broken JSON. The reflect module's
    // forgiving parser yields zero valid edits; applyEditBatch sees an empty
    // batch; the orchestrator hits the "no_edits_applied" branch; the sel
    // gate is never invoked. SKILL.md stays untouched. Critically: the run
    // does NOT crash on malformed optimizer output (graceful degradation).
    const fixture = setupFixture(SKILL_PEOPLE_ONLY);
    try {
      installStub({
        // Adversarial: looks like JSON but isn't. Different broken shapes
        // hit different fallback paths in tryExtractEdits.
        optimizerRaw: '{"edits": [BROKEN, no quotes, trailing comma,]',
      });
      try {
        await withEnv({ GBRAIN_AUDIT_DIR: fixture.skillsDir }, async () => {
          const result = await runOnce(fixture);

          expect(result.outcome).toBe('no_improvement');
          expect(result.mutatedSkillFile).toBe(false);
          expect(fs.readFileSync(skillPath(fixture.skillsDir, SKILL), 'utf8'))
            .toBe(SKILL_PEOPLE_ONLY);
          expect(loadHistory(fixture.skillsDir, SKILL).filter((r) => r.status === 'committed'))
            .toHaveLength(0);
        });
      } finally {
        uninstallStub();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('broken: anchor-not-found edit (apply rejects, sel gate skipped)', async () => {
    // The optimizer proposes a structurally valid edit pointing at a heading
    // that doesn't exist in the skill. applyEditBatch returns all-rejected;
    // the orchestrator's all-rejected branch fires (logs no_edits_applied,
    // pushes to rejected-buffer, skips the sel gate). The skill stays
    // unchanged AND the bogus anchor lands in the rejected-buffer with
    // reason 'apply_failed' (separate from gate-rejected entries).
    const fixture = setupFixture(SKILL_PEOPLE_ONLY);
    try {
      installStub({
        failureEdit: {
          op: 'add',
          anchor: 'NonExistentHeading',
          content: 'Some content',
          reason: 'optimizer hallucinated a heading',
        },
      });
      try {
        await withEnv({ GBRAIN_AUDIT_DIR: fixture.skillsDir }, async () => {
          const result = await runOnce(fixture);

          expect(result.outcome).toBe('no_improvement');
          expect(result.mutatedSkillFile).toBe(false);
          expect(fs.readFileSync(skillPath(fixture.skillsDir, SKILL), 'utf8'))
            .toBe(SKILL_PEOPLE_ONLY);

          // Rejected-buffer should carry an apply_failed entry (the failed
          // anchor lookup is recorded so the optimizer doesn't re-propose).
          const rejected = loadRejectedBuffer(fixture.skillsDir, SKILL);
          expect(rejected.length).toBeGreaterThan(0);
          expect(rejected.some((e) => e.reason === 'apply_failed')).toBe(true);
        });
      } finally {
        uninstallStub();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('broken: budget exhausted mid-run (aborts cleanly, no half-committed state)', async () => {
    // Cap is just under the preflight estimate so the run starts (preflight
    // refusal would prevent us from observing BudgetExhausted mid-loop), then
    // trips on the cumulative spend during the loop. Outcome=aborted is the
    // contract; the load-bearing assertion is that NO pending or committed
    // history rows survive (the abort path must not leave the skill in a
    // half-mutated state).
    const fixture = setupFixture(SKILL_PEOPLE_ONLY);
    try {
      installStub({
        failureEdit: {
          op: 'add',
          anchor: 'People',
          content: '## Citations\nCite.',
          reason: 'mid-budget edit',
        },
        // Drive per-call cost up so the cumulative spend trips the cap fast.
        perCallUsage: { input: 50_000, output: 5_000 },
      });
      try {
        await withEnv({ GBRAIN_AUDIT_DIR: fixture.skillsDir }, async () => {
          // The exact cap is calibrated to (a) survive the preflight check
          // (preflight refuses with a CostCapExceeded error if its estimate
          // exceeds the cap), but (b) trip mid-loop when real per-call
          // usage from the stub accumulates. Preflight estimates assume
          // small per-call usage; the stub inflates per-call usage so we
          // exceed the cap before the loop completes.
          let result: Awaited<ReturnType<typeof runOnce>>;
          try {
            result = await runOnce(fixture, { maxCostUsd: 5.0 });
          } catch (err) {
            // Acceptable: preflight may refuse before the loop starts if its
            // estimator now overshoots. In that case the contract becomes
            // "no mutation happened" — assert that directly via filesystem.
            const msg = err instanceof Error ? err.message : String(err);
            expect(msg).toMatch(/cost|budget/i);
            expect(fs.readFileSync(skillPath(fixture.skillsDir, SKILL), 'utf8'))
              .toBe(SKILL_PEOPLE_ONLY);
            return;
          }

          // Reaching the loop: budget exhausted is the expected outcome. Other
          // non-acceptance outcomes (no_improvement, errored) are also fine
          // — the load-bearing assertion is no half-committed state.
          expect(['aborted', 'no_improvement', 'errored']).toContain(result.outcome);

          // No PENDING rows: the v0.42 D8 two-phase commit insists every
          // pending row is either committed or reverted; an abort path that
          // leaves a pending row would corrupt resume.
          const history = loadHistory(fixture.skillsDir, SKILL);
          expect(history.filter((r) => r.status === 'pending')).toHaveLength(0);

          // If outcome is aborted, MUST NOT mutate.
          if (result.outcome === 'aborted') {
            expect(result.mutatedSkillFile).toBe(false);
            expect(fs.readFileSync(skillPath(fixture.skillsDir, SKILL), 'utf8'))
              .toBe(SKILL_PEOPLE_ONLY);
          }
        });
      } finally {
        uninstallStub();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('converged skill: re-running on perfect baseline yields no_improvement (no double-commit)', async () => {
    // Start from an already-perfect skill (baseline score = 1.0). The forward
    // gate finds zero failures. The reflect failure-mode path is never
    // invoked (failures=[]); only success-mode runs. The success-mode stub
    // returns empty edits. The loop converges with outcome=no_improvement
    // and the on-disk skill stays byte-identical. This proves the optimizer
    // doesn't pointlessly mutate a converged skill — the v1 "convergence"
    // path that protects against thrash on a well-tuned starting point.
    const fixture = setupFixture(SKILL_BOTH_SECTIONS);
    try {
      installStub({
        failureEdit: null, // wouldn't be called anyway — baseline has no failures
        successEdit: null, // success-mode stub returns empty edits
      });
      try {
        await withEnv({ GBRAIN_AUDIT_DIR: fixture.skillsDir }, async () => {
          const result = await runOnce(fixture);

          expect(result.outcome).toBe('no_improvement');
          expect(result.mutatedSkillFile).toBe(false);
          expect(fs.readFileSync(skillPath(fixture.skillsDir, SKILL), 'utf8'))
            .toBe(SKILL_BOTH_SECTIONS);

          // Receipt baseline IS the best score (no improvement to report).
          expect(result.receipt.best_sel_score).toBeGreaterThan(0.9);

          // History is empty.
          expect(loadHistory(fixture.skillsDir, SKILL).filter((r) => r.status === 'committed'))
            .toHaveLength(0);
        });
      } finally {
        uninstallStub();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('idempotent re-run: accept once, run again, second run sees new baseline + does not re-mutate', async () => {
    // The cathedral test: drive the loop twice in sequence on the same
    // fixture. Run 1 accepts the add-Citations edit (skill improves from
    // People-only to both sections). Run 2 starts from the now-improved
    // skill, sees baseline=1.0, finds no failures, returns no_improvement.
    // SKILL.md stays at v1; history still has exactly one committed row.
    // This proves the optimizer is "stable at the fixed point" — the
    // critical property of an iterative optimizer.
    const fixture = setupFixture(SKILL_PEOPLE_ONLY);
    try {
      // Same stub config across both runs: failure-mode proposes the
      // add-Citations edit. After run 1 accepts it, run 2's forward gate
      // sees no failures → failure-reflect never fires → no edits proposed.
      const stubConfig = {
        failureEdit: {
          op: 'add' as const,
          anchor: 'People',
          content: '## Citations\nCite the source.',
          reason: 'baseline missing Citations section',
        },
        successEdit: null,
      };

      // Run 1: accept.
      installStub(stubConfig);
      try {
        await withEnv({ GBRAIN_AUDIT_DIR: fixture.skillsDir }, async () => {
          const result1 = await runOnce(fixture);
          expect(result1.outcome).toBe('accepted');
          expect(result1.mutatedSkillFile).toBe(true);
        });
      } finally {
        uninstallStub();
      }

      const afterRun1 = fs.readFileSync(skillPath(fixture.skillsDir, SKILL), 'utf8');
      const historyAfterRun1 = loadHistory(fixture.skillsDir, SKILL);
      expect(historyAfterRun1.filter((r) => r.status === 'committed')).toHaveLength(1);

      // Run 2: same stub, but loop should observe the improved baseline and
      // converge without further mutation.
      installStub(stubConfig);
      try {
        await withEnv({ GBRAIN_AUDIT_DIR: fixture.skillsDir }, async () => {
          const result2 = await runOnce(fixture);
          expect(result2.outcome).toBe('no_improvement');
          expect(result2.mutatedSkillFile).toBe(false);
        });
      } finally {
        uninstallStub();
      }

      // SKILL.md byte-identical to its state after run 1.
      expect(fs.readFileSync(skillPath(fixture.skillsDir, SKILL), 'utf8')).toBe(afterRun1);

      // History still has exactly one committed row (no double-commit).
      const historyAfterRun2 = loadHistory(fixture.skillsDir, SKILL);
      expect(historyAfterRun2.filter((r) => r.status === 'committed')).toHaveLength(1);
      // version_n unchanged at 1.
      expect(historyAfterRun2.filter((r) => r.status === 'committed')[0]!.version_n).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
});
