/**
 * C3 (test-gap wave, TODOS "dream-path quota-degradation integration tests")
 * — live-queue integration coverage for the three QueueQuotaExceededError
 * consumers, driven against a REAL PGLite-backed MinionQueue with the
 * admission quota forced low via the real config knob
 * (`minions.quota_max_waiting.subagent`, resolved by
 * src/core/minions/admission.ts:resolveAdmissionPolicy and enforced inside
 * queue.add's transaction, src/core/minions/queue.ts).
 *
 *   1. cycle PATTERNS phase (src/core/cycle/patterns.ts): a refused submit is
 *      a recorded phase SKIP — status 'skipped', details.reason
 *      'admission_quota' — never a phase crash.
 *   2. dream SYNTHESIZE fan-out (src/core/cycle/synthesize.ts): the quota
 *      LATCH — after the first refusal, exactly one skip report per
 *      transcript (the refused one carries the quota message; every
 *      remaining one carries the literal 'admission_quota: submission
 *      stopped this run') and NO further queue.add attempts this run.
 *      Code-truth note vs the TODO's wording ("one skip per remaining
 *      transcript"): the REFUSED transcript gets a skip too — N transcripts
 *      → N skips, 1 message-form + (N-1) latch-form.
 *   3. `gbrain agent run --fanout-manifest` (src/commands/agent.ts): a
 *      mid-fanout refusal cancels the WHOLE tree (aggregator + already-
 *      submitted children, via cancelJob's recursive cascade) and the CLI
 *      exits 1.
 *
 * Each consumer has an anti-vacuity control where a CONFIGURED quota admits
 * (quota present but not binding), proving the refusal assertions bite.
 *
 * Keyless/hermetic: the quota arms never run a child. The control arms drain
 * children that immediately terminalize (auto-cancel poller and/or a fake
 * ANTHROPIC_API_KEY whose dispatch fails fast — same harness as
 * test/cycle-synthesize-daily-cap.test.ts and
 * test/cycle-patterns-child-outcome.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { _resetAdmissionCacheForTest } from '../../src/core/minions/admission.ts';
import { runPhasePatterns } from '../../src/core/cycle/patterns.ts';
import { runPhaseSynthesize, TRIAGE_VERSION } from '../../src/core/cycle/synthesize.ts';
import { runAgentRun } from '../../src/commands/agent.ts';
import { TIER_DEFAULTS } from '../../src/core/model-config.ts';

// Canonical shared-engine block (check-test-isolation R3/R4).
let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  // resetPgliteState truncates `config`, wiping the `version` row that
  // MinionQueue.ensureSchema checks. Capture it so beforeEach can restore.
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  // The admission-policy cache is module-global with a 60s TTL — a quota
  // cached by a previous test (or file) must never leak into this one.
  _resetAdmissionCacheForTest();
});

afterEach(() => {
  // Symmetric: never leak a 1-quota policy for 'subagent' to later suites
  // sharing this shard process.
  _resetAdmissionCacheForTest();
});

/**
 * Pinned fragment of QueueQuotaExceededError's message for quota=1
 * (src/core/minions/admission.ts — names the quota, never the live count).
 */
const QUOTA_MSG_FRAGMENT = `queue admission: 'subagent' is at its waiting quota (1, all queues)`;
/** Pinned latch reason literal (src/core/cycle/synthesize.ts, quotaHit arm). */
const LATCH_REASON = 'admission_quota: submission stopped this run';

const FILLER_QUEUE = 'quota-filler-fixture';

/**
 * One pre-existing WAITING subagent row (direct SQL — no admission side
 * effects, no idempotency key, foreign queue) so a quota of 1 refuses every
 * subsequent 'subagent' submit: the quota counts the name across ALL queues.
 */
