/**
 * The shadow seed (src/shadow/seed.ts, `gbrain engine shadow seed`) from a real PGLite primary.
 *
 * Protects: a seeded Rust store answers the same reads as the primary it was seeded from (getPage, getLinks,
 * getTimeline, listFactsByEntity, searchKeyword); the seed never writes to the primary; `seed.json` names every
 * gap, the not-copied tables, the unfinished jobs and the segmented pages; a swap check refuses while a gap holds
 * a row; the command refuses a second seed, a running shadow mode and a locked store with the step to take.
 * Regression it catches: a read outside the snapshot, a dropped column of the pages read (its projection job),
 * a seed that writes to the brain, or a swap check that passes with gap rows left behind.
 * Not covered elsewhere: the Rust tests import hand-written rows; this file reads them from a real primary.
 *
 * The parity tests need the addon `bun run rust:build` writes and skip without it
 * (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error). Postgres: test/e2e/shadow-seed.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustStore, type SeedPlan, type SeedRow } from '../src/core/rust-engine/store.ts';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { validateCommandFlags } from '../src/cli/flag-validation.ts';
import { buildProvisionalReport, renderProvisionalMarkdown } from '../src/shadow/report.ts';
import {
  parseSeedBudgetMs, readSeedRecord, runSeed, SeedBudgetError, seedRecordPath, seedSwapCheck, writeSeedRecord, type SeedRecord, type SeedTarget,
} from '../src/shadow/seed.ts';
import {
  expectBudgetStopNamesTheWayOut, expectDefaultBudgetStop, expectFinishedSeed, expectRestartKeepsAStoreWithASeedRecord, expectRestartRefusesAHeldStore, expectRestartRefusesALinkedStore, inSeedHome, runRestartWatchingTheLockedStore, runSeedCommand,
  steppingClock, type SeedBudgetCase,
} from './helpers/shadow-seed-budget.ts';
import { countSeedGaps } from '../src/shadow/seed-gaps.ts';
import { shadowBrainKey, shadowDirFor, writeShadowState, SHADOW_STATE_VERSION } from '../src/shadow/state.ts';
import { withEnv } from './helpers/with-env.ts';
import { expectSeedReadParity, fillSeedFixture, insertSeedFixtureJobs, primaryDigests, seedInto } from './helpers/shadow-seed-fixture.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

let primary: PGLiteEngine;
let addon: RustAddon | undefined;
const dirs: string[] = [];

beforeAll(async () => {
  primary = new PGLiteEngine();
  await primary.connect({});
  await primary.initSchema();
});

afterAll(async () => {
  await primary.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(primary);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-seed-'));
  dirs.push(dir);
  return dir;
}

const fill = () => fillSeedFixture(primary);

async function seedHere(dir: string): Promise<{ record: SeedRecord; storePath: string }> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  return seedInto(primary, addon, dir, 'pglite');
}

describe('shadow seed from PGLite', () => {
  withAddon('the seeded store answers the same reads as the primary', async () => {
    await fill();
    const { record, storePath } = await seedHere(tempDir());
    expect(record.relations.pages?.imported).toBe(2);
    // pages.generation is a cache clock (the second page holds 2); the store recomputes it, so it is named, not kept.
    expect(record.relations.pages?.unmapped_columns).toEqual(['generation']);
    await expectSeedReadParity(primary, addon!, storePath);
  });

  withAddon('the seed never writes to the primary', async () => {
    await fill();
    await insertSeedFixtureJobs(primary);
    const before = await primaryDigests(primary);
    await seedHere(tempDir());
    expect(await primaryDigests(primary)).toEqual(before);
  });

  withAddon('seed.json counts the gaps, the not-copied rows, the unfinished jobs and the segmented pages', async () => {
    await fill();
    await insertSeedFixtureJobs(primary);
    const { record } = await seedHere(tempDir());
    const store = await openRustStore(addon!, join(tempDir(), 'plan-store'));
    let plan: SeedPlan;
    try { plan = await store.seedPlan(); } finally { await store.close(); }
    expect(record.unseeded_gap_rows).toEqual(await countSeedGaps(plan, (sql, params) => primary.executeRaw(sql, params)));
    expect(record.losses.gaps).toEqual(record.unseeded_gap_rows);
    expect(record.unseeded_gap_rows_total).toBe(Object.values(record.unseeded_gap_rows).reduce((a, b) => a + b, 0));
    expect(record.non_terminal_jobs).toBe(1);
    expect(record.losses.not_copied.find(n => n.table === 'minion_jobs')?.rows).toBe(2);
    expect(record.segmented_pages).toBe(0);
  });
});

/** A store that records what it was sent, for tests that need no addon. */
function fakeTarget(plan: SeedPlan): SeedTarget & { sent: Record<string, SeedRow[]>; close(): Promise<void> } {
  const sent: Record<string, SeedRow[]> = {};
  return {
    sent,
    async seedPlan() { return plan; },
    async importRelation(_seedId, relation, rows) {
      (sent[relation] ??= []).push(...rows);
      return { imported: rows.length, skipped: 0, dropped: 0, unmapped_columns: [], losses: {} };
    },
    async close() {},
  };
}

