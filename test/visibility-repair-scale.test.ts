/**
 * GBRA-159: gbrain repair visibility on a large brain. The preview plans one
 * class at a time, remotely readable facts first; facts, chronicle events and
 * alias-only pages never read concept-provenance links; it lists one bounded
 * window whose --apply --expect <hash> applies exactly that window (resumable);
 * a class over the statement bound is skipped and reported; doctor's fact count
 * comes first. Synthetic data only. PGLite + Postgres.
 */
import * as factsRepairSql from '../src/core/engine-sql/facts-repair.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveRepairScope, runRepair, type RepairResult } from '../src/core/repair/core.ts';
import { visibilityRepair } from '../src/core/repair/visibility.ts';
import { derivedVisibilityCheck } from '../src/commands/doctor/checks/derived-visibility.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const home = mkdtempSync(join(tmpdir(), 'gbrain-visibility-scale-'));

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

const ctx = (engine: BrainEngine) => ({ engine, config: { engine: engine.kind, embedding_disabled: true },
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'default' }) as never;

async function reset(engine: BrainEngine) {
  for (const sql of ['DELETE FROM links', 'DELETE FROM facts', 'DELETE FROM content_chunks', 'DELETE FROM pages', "DELETE FROM op_checkpoints WHERE op IN ('repair','repair-approval')"]) await engine.executeRaw(sql);
}

/**
 * The shape of a large brain: `origins` meeting pages (every 5th explicitly private, every 7th private by an alias),
 * atoms extracted from them, synthesized concepts with provenance links to three of every four members, chronicle
 * events, alias-only notes, world facts extracted from the meetings (half held on a world entity page, so remotely
 * readable when the meeting is private) and plain filler pages. Inserted set-based in chunks, page triggers off.
 */
async function seedShape(engine: BrainEngine, n: { origins: number; atoms: number; concepts: number; events: number; aliased: number; facts: number; filler: number }) {
  const chunked = async (count: number, sql: (lo: number, hi: number) => string) => {
    for (let lo = 1; lo <= count; lo += 5000) await engine.executeRaw(sql(lo, Math.min(count, lo + 4999)));
  };
  await engine.executeRaw('ALTER TABLE pages DISABLE TRIGGER USER');
  try {
    await chunked(n.filler, (lo, hi) => "INSERT INTO pages (source_id,slug,type,title,compiled_truth,frontmatter) SELECT 'default','notes/filler-'||g,'note','f'||g,'filler','{}'::jsonb FROM generate_series(" + lo + ',' + hi + ') g');
    await chunked(n.origins, (lo, hi) => "INSERT INTO pages (source_id,slug,type,title,compiled_truth,frontmatter) SELECT 'default','meetings/m-'||g,'meeting','m'||g,'meeting body',"
      + "CASE WHEN g%5=0 THEN '{\"visibility\":\"private\"}'::jsonb WHEN g%7=0 THEN '{\"access\":\"private\"}'::jsonb ELSE '{}'::jsonb END FROM generate_series(" + lo + ',' + hi + ') g');
    await engine.executeRaw("INSERT INTO pages (source_id,slug,type,title,compiled_truth,frontmatter) VALUES ('default','people/alice-example','person','Alice','entity','{}'::jsonb)");
    await chunked(n.atoms, (lo, hi) => "INSERT INTO pages (source_id,slug,type,title,compiled_truth,frontmatter) SELECT 'default','atoms/a-'||g,'atom','a'||g,'atom body',"
      + "jsonb_build_object('source_slug','meetings/m-'||(1+g%" + n.origins + "),'concepts',jsonb_build_array('concepts/c-'||(1+g%" + n.concepts + ")))"
      + " || CASE WHEN g%3=0 THEN '{\"visibility\":\"world\"}'::jsonb ELSE '{}'::jsonb END FROM generate_series(" + lo + ',' + hi + ') g');
    await chunked(n.concepts, (lo, hi) => "INSERT INTO pages (source_id,slug,type,title,compiled_truth,frontmatter) SELECT 'default','concepts/c-'||g,'concept','c'||g,'concept body',"
      + "jsonb_build_object('synthesized_by','synthesize_concepts-v1') || CASE WHEN g%2=0 THEN '{\"visibility\":\"world\"}'::jsonb ELSE '{}'::jsonb END FROM generate_series(" + lo + ',' + hi + ') g');
    await chunked(n.events, (lo, hi) => "INSERT INTO pages (source_id,slug,type,title,compiled_truth,frontmatter) SELECT 'default','events/e-'||g,'event','e'||g,'event body',"
      + "jsonb_build_object('captured_via','life-chronicle:auto','event',jsonb_build_object('depth','meetings/m-'||(1+g%" + n.origins + "))) FROM generate_series(" + lo + ',' + hi + ') g');
    await chunked(n.aliased, (lo, hi) => "INSERT INTO pages (source_id,slug,type,title,compiled_truth,frontmatter) SELECT 'default','notes/n-'||g,'note','n'||g,'note body',"
      + "CASE WHEN g%2=0 THEN '{\"access\":\"private\"}'::jsonb ELSE '{\"confidentiality\":\"internal\"}'::jsonb END FROM generate_series(" + lo + ',' + hi + ') g');
  } finally { await engine.executeRaw('ALTER TABLE pages ENABLE TRIGGER USER'); }
  await engine.executeRaw("INSERT INTO links (from_page_id,to_page_id,link_type,link_source) SELECT c.id,a.id,'synthesized_from','concept-provenance' FROM pages c "
    + "JOIN pages a ON a.type='atom' AND a.frontmatter->'concepts'->>0 = c.slug WHERE c.type='concept' AND a.id%4<>0");
  await chunked(n.facts, (lo, hi) => "INSERT INTO facts (source_id,fact,visibility,source,source_markdown_slug,source_session) SELECT 'default','fact '||g,'world','mcp:put_page',"
    + "CASE WHEN g%2=0 THEN 'people/alice-example' ELSE 'meetings/m-'||(1+g%" + n.origins + ") END,'put_page:meetings/m-'||(1+g%" + n.origins + ") FROM generate_series(" + lo + ',' + hi + ') g');
  await engine.executeRaw('ANALYZE');
}