async function seedWaitingSubagentFiller(): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (name, queue, status, data)
     VALUES ('subagent', $1, 'waiting', '{"prompt": "quota filler"}'::jsonb)`,
    [FILLER_QUEUE],
  );
}

async function subagentRows(): Promise<Array<{ queue: string; status: string }>> {
  return engine.executeRaw<{ queue: string; status: string }>(
    `SELECT queue, status FROM minion_jobs WHERE name = 'subagent' ORDER BY id`,
  );
}

/**
 * Cancel any subagent job the moment it lands (except `excludeQueue`) so the
 * control arms' inline drains/waits return promptly instead of running a
 * real child. Verbatim harness from test/cycle-synthesize-daily-cap.test.ts.
 */
async function withSubagentAutoCancel<T>(
  body: () => Promise<T>,
  opts: { excludeQueue?: string } = {},
): Promise<T> {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      await new Promise(r => setTimeout(r, 50));
      try {
        await engine.executeRaw(
          `UPDATE minion_jobs
              SET status = 'cancelled', finished_at = now()
            WHERE name = 'subagent' AND status IN ('waiting', 'active')
              AND ($1::text IS NULL OR queue <> $1)`,
          [opts.excludeQueue ?? null],
        );
      } catch { /* race against shutdown is fine */ }
    }
  })();
  try {
    return await body();
  } finally {
    stopped = true;
    await loop;
  }
}

// ── consumer 1: cycle PATTERNS phase ─────────────────────────────────────

/** Enough recent reflections to clear min_evidence (default 3). */
async function seedReflections(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth)
       VALUES ($1, 'note', $2, $3)`,
      [
        `wiki/personal/reflections/2026-08-0${i + 1}-reflection`,
        `Reflection ${i + 1}`,
        `Recurring quota-fixture theme number ${i + 1}.`,
      ],
    );
  }
}

