/**
 * #5495: extract_health reports WHY rounds halted.
 *
 * Protects: migration v239 adds `extract_rollup_7d.halt_reasons JSONB NOT
 * NULL DEFAULT '{}'` as DDL only (no backfill statement in the file);
 * `classifyRunStop` keeps its three-way split (a cap is an expected stop,
 * never a halt or a halt reason) and carries a named reason only when the
 * caller classified the error; `upsertExtractRollup` increments the reason in
 * the same UPSERT with bound parameters; halts written before the column,
 * by an older writer or unclassified read as `unknown` =
 * halt_count - sum(halt_reasons), so reason totals never exceed halt_count
 * with old and new writers on one day; doctor names the top reason; a brain
 * whose schema is behind keeps extracting and loses rollup rows with one
 * stderr line naming the migration fix, never a throw; extract_atoms records
 * a credentials abort as provider_auth and extract_facts' fence guard as
 * integrity_guard.
 * Fails when: the migration backfills, a cap becomes a halt reason, reasons
 * are JSON-stringified into the jsonb, unknown is stored instead of
 * computed, or the doctor ignores the column.
 * PGLite always; Postgres when DATABASE_URL is set
 * (test/e2e/extract-rollup-halt-reasons-5495-postgres.test.ts; the PgBouncer
 * matrix pass runs that file too).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { classifyRunStop, haltReasonsWithUnknown, HALT_REASONS, providerHaltReason, topHaltReason, upsertExtractRollup } from '../src/core/extract/rollup-writer.ts';
import { computeExtractHealthCheck } from '../src/commands/doctor/checks/extraction-sync.ts';
import { v239 } from '../src/core/schema-migrations/v239-extract-rollup-halt-reasons.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { runPhaseWithStoredPageFixtures as runPhaseExtractAtoms } from './helpers/extract-atoms-page-fixtures.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

const TODAY = new Date().toISOString().slice(0, 10);
let kindSeq = 0;
const freshKind = () => `probe.${++kindSeq}`;

/** An older binary's rollup statement: no halt_reasons column named, halts land in halt_count only. */
async function oldWriterUpsert(engine: BrainEngine, kind: string, halts: number): Promise<void> {
  await engine.executeRaw(`INSERT INTO extract_rollup_7d (kind, source_id, day, cost_usd, halt_count, eval_fail_count, eval_pass_count,
      round_completed_count, expected_limit_count, rollup_write_failures, updated_at)
    VALUES ($1, 'default', $2::date, 0, $3, 0, 0, 0, 0, 0, now())
    ON CONFLICT (kind, source_id, day) DO UPDATE SET halt_count = extract_rollup_7d.halt_count + EXCLUDED.halt_count, updated_at = now()`, [kind, TODAY, halts]);
}

async function rollupRow(engine: BrainEngine, kind: string) {
  const [row] = await engine.executeRaw<{ halt_count: number; round_completed_count: number; expected_limit_count: number; halt_reasons: Record<string, number> | string }>(
    `SELECT halt_count, round_completed_count, expected_limit_count, halt_reasons FROM extract_rollup_7d WHERE kind=$1 AND source_id='default' AND day=$2::date`, [kind, TODAY]);
  const reasons = typeof row!.halt_reasons === 'string' ? JSON.parse(row!.halt_reasons) : row!.halt_reasons;
  return { ...row!, halt_reasons: reasons as Record<string, number> };
}

async function doctorKind(engine: BrainEngine, kind: string) {
  const check = await computeExtractHealthCheck(engine);
  const kinds = (check.details as { kinds: Array<{ kind: string; halt_count: number; halt_reasons: Record<string, number>; top_halt_reason: string | null }> }).kinds;
  return { check, kind: kinds.find(k => k.kind === kind)! };
}