/** The engine with every statement recorded, and `fail` choosing statements to end with a statement timeout. */
const typedReads = { listConceptLineageRows: factsRepairSql.listConceptLineageRows, listConceptInputRows: factsRepairSql.listConceptInputRows, listNamedVisibilityRows: factsRepairSql.listNamedVisibilityRows };
function recording(engine: BrainEngine, fail?: (sql: string) => boolean) {
  const statements: string[] = [];
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[], opts?: never) => {
      statements.push(sql);
      if (fail?.(sql)) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      return target.executeRaw(sql, params, opts);
    };
    // The plan's page and link reads are typed members now: run each member's own SQL text through this recording executeRaw.
    if (typeof key === 'string' && key in typedReads) return (...args: unknown[]) =>
      (typedReads as Record<string, (raw: typeof target.executeRaw, ...a: unknown[]) => unknown>)[key]!((sql, params, opts) => (proxy as BrainEngine).executeRaw(sql, params, opts), ...args);
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { engine: proxy as BrainEngine, statements, readsLinks: () => statements.some(sql => /\blinks\b/.test(sql)) };
}

/** The engine with one typed member failing on the statement timeout, as `recording` fails a raw statement. */
function timingOut(engine: BrainEngine, member: keyof BrainEngine): BrainEngine {
  return new Proxy(engine, { get(target, key) {
    if (key === member) return async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

const SMALL = { origins: 50, atoms: 120, concepts: 6, events: 30, aliased: 10, facts: 40, filler: 0 };
const privateFacts = (engine: BrainEngine) => engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE visibility='private' ORDER BY id");
const preview = (engine: BrainEngine, opts: { driftClass?: string; limit?: number } = {}) =>
  withEnv({ GBRAIN_HOME: home }, async () => runRepair(ctx(engine), visibilityRepair, await resolveRepairScope(engine), { apply: false, ...opts }));
const apply = (engine: BrainEngine, expect: string, opts: { driftClass?: string; limit?: number } = {}) =>
  withEnv({ GBRAIN_HOME: home }, async () => runRepair(ctx(engine), visibilityRepair, await resolveRepairScope(engine), { apply: true, expect, ...opts }));

describe('GBRA-159 visibility repair plans by class, facts first, without links for facts and events', () => {
  test('facts, events and aliases never read links; the default window fills from remotely readable facts first', async () => {
    for (const engine of engines) {
      await reset(engine);
      await seedShape(engine, SMALL);
      for (const cls of ['facts', 'events', 'aliases']) {
        const rec = recording(engine);
        const result = await preview(rec.engine, { driftClass: cls });
        expect(result.affected).toBeGreaterThan(0);
        expect(rec.readsLinks()).toBe(false);
        expect(result.apply_command).toContain(` --class ${cls} --apply --expect ${result.preview_hash}`);
      }
      const rec = recording(engine);
      const window = await preview(rec.engine, { limit: 5 });
      expect(rec.readsLinks()).toBe(false);
      expect(window.affected).toBe(5);
      expect(window.listing!.every(entry => entry.class === 'facts' && entry.detail!.endsWith('(remotely readable now)'))).toBe(true);
      expect(window.details).toMatchObject({ window: { size: 5, listed: 5, not_read: ['events', 'aliases', 'lineage'] } });
      expect(window.warnings!.join(' ')).toContain('Apply this window (or decide not to), then preview again for the next one: gbrain repair visibility');
      const lineage = await preview(engine, { driftClass: 'lineage' });
      expect(lineage.listing!.every(entry => entry.class === 'lineage')).toBe(true);
      expect(lineage.affected).toBeGreaterThan(0);
    }
  }, 120_000);

  test('--apply --expect applies exactly the previewed window, resumes after a stop, and refuses a spent or other-class hash', async () => {
    for (const engine of engines) {
      await reset(engine);
      await seedShape(engine, SMALL);
      const before = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE visibility='world'");
      const window = await preview(engine, { driftClass: 'facts', limit: 3 });
      const listed = window.listing!.map(entry => Number(/^fact (\d+) /.exec(entry.detail!)![1]));
      expect(listed).toHaveLength(3);
      const first: RepairResult = await apply(engine, window.preview_hash!, { driftClass: 'facts', limit: 1 });
      expect(first).toMatchObject({ applied: 1, complete: false });
      expect((await privateFacts(engine)).map(row => Number(row.id))).toEqual(listed.slice(0, 1));
      const rest = await apply(engine, window.preview_hash!, { driftClass: 'facts' });
      expect(rest).toMatchObject({ applied: 2, complete: true, resumed_from: { phase: 0, id: 0 } });
      expect((await privateFacts(engine)).map(row => Number(row.id))).toEqual(listed);
      const after = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE visibility='world'");
      expect(after[0]!.n).toBe(before[0]!.n - 3);
      await expect(apply(engine, window.preview_hash!, { driftClass: 'facts' })).rejects.toThrow(/preview changed/i);
      const events = await preview(engine, { driftClass: 'events', limit: 2 });
      await expect(apply(engine, events.preview_hash!, { driftClass: 'facts' })).rejects.toThrow(/preview changed/i);
      const next = await preview(engine, { driftClass: 'facts', limit: 3 });
      expect(next.listing!.map(entry => Number(/^fact (\d+) /.exec(entry.detail!)![1])).some(id => listed.includes(id))).toBe(false);
    }
  }, 120_000);

  test('a class over the statement bound is skipped and reported; doctor still reports the fact count first', async () => {
    for (const engine of engines) {
      await reset(engine);
      await seedShape(engine, SMALL);
      const rec = recording(engine, sql => sql.includes('concept-provenance'));
      const result = await preview(rec.engine, { limit: 10_000 });
      expect(result.details).toMatchObject({ window: { timed_out: ['lineage'], not_read: [] } });
      expect(new Set(result.listing!.map(entry => entry.class))).toEqual(new Set(['facts', 'events', 'aliases']));
      expect(result.warnings!.join(' ')).toContain('Class lineage did not finish within');
      // The derived counts are a typed engine read (countDerivedVisibility), so its timeout is injected on the member.
      const doctor = await derivedVisibilityCheck(timingOut(engine, 'countDerivedVisibility'));
      expect(doctor.status).toBe('warn');
      expect(doctor.details).toMatchObject({ derived_counts: 'unknown', count: 'lower_bound' });
      expect(Number(doctor.details!.world_facts_remotely_readable)).toBeGreaterThan(0);
      expect(doctor.message).toContain('readable by remote callers');
    }
  }, 120_000);
});

describe('GBRA-159 scale: tens of thousands of derived rows', () => {
  // GBRAIN_VISIBILITY_SCALE_FILLER adds plain pages for the full large-brain shape (e.g. 540000 for about 600k pages).
  const filler = Number(process.env.GBRAIN_VISIBILITY_SCALE_FILLER ?? 0);
  test('the default preview, a lineage preview and doctor each finish in under 10 s', async () => {
    for (const engine of engines) {
      await reset(engine);
      await seedShape(engine, { origins: 20_000, atoms: 40_000, concepts: 1_000, events: 2_000, aliased: 4_000, facts: 20_000, filler });
      const timed = async <T>(run: () => Promise<T>) => { const started = performance.now(); const value = await run(); return { value, ms: performance.now() - started }; };
      const window = await timed(() => preview(engine));
      expect(window.value.affected).toBe(1000);
      expect(window.ms).toBeLessThan(10_000);
      const lineage = await timed(() => preview(engine, { driftClass: 'lineage' }));
      expect((lineage.value.details as { window: { pending: { lineage: number } } }).window.pending.lineage).toBeGreaterThan(30_000);
      expect(lineage.ms).toBeLessThan(10_000);
      const doctor = await timed(() => derivedVisibilityCheck(engine));
      expect(doctor.value.details).toMatchObject({ count: 'exact' });
      expect(doctor.ms).toBeLessThan(10_000);
      console.error(`[${engine.kind}] preview ${Math.round(window.ms)} ms, lineage ${Math.round(lineage.ms)} ms, doctor ${Math.round(doctor.ms)} ms (filler ${filler})`);
    }
  }, 600_000);
});
