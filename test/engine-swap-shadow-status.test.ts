/**
 * The engine swap reads the shadow's own status document (docs/guides/engine-swap.md#plan, #no_shadow).
 *
 * Authoring gate (docs/TESTING.md): (1) protects the swap verdict in production: before this, `gbrain engine swap`
 * was never given the shadow status, so every criterion read as missing and the swap could never be READY. (2) Fails
 * when the swap reads a different document than `gbrain engine shadow status --json` prints, when a brain with no
 * shadow is not refused as `no_shadow`, when a failed fingerprint probe in the shadow's files does not reach the
 * verdict as a failed criterion 7, or when extra probe fields the shadow adds break criterion 7. (3) The
 * readiness evaluator tests (test/engine-swap-readiness.test.ts) take a hand-made document; nothing tested the read
 * from the shadow's files. (4) No seam on the read: real shadow files written by the shadow's own writers under a
 * temporary GBRAIN_HOME, and the real shadow status command.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { runEngineSwap, renderPlanText } from '../src/commands/engine-swap.ts';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { evaluateReadiness, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import type { SwapPlan } from '../src/core/engine-swap/plan.ts';
import { NOT_RUN_PROBE, writeFollowerFile, type FollowerFile } from '../src/shadow/follow-status.ts';
import { writeSeedRecord, type SeedRecord } from '../src/shadow/seed.ts';
import { SHADOW_STATE_VERSION, shadowBrainKey, shadowDirFor, writeShadowState, type ShadowState } from '../src/shadow/state.ts';
import { readConfiguredShadowStatus, shadowStatusDocument } from '../src/shadow/status-document.ts';
import { withEnv } from './helpers/with-env.ts';

const CONFIG = { engine: 'pglite' as const, database_path: '/brains/example.pglite' };
const SEED = { version: 1, seed_id: 'seed-1', started_at: '2026-11-01T00:00:00.000Z', finished_at: '2026-11-01T00:01:00.000Z', primary_engine: 'pglite', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, losses: { values: {}, not_copied: [], gaps: {} } } as unknown as SeedRecord;
const STATE: ShadowState = { version: SHADOW_STATE_VERSION, enabled: true, started_at: '2026-11-01T00:00:00.000Z', sample_rate: 0.1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' };

function follower(now: Date, probe: Record<string, unknown>): FollowerFile {
  return {
    version: 1, epoch_id: SEED.seed_id, seed_id: SEED.seed_id, epoch_started_at: SEED.finished_at, updated_at: now.toISOString(), applied_rows: 40, queue_depth: 0, lag_ms: 0,
    last_seq: 7, watermark: { valid: true, through: now.toISOString(), invalidated_reason: null }, lag: { epoch: [5], hours: {} },
    fingerprints: { checked_rows: 900, mismatches: 0 }, probe: probe as unknown as FollowerFile['probe'], allocators: { verified: true, checked_at: now.toISOString() },
  };
}

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = (): string => { const h = mkdtempSync(join(tmpdir(), 'gbrain-swap-shadow-')); homes.push(h); return h; };

/** Writes a seeded, running shadow for CONFIG with the shadow's own writers. Returns its directory. */
function writeShadow(now: Date, probe: Record<string, unknown>): string {
  const dir = shadowDirFor(shadowBrainKey(CONFIG)!);
  writeShadowState(dir, STATE);
  writeSeedRecord(dir, SEED);
  writeFollowerFile(dir, follower(now, probe));
  return dir;
}

let engine: BrainEngine;
beforeAll(async () => { const e = new PGLiteEngine(); await e.connect({}); await e.initSchema(); engine = e; }, 60_000);
afterAll(async () => { await engine.disconnect(); });