const PAGES_ONLY: SeedPlan = { relations: [{ relation: 'pages', key: ['id'], removable: true }], carried: [], not_copied: [], gap_columns: [] };

describe('shadow seed reads', () => {
  test('pages rows carry their projection job, read in key order across batches', async () => {
    await fill();
    await primary.executeRaw(
      `INSERT INTO page_projection_jobs (source_incarnation, slug, revision, reason, updated_at)
       SELECT s.incarnation, 'people/alice-example', gen_random_uuid(), 'test', '2026-01-02T03:04:05Z' FROM sources s WHERE s.id = 'default'
       ON CONFLICT (source_incarnation, slug) DO UPDATE SET reason = EXCLUDED.reason, updated_at = EXCLUDED.updated_at`);
    await primary.executeRaw(`DELETE FROM page_projection_jobs WHERE slug = 'companies/acme-example'`);
    const target = fakeTarget(PAGES_ONLY);
    await runSeed(primary, target, { primaryEngine: 'pglite', batchRows: 1 });
    const rows = target.sent.pages!;
    expect(rows.map(r => r.slug)).toEqual(['people/alice-example', 'companies/acme-example']);
    const alice = rows.find(r => r.slug === 'people/alice-example')!;
    expect(alice.projection_job_reason).toBe('test');
    expect(alice.projection_job_updated_at).toBe('2026-01-02 03:04:05+00');
    expect(rows.find(r => r.slug === 'companies/acme-example')!.projection_job_reason ?? null).toBeNull();
    expect('search_vector' in alice).toBe(false);
  });

  test('a seed past its budget stops with SeedBudgetError', async () => {
    await fill();
    let t = 0;
    const err = await runSeed(primary, fakeTarget(PAGES_ONLY), { primaryEngine: 'pglite', budgetMs: 10, now: () => new Date(t += 100) })
      .catch(e => e);
    expect(err).toBeInstanceOf(SeedBudgetError);
  });

  // Value: protects=the seed record adds up what every batch reports; fails_when=a later batch overwrites or drops an earlier batch's counts;
  // why_new=the other tests send one batch or a target that reports no loss; seam=none; no_claim=native decoding (the target is a recorder).
  test('seed.json adds up the losses, skips, drops and unmapped columns of every batch', async () => {
    await fill();
    let n = 0;
    const target: SeedTarget = {
      ...fakeTarget(PAGES_ONLY),
      async importRelation(_seedId, _relation, rows) {
        n += 1;
        return { imported: rows.length, skipped: 1, dropped: 2, unmapped_columns: n === 1 ? ['generation'] : ['generation', 'extra'], losses: (n === 1 ? { a: 1 } : { a: 2, b: 5 }) as Record<string, number> };
      },
    };
    const record = await runSeed(primary, target, { primaryEngine: 'pglite', batchRows: 1 });
    expect(n).toBe(2);
    expect(record.relations.pages).toEqual({ rows_read: 2, imported: 2, skipped: 2, dropped: 4, unmapped_columns: ['extra', 'generation'] });
    expect(record.losses.values).toEqual({ a: 3, b: 5 });
  });

  // Value: protects=seed.json names how many pages were left as shells; fails_when=the count is dropped or always 0;
  // why_new=every seed fixture has zero segmented pages and the report test types the count by hand; seam=none; no_claim=segmented text reconstruction (not copied by design).
  test('seed.json counts a segmented page', async () => {
    await fill();
    await primary.executeRaw(`UPDATE pages SET body_storage = 'segmented', compiled_truth = NULL, timeline = NULL, body_bytes = 0 WHERE slug = 'people/alice-example'`);
    const record = await runSeed(primary, fakeTarget(PAGES_ONLY), { primaryEngine: 'pglite' });
    expect(record.segmented_pages).toBe(1);
  });
});