describe('classifyRunStop keeps its three-way split and names a reason only when given one (#5495)', () => {
  test('a cap is an expected stop, never a halt reason', () => {
    expect(classifyRunStop({ budget_exhausted: true })).toEqual({ round_completed_delta: 0, halt_delta: 0, expected_limit_delta: 1 });
    expect(classifyRunStop({ deadline_hit: true })).toEqual({ round_completed_delta: 0, halt_delta: 0, expected_limit_delta: 1 });
    expect((HALT_REASONS as readonly string[]).includes('budget_cap')).toBe(false);
    expect((HALT_REASONS as readonly string[]).includes('unknown')).toBe(false);
  });
  test('an unclassified error halts without a reason; a classified one carries it, a cap alongside it stays an error', () => {
    expect(classifyRunStop({ error: true })).toEqual({ round_completed_delta: 0, halt_delta: 1, expected_limit_delta: 0 });
    expect(classifyRunStop({ error: 'item_error' })).toEqual({ round_completed_delta: 0, halt_delta: 1, expected_limit_delta: 0, halt_reason: 'item_error' });
    expect(classifyRunStop({ budget_exhausted: true, error: 'provider_auth' })).toEqual({ round_completed_delta: 0, halt_delta: 1, expected_limit_delta: 0, halt_reason: 'provider_auth' });
    expect(classifyRunStop({ error: false })).toEqual({ round_completed_delta: 1, halt_delta: 0, expected_limit_delta: 0 });
  });
  test('provider classes map onto the closed vocabulary; unknown reads as the remainder', () => {
    expect(['auth', 'billing', 'rate_limit', 'model_not_found'].map(c => providerHaltReason(c as 'auth'))).toEqual(['provider_auth', 'provider_billing', 'provider_rate_limit', 'provider_model_not_found']);
    expect(providerHaltReason(null)).toBeNull();
    expect(haltReasonsWithUnknown(5, { provider_auth: 2, item_error: 1 })).toEqual({ provider_auth: 2, item_error: 1, unknown: 2 });
    expect(haltReasonsWithUnknown(0, {})).toEqual({});
    expect(topHaltReason({ provider_auth: 2, item_error: 1, unknown: 2 })).toEqual({ reason: 'provider_auth', count: 2 });
    expect(topHaltReason({})).toBeNull();
  });
});