async function swapPlan(now: Date): Promise<{ code: number; plan: SwapPlan; text: string }> {
  const run = async (json: boolean) => {
    let stdout = '';
    let error = '';
    const code = await runEngineSwap(['--to', 'rust', '--plan', ...(json ? ['--json'] : [])], {
      openEngine: async () => Object.assign(Object.create(engine), { disconnect: async () => undefined }) as BrainEngine,
      readShadowStatus: async () => (await readConfiguredShadowStatus(() => CONFIG, now)) as ShadowStatus | null, resolveBrain: () => 'host', env: {}, home: '', now,
      out: t => { stdout += t; },
      writeError: (e, o) => { const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false }); error = r.stdout ?? r.stderr ?? ''; return r.exitCode; },
    });
    if (code !== 0) throw new Error(`swap plan exited ${code}: ${error}`);
    return { code, stdout };
  };
  const json = await run(true);
  const text = await run(false);
  return { code: json.code, plan: JSON.parse(json.stdout) as SwapPlan, text: text.stdout };
}

describe('the engine swap reads the shadow status document', () => {
  test('the swap reads exactly the document `gbrain engine shadow status --json` prints', async () => {
    const h = home();
    await withEnv({ GBRAIN_HOME: h }, async () => {
      const now = new Date();
      const dir = writeShadow(now, { ...NOT_RUN_PROBE, state: 'pass', checked_at: now.toISOString(), server_version: '16', collation: 'C' });
      let printed = '';
      expect(await runEngineShadow(['status', '--json'], { config: () => CONFIG, out: l => { printed += l; }, now: () => now })).toBe(0);
      const doc = await shadowStatusDocument({ key: shadowBrainKey(CONFIG)!, dir }, now);
      expect(JSON.parse(printed)).toEqual(JSON.parse(JSON.stringify(doc)));
      expect(await readConfiguredShadowStatus(() => CONFIG, now)).toEqual(doc as never);
    });
  });

  test('no shadow for this brain: NOT READY with reason no_shadow, pointing at `gbrain engine shadow start`', async () => {
    const h = home();
    await withEnv({ GBRAIN_HOME: h }, async () => {
      const now = new Date();
      expect(await readConfiguredShadowStatus(() => CONFIG, now)).toBeNull();
      const { plan, text } = await swapPlan(now);
      expect(plan.verdict).toBe('NOT READY');
      expect(plan.reason).toBe('no_shadow');
      expect(plan.shadow).toBe(false);
      expect(text).toContain('verdict: NOT READY (no_shadow)');
      expect(text).toContain('gbrain engine shadow start');
      expect(text.indexOf('gbrain engine shadow seed')).toBeGreaterThan(-1);
      expect(text.indexOf('gbrain engine shadow seed')).toBeLessThan(text.indexOf('gbrain engine shadow start')); // seed refuses while shadow mode is on
      expect(renderPlanText(plan)).toBe(text);
    });
  });

  test('a failed fingerprint probe in the shadow files fails criterion 7', async () => {
    const h = home();
    await withEnv({ GBRAIN_HOME: h }, async () => {
      const now = new Date();
      writeShadow(now, { state: 'fail', checked_at: now.toISOString(), server_version: '16', collation: 'en_US.utf8', mismatches: 3 });
      const { plan } = await swapPlan(now);
      expect(plan.shadow).toBe(true);
      expect(plan.verdict).toBe('NOT READY');
      const c7 = plan.criteria.find(c => c.n === 7)!;
      expect(c7.state).toBe('fail');
      expect(c7.detail).toContain('the fingerprint probe failed');
      // No shadow writes eligibility evidence yet, and a missing topology outranks every other reason
      // (test/engine-swap-readiness.test.ts), so the named reason is writer_coverage_unknown until it does.
      expect(plan.reason).toBe('writer_coverage_unknown');
      // The follower fields the shadow writes reach the swap: they are not in the missing list.
      for (const f of ['fingerprints.mismatches', 'fingerprints.probe.state', 'allocators.verified', 'follower.lag_ms_p99_epoch']) expect(plan.missing_fields).not.toContain(f);
    });
  });

  test('extra fields the shadow adds under fingerprints.probe are ignored; criterion 7 still passes', async () => {
    const h = home();
    await withEnv({ GBRAIN_HOME: h }, async () => {
      const now = new Date();
      writeShadow(now, {
        state: 'pass', checked_at: now.toISOString(), server_version: '16', collation: 'C', mismatches: 0,
        ctype: 'C', locale_provider: 'libc', locale: 'C', differing_code_points: [], differing_code_points_total: 0, corpus_mismatches: 0, facts_with_differing_code_points: 0,
      });
      const { plan } = await swapPlan(now);
      expect(plan.criteria.find(c => c.n === 7)!.state).toBe('pass');
      expect(plan.reason).not.toBe('fingerprint_semantics_differ');
    });
  });

  test('the evaluator names no_shadow for a missing document', () => {
    const v = evaluateReadiness(null, new Date());
    expect(v.verdict).toBe('NOT READY');
    expect(v.reason).toBe('no_shadow');
  });
});