describe('patterns phase — admission quota degradation (C3.1)', () => {
  test('quota refusal → phase reports skipped with reason admission_quota (never a crash)', async () => {
    const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-c3-patterns-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-c3-isol-'));
    try {
      await seedReflections();
      await seedWaitingSubagentFiller();
      await engine.setConfig('minions.quota_max_waiting.subagent', '1');
      _resetAdmissionCacheForTest();

      // Fake key only satisfies the probeChatModel gate (which sits BEFORE
      // queue.add); the refused submit means no child ever dispatches.
      const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', GBRAIN_HOME: tmpHome }, () =>
        runPhasePatterns(engine, { brainDir, dryRun: false }),
      );

      expect(result.status).toBe('skipped');
      expect(result.details.reason).toBe('admission_quota');
      // The skip summary carries the typed error's real message: the quota
      // (caller's admission contract) + the tune hint, never the live count.
      expect(result.summary).toContain(QUOTA_MSG_FRAGMENT);
      expect(result.summary).toContain('minions.quota_max_waiting.subagent');

      // No child row landed: only the filler survives, untouched.
      const rows = await subagentRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ queue: FILLER_QUEUE, status: 'waiting' });
    } finally {
      fs.rmSync(brainDir, { recursive: true, force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('control: quota configured but not binding → submit is admitted, phase proceeds past admission', async () => {
    const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-c3-patterns-ctl-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-c3-isol-'));
    try {
      await seedReflections();
      await engine.setConfig('minions.quota_max_waiting.subagent', '10');
      _resetAdmissionCacheForTest();

      const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', GBRAIN_HOME: tmpHome }, () =>
        withSubagentAutoCancel(() =>
          runPhasePatterns(engine, { brainDir, dryRun: false }),
        ),
      );

      // Anti-vacuity: with the SAME knob configured (just not binding), the
      // phase gets past admission — a real child row lands in this run's
      // private dream-inline queue and the outcome is the child's, not a
      // quota skip.
      expect(result.status).not.toBe('skipped');
      expect(result.details.reason).not.toBe('admission_quota');
      const rows = await subagentRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.queue).toMatch(/^dream-inline-/);
      // In this harness the child can only terminalize cancelled (poller) or
      // dead (fake-key dispatch failure); zero writes → honest phase fail
      // (#2782 outcome gate), which is exactly "not the admission-quota skip".
      expect(result.status).toBe('fail');
      expect(['cancelled', 'dead']).toContain(result.details.child_outcome as string);
      expect(String(result.error?.code)).toMatch(/^PATTERNS_CHILD_(CANCELLED|DEAD)$/);
    } finally {
      fs.rmSync(brainDir, { recursive: true, force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 60_000);
});

// ── consumer 2: dream SYNTHESIZE submit latch ────────────────────────────

interface SynthRig {
  brainDir: string;
  corpusDir: string;
  cleanup: () => void;
}

async function setupSynthRig(): Promise<SynthRig> {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-c3-synth-brain-'));
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-c3-synth-corpus-'));
  await engine.setConfig('dream.synthesize.enabled', 'true');
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  return {
    brainDir,
    corpusDir,
    cleanup: () => {
      try { fs.rmSync(brainDir, { recursive: true, force: true }); } catch { /* */ }
      try { fs.rmSync(corpusDir, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

/** Write a small transcript + seed a passing triage verdict (cache hit → keyless). */
async function seedPassingFile(rig: SynthRig, name: string): Promise<string> {
  const content = `conversation in ${name}\n`.repeat(200);
  const filePath = path.join(rig.corpusDir, name);
  fs.writeFileSync(filePath, content);
  const hash = createHash('sha256').update(content, 'utf8').digest('hex');
  await engine.putDreamVerdict(filePath, hash, {
    worth_processing: true,
    reasons: ['seed'],
    score: 0.9,
    content_type: null,
    segments: [],
    entities: [],
    model: TIER_DEFAULTS.utility,
    triage_version: TRIAGE_VERSION,
  });
  return filePath;
}

interface SynthDetails {
  children_submitted: number;
  skips: Array<{ filePath: string; reason: string }>;
}

describe('synthesize phase — admission-quota latch (C3.2)', () => {
  test('refusal at first submit latches: one skip per transcript, exactly one submit attempt, cooldown unstamped', async () => {
    const rig = await setupSynthRig();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-c3-isol-'));
    try {
      const files = [
        await seedPassingFile(rig, '2026-08-01-a.txt'),
        await seedPassingFile(rig, '2026-08-02-b.txt'),
        await seedPassingFile(rig, '2026-08-03-c.txt'),
      ];
      await seedWaitingSubagentFiller();
      await engine.setConfig('minions.quota_max_waiting.subagent', '1');
      _resetAdmissionCacheForTest();

      // Pin "NO further submit attempts" at the real seam: count queue.add
      // calls for name 'subagent'. Prototype patch (the phase constructs its
      // own MinionQueue) delegating to the real method, restored in finally.
      const realAdd = MinionQueue.prototype.add;
      let subagentAddAttempts = 0;
      MinionQueue.prototype.add = async function (this: MinionQueue, ...args: Parameters<typeof realAdd>) {
        if (String(args[0] ?? '').trim() === 'subagent') subagentAddAttempts++;
        return realAdd.apply(this, args);
      };
      let result: Awaited<ReturnType<typeof runPhaseSynthesize>>;
      try {
        result = await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: tmpHome }, () =>
          runPhaseSynthesize(engine, { brainDir: rig.brainDir, dryRun: false }),
        );
      } finally {
        MinionQueue.prototype.add = realAdd;
      }

      // Zero-submission runs report 'ok' (CX8 posture) with honest skip
      // accounting — a refused fan-out is degradation, not a phase crash.
      expect(result.status).toBe('ok');
      expect(result.summary).toContain('no synthesis submitted (3 passing file(s) skipped)');
      const details = result.details as unknown as SynthDetails;
      expect(details.children_submitted).toBe(0);

      // Exactly ONE skip per transcript: the refused one carries the quota
      // message; every remaining one carries the pinned latch literal.
      expect(details.skips).toHaveLength(3);
      expect(details.skips[0]!.reason).toContain(QUOTA_MSG_FRAGMENT);
      expect(details.skips[0]!.reason.startsWith('admission_quota: ')).toBe(true);
      expect(details.skips[1]!.reason).toBe(LATCH_REASON);
      expect(details.skips[2]!.reason).toBe(LATCH_REASON);
      expect(details.skips.map(s => s.filePath).sort()).toEqual([...files].sort());

      // The latch stopped the fan-out: ONE attempted submit total (the
      // refused first chunk); transcripts 2 and 3 never reached queue.add.
      expect(subagentAddAttempts).toBe(1);

      // No row landed besides the filler, still waiting (the phase's private-
      // queue reconcile must not touch a foreign queue).
      const rows = await subagentRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ queue: FILLER_QUEUE, status: 'waiting' });

      // A run that submitted nothing must not stamp the cooldown (CX8): the
      // next cycle retries these transcripts once the backlog drains.
      const ts = await engine.getConfig('dream.synthesize.last_completion_ts');
      expect(ts ?? null).toBeNull();
    } finally {
      rig.cleanup();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('control: quota configured but not binding → every transcript submits, zero admission skips', async () => {
    const rig = await setupSynthRig();
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-c3-isol-'));
    try {
      await seedPassingFile(rig, '2026-08-04-d.txt');
      await seedPassingFile(rig, '2026-08-05-e.txt');
      await engine.setConfig('minions.quota_max_waiting.subagent', '10');
      _resetAdmissionCacheForTest();

      const result = await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: tmpHome }, () =>
        withSubagentAutoCancel(() =>
          runPhaseSynthesize(engine, { brainDir: rig.brainDir, dryRun: false }),
        ),
      );

      // Keyless harness: every submitted child terminalizes without writing,
      // so the phase reports the all-children-dead failure — the subject
      // here is ADMISSION accounting, not the child verdict (same acceptance
      // as test/cycle-synthesize-daily-cap.test.ts).
      if (result.status !== 'ok') {
        expect(result.error?.code).toBe('SYNTH_ALL_CHILDREN_DEAD');
      }
      const details = result.details as unknown as SynthDetails;
      expect(details.children_submitted).toBe(2);
      expect(details.skips.filter(s => s.reason.startsWith('admission_quota'))).toHaveLength(0);
    } finally {
      rig.cleanup();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 60_000);
});

// ── consumer 3: `gbrain agent run --fanout-manifest` ─────────────────────

function writeManifest(dir: string, prompts: string[]): string {
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(prompts.map(p => ({ prompt: p }))));
  return manifestPath;
}

describe('agent fanout — admission quota cancels the whole tree (C3.3)', () => {
  test('mid-fanout refusal → aggregator + submitted children cancelled, CLI exits 1', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-c3-fanout-'));
    const manifestPath = writeManifest(tmp, ['chunk one', 'chunk two', 'chunk three']);
    // quota=1, no filler: child 1 admits (0 waiting < 1), child 2 is refused
    // (1 >= 1) — the aggregator is name 'subagent_aggregator' and never
    // counts against the 'subagent' quota.
    await engine.setConfig('minions.quota_max_waiting.subagent', '1');
    _resetAdmissionCacheForTest();

    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code}__`);
    }) as never);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
        try {
          await runAgentRun(engine, ['--fanout-manifest', manifestPath, '--detach']);
          throw new Error('expected runAgentRun to exit 1 on mid-fanout quota refusal');
        } catch (e) {
          expect((e as Error).message).toBe('__EXIT_1__');
        }
      });
      expect(exitSpy).toHaveBeenCalledWith(1);

      // The abort message is honest about where the fan-out died and what
      // was rolled back (all-or-nothing beats a wedged aggregator).
      const errText = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(errText).toContain('fanout aborted at child 2/3:');
      expect(errText).toContain(QUOTA_MSG_FRAGMENT);
      expect(errText).toMatch(/Aggregator \d+ and its 1 submitted child\(ren\) were cancelled\./);

      // Whole tree cancelled: aggregator root + the one submitted child
      // (cancelJob's recursive descendant cascade), nothing left runnable.
      const agg = await engine.executeRaw<{ id: number; status: string }>(
        `SELECT id, status FROM minion_jobs WHERE name = 'subagent_aggregator'`,
      );
      expect(agg).toHaveLength(1);
      expect(agg[0]!.status).toBe('cancelled');
      const kids = await engine.executeRaw<{ status: string; parent_job_id: number }>(
        `SELECT status, parent_job_id FROM minion_jobs WHERE name = 'subagent'`,
      );
      expect(kids).toHaveLength(1);
      expect(kids[0]!.status).toBe('cancelled');
      expect(Number(kids[0]!.parent_job_id)).toBe(Number(agg[0]!.id));
      const live = await engine.executeRaw<{ count: string }>(
        `SELECT count(*)::text AS count FROM minion_jobs
          WHERE status IN ('waiting', 'active', 'waiting-children')`,
      );
      expect(parseInt(live[0]!.count, 10)).toBe(0);
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('control: quota configured but sufficient → full tree submits, no exit', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-c3-fanout-ctl-'));
    const manifestPath = writeManifest(tmp, ['chunk one', 'chunk two', 'chunk three']);
    // quota=3 admits all three children (waiting counts 0, 1, 2 at check time).
    await engine.setConfig('minions.quota_max_waiting.subagent', '3');
    _resetAdmissionCacheForTest();

    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code}__`);
    }) as never);
    try {
      await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        runAgentRun(engine, ['--fanout-manifest', manifestPath, '--detach']),
      );
      expect(exitSpy).not.toHaveBeenCalled();

      const agg = await engine.executeRaw<{ id: number; status: string; data: unknown }>(
        `SELECT id, status, data FROM minion_jobs WHERE name = 'subagent_aggregator'`,
      );
      expect(agg).toHaveLength(1);
      expect(agg[0]!.status).toBe('waiting-children');
      const kids = await engine.executeRaw<{ id: number; status: string; parent_job_id: number }>(
        `SELECT id, status, parent_job_id FROM minion_jobs WHERE name = 'subagent' ORDER BY id`,
      );
      expect(kids).toHaveLength(3);
      for (const k of kids) {
        expect(k.status).toBe('waiting');
        expect(Number(k.parent_job_id)).toBe(Number(agg[0]!.id));
      }
      // The aggregator's children_ids was flipped to the submitted set.
      const aggData = typeof agg[0]!.data === 'string'
        ? JSON.parse(agg[0]!.data as string) as Record<string, unknown>
        : agg[0]!.data as Record<string, unknown>;
      expect((aggData.children_ids as number[]).map(Number)).toEqual(kids.map(k => Number(k.id)));
    } finally {
      exitSpy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