test('migration v239 is additive DDL only: no backfill statement, idempotent, default {}', () => {
  expect(MIGRATIONS.find(m => m.name === 'extract_rollup_halt_reasons')?.version).toBe(239);
  expect(v239.idempotent).toBe(true);
  expect(v239.sql).toMatch(/ADD COLUMN IF NOT EXISTS halt_reasons JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  expect(v239.sql).not.toMatch(/\bUPDATE\b|\bbackfill\b|jsonb_build_object/i);
  expect(v239.sql.trim().split(';').filter(Boolean)).toHaveLength(1);
});

test('the column exists with its default on every engine, and a reason-less row reads as unknown', async () => {
  for (const engine of engines) {
    const [column] = await engine.executeRaw<{ data_type: string; column_default: string; is_nullable: string }>(
      `SELECT data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name='extract_rollup_7d' AND column_name='halt_reasons'`);
    expect(column).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' });
    expect(column!.column_default).toContain("'{}'::jsonb");
    const kind = freshKind();
    await oldWriterUpsert(engine, kind, 3);
    expect((await rollupRow(engine, kind)).halt_reasons).toEqual({});
    const { kind: read } = await doctorKind(engine, kind);
    expect(read).toMatchObject({ halt_count: 3, halt_reasons: { unknown: 3 }, top_halt_reason: 'unknown' });
  }
}, 120_000);

test('reasons increment in the same UPSERT; old and new writers on one day keep sum(reasons) <= halt_count; doctor names the top reason', async () => {
  for (const engine of engines) {
    const kind = freshKind();
    for (const _ of [1, 2]) expect(await upsertExtractRollup(engine, { kind, source_id: 'default', ...classifyRunStop({ error: 'provider_auth' }) })).toEqual({ ok: true });
    expect(await upsertExtractRollup(engine, { kind, source_id: 'default', ...classifyRunStop({ error: 'item_error' }) })).toEqual({ ok: true });
    expect(await upsertExtractRollup(engine, { kind, source_id: 'default', ...classifyRunStop({ error: true }) })).toEqual({ ok: true });
    expect(await upsertExtractRollup(engine, { kind, source_id: 'default', ...classifyRunStop({ budget_exhausted: true }) })).toEqual({ ok: true });
    // A reason on a non-halt event is ignored: nothing is counted under it.
    expect(await upsertExtractRollup(engine, { kind, source_id: 'default', halt_reason: 'item_error', ...classifyRunStop({}) })).toEqual({ ok: true });
    await oldWriterUpsert(engine, kind, 1);
    const row = await rollupRow(engine, kind);
    expect(row).toMatchObject({ halt_count: 5, round_completed_count: 1, expected_limit_count: 1, halt_reasons: { provider_auth: 2, item_error: 1 } });
    expect(Object.values(row.halt_reasons).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(row.halt_count);
    const { check, kind: read } = await doctorKind(engine, kind);
    expect(read).toMatchObject({ halt_count: 5, halt_reasons: { provider_auth: 2, item_error: 1, unknown: 2 }, top_halt_reason: 'provider_auth' });
    expect(check.status).toBe('warn');
    expect(check.message).toContain(`${kind}=71.4%`);
    expect(check.message).toContain('(top reason: provider_auth ×2)');

    // Concurrent old and new writers on the same (kind, day): the UPSERT is atomic per row.
    const racy = freshKind();
    await Promise.all([
      ...Array.from({ length: 10 }, () => upsertExtractRollup(engine, { kind: racy, source_id: 'default', ...classifyRunStop({ error: 'item_error' }) })),
      ...Array.from({ length: 10 }, () => oldWriterUpsert(engine, racy, 1)),
    ]);
    const raced = await rollupRow(engine, racy);
    expect(raced).toMatchObject({ halt_count: 20, halt_reasons: { item_error: 10 } });
    expect((await doctorKind(engine, racy)).kind.halt_reasons).toEqual({ item_error: 10, unknown: 10 });
  }
}, 120_000);

test('a brain whose schema is behind v239 keeps extracting: the rollup write returns ok:false with one stderr line naming the migration fix, and never throws', async () => {
  for (const engine of engines) {
    const kind = freshKind();
    await engine.executeRaw('ALTER TABLE extract_rollup_7d DROP COLUMN halt_reasons');
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      const first = await upsertExtractRollup(engine, { kind, source_id: 'default', ...classifyRunStop({ error: 'item_error' }) });
      const second = await upsertExtractRollup(engine, { kind, source_id: 'default', ...classifyRunStop({}) });
      expect(first.ok).toBe(false);
      expect(second.ok).toBe(false);
      expect(first.error).toMatch(/halt_reasons/);
    } finally { console.error = error; }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('migrations_pending');
    expect(lines[0]).toContain('gbrain apply-migrations --yes --no-autopilot-install');
    expect(await engine.executeRaw('SELECT 1 FROM extract_rollup_7d WHERE kind=$1', [kind])).toEqual([]);
    // The doctor read still works without the column: every halt is unknown.
    const seen = freshKind();
    await oldWriterUpsert(engine, seen, 2);
    expect((await doctorKind(engine, seen)).kind).toMatchObject({ halt_count: 2, halt_reasons: { unknown: 2 } });
    await engine.executeRaw(v239.sql);
    expect((await rollupRow(engine, seen)).halt_reasons).toEqual({});
  }
}, 120_000);

test('extract_atoms records a credentials abort as provider_auth; extract_facts records its fence guard as integrity_guard', async () => {
  const engine = engines.find(e => e.kind === 'pglite');
  if (!engine) return;
  for (const slug of ['note/auth-1', 'note/auth-2']) await engine.putPage(slug, { title: slug, type: 'note', compiled_truth: 'seed body prose' } as never, { sourceId: 'default' });
  await runPhaseExtractAtoms(engine as PGLiteEngine, {
    sourceId: 'default', _transcripts: [],
    _pages: ['note/auth-1', 'note/auth-2'].map((slug, i) => ({ slug, content: 'prose', contentHash: String(i).repeat(16) })),
    _chat: async () => { throw Object.assign(new Error('invalid x-api-key'), { status: 401 }); },
  });
  expect(await rollupRow(engine, 'atoms')).toMatchObject({ halt_count: 1, halt_reasons: { provider_auth: 1 } });

  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const stub = {
    async executeRaw(sql: string, params: unknown[] = []) {
      calls.push({ sql: sql.replace(/\s+/g, ' '), params });
      if (/COUNT\(\*\) AS n/.test(sql)) return [{ n: '3' }];
      if (sql.includes('FROM persistence_brain')) return [{ enabled: false }];
      return [];
    },
    async getAllSlugs() { return []; }, async getPage() { return null; },
    async deleteFactsForPage() { return { deleted: 0 }; }, async insertFacts() { return { inserted: 0, ids: [], warnings: [], deleted: 0 }; },
    async transaction<T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> { return fn(stub); },
  } as unknown as BrainEngine;
  expect((await runExtractFacts(stub, { slugs: [], sourceId: 'default' })).guardTriggered).toBe(true);
  const rollups = calls.filter(c => c.sql.includes('INSERT INTO extract_rollup_7d'));
  expect(rollups).toHaveLength(1);
  expect(rollups[0]!.params[4]).toBe(1);
  expect(rollups[0]!.params[10]).toBe('integrity_guard');
  expect(rollups[0]!.sql).not.toContain('JSON.stringify');
}, 120_000);