describe('the production `gbrain engine swap` command', () => {
  /** Runs the CLI's own `engine swap --to rust --plan --json` and returns the plan it printed. */
  async function cliPlan(): Promise<SwapPlan> {
    const { run } = await import('../src/cli/commands/engine.ts');
    let printed = '';
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { printed += s; return true; };
    try { await run(['swap', '--to', 'rust', '--plan', '--json']); } finally { (process.stdout as unknown as { write: typeof write }).write = write; }
    return JSON.parse(printed) as SwapPlan;
  }

  // Two real brains, built once: one healthy with a writer row, one whose evidence table is gone.
  let healthyHome = '';
  let brokenHome = '';
  const brainHomes: string[] = [];
  afterAll(() => { for (const h of brainHomes.splice(0)) rmSync(h, { recursive: true, force: true }); });
  beforeAll(async () => {
    for (const broken of [false, true]) {
      const h = mkdtempSync(join(tmpdir(), 'gbrain-swap-cli-'));
      brainHomes.push(h);
      mkdirSync(join(h, '.gbrain'), { recursive: true });
      const config = { engine: 'pglite' as const, database_path: join(h, 'brain.pglite') };
      writeFileSync(join(h, '.gbrain', 'config.json'), JSON.stringify(config));
      const brain = new PGLiteEngine();
      await brain.connect({ database_path: config.database_path });
      await brain.initSchema();
      await brain.executeRaw(`INSERT INTO engine_writer_observations (host_id, application_name, process_kind, gbrain_version) VALUES ('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:abcdef01', 'cli', 'test')`);
      if (broken) await brain.executeRaw('ALTER TABLE engine_writer_observations RENAME TO engine_writer_observations_moved');
      await brain.disconnect();
      if (broken) brokenHome = h; else healthyHome = h;
    }
  }, 120_000);

  /** Seeds a running shadow for the brain under `h` and prints criterion 11 as the production command reads it. */
  async function criterion11(h: string): Promise<string> {
    return withEnv({ GBRAIN_HOME: h, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const config = { engine: 'pglite' as const, database_path: join(h, 'brain.pglite') };
      const now = new Date();
      const dir = shadowDirFor(shadowBrainKey(config)!);
      writeShadowState(dir, STATE);
      writeSeedRecord(dir, { ...SEED, primary_engine: 'pglite' });
      writeFollowerFile(dir, follower(now, { ...NOT_RUN_PROBE, state: 'pass', checked_at: now.toISOString(), server_version: '16', collation: 'C' }));
      return (await cliPlan()).criteria.find(c => c.n === 11)!.state;
    });
  }

  test('it hands its open brain to the status document: criterion 11 reads the brain\'s own writer rows', async () => {
    // One host in the brain's own rows and no unknown path: the criterion is no longer "missing".
    expect(await criterion11(healthyHome)).toBe('pass');
  }, 120_000);

  test('a brain whose evidence table is broken leaves the writer fields out: criterion 11 is missing, never pass', async () => {
    expect(await criterion11(brokenHome)).toBe('missing');
  }, 120_000);
});