describe('seedSwapCheck', () => {
  const base = (gaps: Record<string, number>): SeedRecord => ({
    version: 1, seed_id: 's1', started_at: 'a', finished_at: 'b', primary_engine: 'pglite', relations: {},
    losses: { values: {}, not_copied: [], gaps }, unseeded_gap_rows: gaps,
    unseeded_gap_rows_total: Object.values(gaps).reduce((a, b) => a + b, 0), non_terminal_jobs: 0, segmented_pages: 0,
  });
  test('refuses without a seed and while any gap holds a row', () => {
    expect(seedSwapCheck(null)).toMatchObject({ ok: false, code: 'not_seeded' });
    expect(seedSwapCheck(base({ loop_suppressions: 2, access_rules: 0 }))).toMatchObject({ ok: false, code: 'unseeded_gaps', gaps: { loop_suppressions: 2 } });
    expect(seedSwapCheck(base({ access_rules: 0 }))).toEqual({ ok: true, seed_id: 's1' });
  });
});

describe('gbrain engine shadow seed', () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  }
  const okAddon = async () => ({ ok: true as const, addon: {} as never });
  // `seed` opens the primary and closes it when done; the tests share one engine, so hand it over with a no-op disconnect.
  const keepOpen = (engine: PGLiteEngine): PGLiteEngine => Object.create(engine, { disconnect: { value: async () => {} } }) as PGLiteEngine;

  async function inHome<T>(fn: (dir: string, deps: Parameters<typeof runEngineShadow>[1]) => Promise<T>): Promise<T> {
    const home = tempDir();
    return withEnv({ GBRAIN_HOME: home }, () => {
      const config = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
      const dir = shadowDirFor(shadowBrainKey(config)!);
      return fn(dir, { config: () => config, loadAddon: okAddon, openPrimary: async () => keepOpen(primary), openStore: async () => fakeTarget(PAGES_ONLY) });
    });
  }

  test('seeds once, writes seed.json and status shows it; a second seed and --reseed name the new-directory step', async () => {
    await fill();
    // openPrimary hands over the shared test engine: keep it connected after the command.
    const keep = Object.create(primary, { disconnect: { value: async () => {} } }) as PGLiteEngine;
    await inHome(async (dir, deps) => {
      const first = capture();
      expect(await runEngineShadow(['seed'], { ...deps, ...first.deps, openPrimary: async () => keep })).toBe(0);
      const rec = readSeedRecord(dir)!;
      expect(rec.relations.pages?.imported).toBe(2);
      // The fake plan copies only pages, so every other table with rows is a gap the output names.
      expect(rec.unseeded_gap_rows.links).toBe(1);
      expect(first.out.join('\n')).toContain(`unseeded gap rows: ${rec.unseeded_gap_rows_total} (`);
      expect(first.out.join('\n')).toContain('links 1');
      const st = capture();
      expect(await runEngineShadow(['status', '--json'], { ...deps, ...st.deps })).toBe(0);
      expect(JSON.parse(st.out.join('\n')).seed).toEqual({ seed_id: rec.seed_id, finished_at: rec.finished_at, unseeded_gap_rows_total: rec.unseeded_gap_rows_total,
        storage: { managed: false, checked_at: rec.storage!.checked_at, note: null } });
      for (const args of [['seed'], ['seed', '--reseed']]) {
        const again = capture();
        expect(await runEngineShadow(args, { ...deps, ...again.deps, openPrimary: async () => keep })).toBe(1);
        expect(again.err.join('\n')).toContain('gbrain engine shadow stop --delete');
      }
    });
  });

  test('refuses while shadow mode is on, and maps a locked store to the same step', async () => {
    await inHome(async (dir, deps) => {
      writeShadowState(dir, { version: SHADOW_STATE_VERSION, enabled: true, started_at: 'x', sample_rate: 0.1, queue_bound: 1, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' });
      const on = capture();
      expect(await runEngineShadow(['seed'], { ...deps, ...on.deps })).toBe(1);
      expect(on.err.join('\n')).toContain('stop shadow mode first');
      writeShadowState(dir, { version: SHADOW_STATE_VERSION, enabled: false, started_at: 'x', sample_rate: 0.1, queue_bound: 1, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' });
      const locked = capture();
      const lockedStore = async () => { throw Object.assign(new Error('locked'), { code: 'rust_store_locked' }); };
      expect(await runEngineShadow(['seed'], { ...deps, ...locked.deps, openStore: lockedStore })).toBe(1);
      expect(locked.err.join('\n')).toContain('stop shadow mode first');
      expect(readSeedRecord(dir)).toBeNull();
    });
  });

  test('status --json has a null seed block before any seed', async () => {
    await inHome(async (_dir, deps) => {
      const st = capture();
      expect(await runEngineShadow(['status', '--json'], { ...deps, ...st.deps })).toBe(0);
      expect(JSON.parse(st.out.join('\n')).seed).toEqual({ seed_id: null, finished_at: null, unseeded_gap_rows_total: null, storage: null });
    });
  });

  test('the provisional report names the seed, its age, the segmented pages and the gap rows', () => {
    const dir = tempDir();
    const before = buildProvisionalReport(dir, 'b', null, new Date('2026-11-21T00:00:00Z'));
    expect(before.seed).toBeNull();
    expect(before.why_not_ready.join(' ')).toContain('run gbrain engine shadow seed');
    expect(renderProvisionalMarkdown(before)).toContain('Seed: none');
    writeSeedRecord(dir, { version: 1, seed_id: 'seed-x', started_at: '2026-11-20T00:00:00.000Z', finished_at: '2026-11-20T12:00:00.000Z', primary_engine: 'postgres', relations: {},
      losses: { values: {}, not_copied: [], gaps: { access_rules: 3, loop_suppressions: 0 } }, unseeded_gap_rows: { access_rules: 3, loop_suppressions: 0 },
      unseeded_gap_rows_total: 3, non_terminal_jobs: 2, segmented_pages: 5 });
    const after = buildProvisionalReport(dir, 'b', null, new Date('2026-11-21T00:00:00Z'));
    expect(after.verdict).toBe('NOT READY');
    expect(after.seed).toEqual({ seed_id: 'seed-x', finished_at: '2026-11-20T12:00:00.000Z', age_hours: 12, segmented_pages: 5,
      non_terminal_jobs: 2, storage: null, unseeded_gap_rows_total: 3, unseeded_gap_rows: { access_rules: 3 } });
    expect(after.why_not_ready.join(' ')).toContain('3 rows of the brain have no Rust home yet');
    expect(renderProvisionalMarkdown(after)).toContain('Seed: seed-x, finished 2026-11-20T12:00:00.000Z (12 hours ago). Segmented pages read as shells: 5. Unfinished jobs not copied: 2. Unseeded gap rows: 3 (access_rules 3).');
  });

  test('writeSeedRecord and readSeedRecord round-trip', () => {
    const dir = tempDir();
    expect(readSeedRecord(dir)).toBeNull();
    const rec = { version: 1, seed_id: 's', started_at: 'a', finished_at: 'b', primary_engine: 'pglite', relations: {}, losses: { values: {}, not_copied: [], gaps: {} }, unseeded_gap_rows: {}, unseeded_gap_rows_total: 0, non_terminal_jobs: 0, segmented_pages: 0 } as SeedRecord;
    writeSeedRecord(dir, rec);
    expect(readSeedRecord(dir)).toEqual(rec);
  });

  // Value: protects=seed.json is owner-only (0600) and a damaged or newer file reads as no seed; fails_when=the mode is dropped or widened, or a bad file throws or is accepted;
  // why_new=the round-trip test checks content only; seam=none; no_claim=crash-time atomicity of the rename.
  test('seed.json is written owner-only and a damaged or newer file reads as unseeded', () => {
    const dir = tempDir();
    const rec = { version: 1, seed_id: 's', started_at: 'a', finished_at: 'b', primary_engine: 'pglite', relations: {}, losses: { values: {}, not_copied: [], gaps: {} }, unseeded_gap_rows: {}, unseeded_gap_rows_total: 0, non_terminal_jobs: 0, segmented_pages: 0 } as SeedRecord;
    const old = process.umask(0o000);
    try { writeSeedRecord(dir, rec); } finally { process.umask(old); }
    expect(statSync(seedRecordPath(dir)).mode & 0o777).toBe(0o600);
    writeFileSync(seedRecordPath(dir), '{ not json');
    expect(readSeedRecord(dir)).toBeNull();
    writeFileSync(seedRecordPath(dir), JSON.stringify({ ...rec, version: 2 }));
    expect(readSeedRecord(dir)).toBeNull();
    writeFileSync(seedRecordPath(dir), JSON.stringify({ ...rec, seed_id: 7 }));
    expect(readSeedRecord(dir)).toBeNull();
    const unseeded = buildProvisionalReport(dir, 'b', null, new Date('2026-11-21T00:00:00Z'));
    expect(unseeded.seed).toBeNull();
  });
});

// Value: protects=a seed past 30 minutes can be given more time, and a stopped seed has a one-command way back
// (--restart) instead of a store every rerun refuses; fails_when=the budget flag or env var is ignored, --restart is
// missing or deletes a store another process holds, or the stop text names no way out; why_new=the older tests only
// prove runSeed throws past a budget; seam=the command's clock (deps.now), already a production seam;
// no_claim=a real multi-hour snapshot on a pooler (the Postgres twin and the PR's pooler run cover that).
describe('gbrain engine shadow seed budget and restart', () => {
  const kase = async (): Promise<SeedBudgetCase> => {
    addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    const home = tempDir();
    return { primary, addon, home, config: { engine: 'pglite', database_path: join(home, 'brain.pglite') } };
  };

  withAddon('a seed past the default budget stops; --restart with a raised budget clears the partial store and finishes', async () => {
    await fill();
    const c = await kase();
    await inSeedHome(c, {}, async dir => {
      const stopped = await expectDefaultBudgetStop(c, dir);
      expectBudgetStopNamesTheWayOut(stopped);
      const restarted = await runSeedCommand(c, ['seed', '--restart', '--budget-minutes', '0'], { now: steppingClock() });
      expect(restarted.err).toContain('--restart deleted the partial Rust store');
      await expectFinishedSeed(c, dir, restarted);
      // A finished seed is never cleared by --restart.
      const again = await runSeedCommand(c, ['seed', '--restart'], { now: steppingClock() });
      expect(again.code).toBe(1);
      expect(again.err).toContain('this seed finished');
      expect(again.err).toContain('gbrain engine shadow stop --delete');
      await expectSeedReadParity(primary, addon!, join(dir, 'store'));
    });
  });

  withAddon('--budget-minutes and GBRAIN_SHADOW_SEED_BUDGET_MINUTES let the same seed finish', async () => {
    await fill();
    for (const [args, env] of [
      [['seed', '--budget-minutes', 'none'], {}],
      [['seed', '--budget-minutes', '100000'], {}],
      [['seed'], { GBRAIN_SHADOW_SEED_BUDGET_MINUTES: '0' }],
      [['seed', '--budget-minutes', '0'], { GBRAIN_SHADOW_SEED_BUDGET_MINUTES: 'not-a-number' }],
    ] as Array<[string[], Record<string, string>]>) {
      const c = await kase();
      await inSeedHome(c, env, async dir => {
        await expectFinishedSeed(c, dir, await runSeedCommand(c, args, { now: steppingClock() }));
      });
    }
  });

  withAddon('a too-small budget from the env var still stops the seed and names the restart', async () => {
    await fill();
    const c = await kase();
    await inSeedHome(c, { GBRAIN_SHADOW_SEED_BUDGET_MINUTES: '15' }, async dir => {
      const stopped = await runSeedCommand(c, ['seed'], { now: steppingClock() });
      expect(stopped.code).toBe(1);
      expect(stopped.err).toContain('ran past its 15-minute budget');
      expectBudgetStopNamesTheWayOut(stopped);
      expect(readSeedRecord(dir)).toBeNull();
    });
  });

  withAddon('--restart refuses a store another process holds and leaves it in place; once free, it reseeds', async () => {
    await fill();
    const c = await kase();
    await inSeedHome(c, {}, async dir => {
      await expectDefaultBudgetStop(c, dir);
      await expectRestartRefusesAHeldStore(c, dir);
      await expectRestartKeepsAStoreWithASeedRecord(c, dir);
      await expectRestartRefusesALinkedStore(c, dir);
      await expectFinishedSeed(c, dir, await runRestartWatchingTheLockedStore(c, dir));
    });
  });

  withAddon('--restart with no store yet just seeds', async () => {
    await fill();
    const c = await kase();
    await inSeedHome(c, {}, async dir => {
      await expectFinishedSeed(c, dir, await runSeedCommand(c, ['seed', '--restart']));
    });
  });

  test('--batch-rows sets the rows per batch, and the start line names the budget and batch size', async () => {
    await fill();
    const home = tempDir();
    const c: SeedBudgetCase = { primary, addon: {} as RustAddon, home, config: { engine: 'pglite', database_path: join(home, 'brain.pglite') } };
    await inSeedHome(c, {}, async () => {
      const run = await runSeedCommand(c, ['seed', '--batch-rows', '1', '--budget-minutes', '90'], { openStore: async () => fakeTarget(PAGES_ONLY) });
      expect(run.code).toBe(0);
      expect(run.err).toContain('seeding with a 90-minute budget and 1 rows per batch');
      expect(run.err).toContain('  seeding pages: 1 rows');
      expect(run.err).toContain('  seeding pages: 2 rows');
    });
  });

  test('a bad --budget-minutes, --batch-rows or env value is a usage error that writes nothing', async () => {
    const home = tempDir();
    const c: SeedBudgetCase = { primary, addon: {} as RustAddon, home, config: { engine: 'pglite', database_path: join(home, 'brain.pglite') } };
    let opened = 0;
    const openStore = async () => { opened++; return fakeTarget(PAGES_ONLY); };
    for (const [args, env] of [
      [['seed', '--budget-minutes', '-5'], {}],
      [['seed', '--budget-minutes', 'soon'], {}],
      [['seed', '--budget-minutes'], {}],
      [['seed', '--batch-rows', '0'], {}],
      [['seed', '--batch-rows', '1.5'], {}],
      [['seed', '--batch-rows', '10001'], {}],
      [['seed'], { GBRAIN_SHADOW_SEED_BUDGET_MINUTES: 'forever' }],
    ] as Array<[string[], Record<string, string>]>) {
      await inSeedHome(c, env, async dir => {
        const run = await runSeedCommand(c, args, { openStore });
        expect(run.code).toBe(2);
        expect(run.err).toMatch(/--budget-minutes|--batch-rows|GBRAIN_SHADOW_SEED_BUDGET_MINUTES/);
        expect(existsSync(dir)).toBe(false);
      });
    }
    expect(opened).toBe(0);
  });

  test('the gbrain entry point accepts the seed flags (strict unknown-flag check)', () => {
    for (const flag of [['--restart'], ['--budget-minutes', 'none'], ['--batch-rows', '5']]) {
      expect(validateCommandFlags('engine', ['shadow', 'seed', ...flag])).toBeNull();
    }
  });

  test('help names the seed flags', async () => {
    const out: string[] = [];
    expect(await runEngineShadow(['seed', '--help'], { out: l => out.push(l), err: () => undefined })).toBe(0);
    const help = out.join('\n');
    expect(help).toContain('gbrain engine shadow seed [--json] [--budget-minutes <n|none>] [--batch-rows <n>] [--restart]');
    expect(help).toContain('GBRAIN_SHADOW_SEED_BUDGET_MINUTES');
  });

  test('runSeed with no budget (null) ignores the clock; the budget text reads in minutes', async () => {
    await fill();
    let t = 0;
    const record = await runSeed(primary, fakeTarget(PAGES_ONLY), { primaryEngine: 'pglite', budgetMs: null, now: () => new Date(t += 3_600_000) });
    expect(record.relations.pages?.imported).toBe(2);
    expect(new SeedBudgetError('pages', 90_000).message).toContain('ran past its 1.5-minute budget while copying pages');
    expect(parseSeedBudgetMs('0')).toBeNull();
    expect(parseSeedBudgetMs(' None ')).toBeNull();
    expect(parseSeedBudgetMs('120')).toBe(7_200_000);
    expect(parseSeedBudgetMs('0.5')).toBe(30_000);
    for (const bad of ['', '-1', '1e3', 'Infinity', '12m', '0x10']) expect(parseSeedBudgetMs(bad)).toBeUndefined();
  });
});
