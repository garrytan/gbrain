/**
 * #6911: a brain whose query_cache table is missing although its schema is at head. The coordinated purge must
 * still purge (query_cache is a rebuildable cache), its receipt must say the cache was absent, a missing user-data
 * table must still fail the purge loudly, doctor must report the missing table, and the preview-first
 * `gbrain repair missing-tables` must recreate the cache in the shape a fully migrated brain has.
 * Real PGLite, plus Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { operations } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readMissingTables } from '../src/core/schema-missing-tables.ts';
import { runRepair, resolveRepairScope } from '../src/core/repair/core.ts';
import { missingTablesRepair } from '../src/core/repair/missing-tables.ts';
import { schemaVersionEntry } from '../src/commands/doctor/checks/schema-health.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { withColdPglite } from './helpers/with-snapshot.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-6911-'));
const engines: BrainEngine[] = [];
let fresh: PGLiteEngine;
let closePostgres: (() => Promise<void>) | undefined;
const CLAIM = 'Keeps the deploy runbook in vault-a';
const body = (title: string) => `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\nProse.\n\n## Facts\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->\n`;
const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind, embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;
const call = (engine: BrainEngine, name: string, params: Record<string, unknown>) => op(name).handler(ctx(engine), params) as Promise<Record<string, any>>;

async function seed(engine: BrainEngine, slug: string): Promise<void> {
  await importFromContent(engine, slug, body(slug.split('/')[1]!), { noEmbed: true, sourceId: 'default' });
  await runExtractFacts(engine, { slugs: [slug] });
}
async function purgePage(engine: BrainEngine, slug: string) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  return call(engine, 'delete_page', { slug, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision });
}
async function missingTablesCheck(engine: BrainEngine) {
  const checks = await schemaVersionEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[];
  return checks.find(c => c.name === 'schema_missing_tables')!;
}
async function errorCode(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok'; } catch (e) { return e instanceof OperationError ? `${e.canonical ?? e.code}: ${e.message}` : String((e as Error).message); }
}
/** Columns and indexes of a table, comparable across two brains. */
async function shape(engine: BrainEngine, table: string) {
  const columns = await engine.executeRaw<Record<string, string>>(`SELECT column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name=$1 ORDER BY column_name`, [table]);
  const indexes = await engine.executeRaw<{ indexdef: string }>('SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename=$1 ORDER BY indexname', [table]);
  return { columns, indexes: indexes.map(i => i.indexdef) };
}

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = await withColdPglite(async () => { const e = new PGLiteEngine(); await e.connect({}); await e.initSchema(); return e; });
  engines.push(lite);
  fresh = new PGLiteEngine(); await fresh.connect({}); await fresh.initSchema();
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) await registerLocalWriter(engine, 'cli');
}), 180_000);
afterAll(async () => {
  for (const engine of engines) await disposePersistenceConsumer(engine).catch(() => undefined);
  await engines[0]?.disconnect(); await fresh?.disconnect(); await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
}, 60_000);

describe('#6911 missing query_cache', () => {
  test('the coordinated page purge commits and its receipt names the absent cache', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await seed(engine, 'people/purge-example');
      await engine.executeRaw('DROP TABLE query_cache');
      const result = await purgePage(engine, 'people/purge-example');
      expect(result.status).toBe('purged');
      expect(result.purge.removed.query_cache).toBe(0);
      expect(result.purge.missing_caches).toEqual(['query_cache']);
      expect(result.receipt.stores.find((s: any) => s.store === 'query_cache')).toMatchObject({ status: 'not_present', reason: 'table_missing' });
      expect(await engine.executeRaw("SELECT 1 FROM pages WHERE slug='people/purge-example'")).toHaveLength(0);
      expect((await engine.executeRaw("SELECT 1 FROM page_purges WHERE slug='people/purge-example'")).length).toBeGreaterThan(0);
    }
  }), 120_000);

  test('a fact purge commits and verifies with the cache absent', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await seed(engine, 'people/fact-example');
      await engine.executeRaw('DROP TABLE IF EXISTS query_cache');
      const [row] = await engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE fact=$1 AND entity_slug='people/fact-example'", [CLAIM]);
      const dry = await call(engine, 'purge_fact', { id: Number(row!.id), dry_run: true });
      const done = await call(engine, 'purge_fact', { id: Number(row!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
      expect(done.state).toBe('committed');
      expect(done.stores.find((s: any) => s.store === 'query_cache')).toMatchObject({ status: 'not_present', reason: 'table_missing' });
    }
  }), 120_000);

  test('doctor reports the missing cache; the repair previews, then recreates it in the head shape', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const expected = await shape(fresh, 'query_cache');
    expect(expected.columns.length).toBeGreaterThan(0);
    for (const engine of engines) {
      await engine.executeRaw('DROP TABLE IF EXISTS query_cache');
      const report = await readMissingTables(engine);
      expect(report).toMatchObject({ status: 'checked', missing: [{ table: 'query_cache', inventory_class: 'rebuild', recreatable: true }] });
      const scope = await resolveRepairScope(engine);
      expect(await errorCode(runRepair(ctx(engine), missingTablesRepair, scope, { apply: true, explicit: true }))).toStartWith('invalid_params');
      const preview = await runRepair(ctx(engine), missingTablesRepair, scope, { apply: false, explicit: true });
      expect(preview.affected).toBe(1);
      expect(preview.preview_hash).toBeTruthy();
      expect(await engine.executeRaw("SELECT to_regclass('query_cache') IS NULL AS absent")).toEqual([{ absent: true }]);
      const applied = await runRepair(ctx(engine), missingTablesRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash });
      expect(applied.applied).toBe(1);
      expect(applied.outcomes).toMatchObject({ recreated: 1 });
      if (engine.kind === 'pglite') expect(await shape(engine, 'query_cache')).toEqual(expected);
      else expect((await shape(engine, 'query_cache')).columns.map(c => c.column_name)).toEqual(expected.columns.map(c => c.column_name));
      expect(await readMissingTables(engine)).toMatchObject({ status: 'checked', missing: [] });
      expect(await errorCode(runRepair(ctx(engine), missingTablesRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash }))).not.toBe('ok');
    }
  }), 120_000);

  test('an apply leaves a table that reappeared after the preview alone', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('DROP TABLE IF EXISTS query_cache');
      const scope = await resolveRepairScope(engine);
      const preview = await runRepair(ctx(engine), missingTablesRepair, scope, { apply: false, explicit: true });
      await engine.executeRaw('CREATE TABLE query_cache (id TEXT PRIMARY KEY)');
      const applied = await runRepair(ctx(engine), missingTablesRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash });
      expect(applied.outcomes).toEqual({ already_present: 1 });
      expect((await shape(engine, 'query_cache')).columns.map(c => c.column_name)).toEqual(['id']);
      await engine.executeRaw('DROP TABLE query_cache');
    }
  }), 120_000);

  test('a recreated query_cache takes the live facts vector shape, not the config default', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('DROP TABLE IF EXISTS query_cache');
      await engine.executeRaw('DROP INDEX IF EXISTS idx_facts_embedding_hnsw');
      await engine.executeRaw('ALTER TABLE facts ALTER COLUMN embedding TYPE halfvec(768) USING NULL');
      const scope = await resolveRepairScope(engine);
      const preview = await runRepair(ctx(engine), missingTablesRepair, scope, { apply: false, explicit: true });
      await runRepair(ctx(engine), missingTablesRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash });
      const [column] = await engine.executeRaw<{ type: string; dims: number }>(`SELECT t.typname AS type, a.atttypmod AS dims FROM pg_attribute a
        JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=to_regclass('query_cache') AND a.attname='embedding'`);
      expect(column).toEqual({ type: 'halfvec', dims: 768 });
    }
  }), 120_000);

  test('a role that may not create the table gets schema_owner_required and nothing changes', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.executeRaw('DROP TABLE IF EXISTS query_cache');
      const scope = await resolveRepairScope(engine);
      const preview = await runRepair(ctx(engine), missingTablesRepair, scope, { apply: false, explicit: true });
      const denied = Object.create(engine) as BrainEngine;
      denied.transaction = async () => { throw Object.assign(new Error('permission denied for schema public'), { code: '42501' }); };
      const message = await errorCode(runRepair(ctx(denied), missingTablesRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash }));
      expect(message).toStartWith('schema_owner_required');
      expect(await engine.executeRaw("SELECT to_regclass('query_cache') IS NULL AS absent")).toEqual([{ absent: true }]);
      const applied = await runRepair(ctx(engine), missingTablesRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash });
      expect(applied.outcomes).toMatchObject({ recreated: 1 });
    }
  }), 120_000);

  test('a failed PGLite VACUUM is reported as failed, never as ran', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = engines[0]!;
    await seed(engine, 'people/vacuum-example');
    const [row] = await engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE fact=$1 AND entity_slug='people/vacuum-example'", [CLAIM]);
    const dry = await call(engine, 'purge_fact', { id: Number(row!.id), dry_run: true });
    const original = Object.getPrototypeOf(engine).executeRaw as typeof engine.executeRaw;
    engine.executeRaw = (async function (this: BrainEngine, sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) {
      if (/^\s*VACUUM\b/i.test(sql)) throw new Error('forced vacuum failure');
      return original.call(this, sql, params, opts);
    }) as typeof engine.executeRaw;
    try {
      const done = await call(engine, 'purge_fact', { id: Number(row!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID(), vacuum: true });
      const physical = done.residuals.find((r: any) => r.store === 'database_physical');
      expect(physical.detail).toContain('VACUUM of the touched tables failed (forced vacuum failure)');
      expect(physical.detail).not.toContain('VACUUM ran');
    } finally { delete (engine as { executeRaw?: unknown }).executeRaw; }
  }), 120_000);

  test('the repair is explicit-only and a missing user-data table still fails the purge loudly', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const scope = await resolveRepairScope(engine);
      expect(await errorCode(runRepair(ctx(engine), missingTablesRepair, scope, { apply: false }))).toContain('explicit');
      await seed(engine, 'people/loud-example');
      await engine.executeRaw('DROP TABLE core_edit_notices');
      const report = await readMissingTables(engine);
      expect(report).toMatchObject({ status: 'checked', missing: [{ table: 'core_edit_notices', recreatable: false }] });
      const preview = await runRepair(ctx(engine), missingTablesRepair, scope, { apply: false, explicit: true });
      expect(preview.affected).toBe(0);
      expect(preview.residuals).toEqual({ user_data_tables: 1 });
      expect(await errorCode(purgePage(engine, 'people/loud-example'))).toStartWith('storage_error');
      expect(await engine.executeRaw("SELECT 1 FROM pages WHERE slug='people/loud-example' AND deleted_at IS NULL")).toHaveLength(1);
    }
  }), 120_000);

  test('doctor fails only a missing user-data table, warns for the rest, and says the base-schema replay hides a lost user-data table', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await engine.initSchema();
      await engine.executeRaw('DROP TABLE IF EXISTS query_cache');
      await engine.executeRaw('DROP TABLE IF EXISTS gbrain_cycle_locks');
      const warned = await missingTablesCheck(engine);
      expect(warned.status).toBe('warn');
      expect(warned.message).toBe('2 table(s) the applied migrations create are missing, and apply-migrations will not recreate them from the migrations that already ran. '
        + 'Rebuildable cache(s) query_cache: preview recreating them empty with gbrain repair missing-tables, then apply the printed command after the user agrees. '
        + 'gbrain_cycle_locks hold no user data: gbrain init --migrate-only recreates the ones the base schema defines; report any it does not (see docs/guides/repair.md#missing-tables).');
      expect(warned.fix?.argv).toEqual(['gbrain', 'repair', 'missing-tables', '--json']);
      expect((await readMissingTables(engine) as { missing: unknown[] }).missing).toEqual([
        { table: 'gbrain_cycle_locks', inventory_class: 'discard', loss_kind: 'operational', recreatable: false },
        { table: 'query_cache', inventory_class: 'rebuild', loss_kind: 'operational', recreatable: true }]);
      await engine.executeRaw('DROP TABLE IF EXISTS core_edit_notices');
      const failed = await missingTablesCheck(engine);
      expect(failed.status).toBe('fail');
      expect(failed.message).toContain('core_edit_notices hold user data: restore their rows from a backup before running gbrain init --migrate-only, gbrain upgrade or apply-migrations');
      await engine.initSchema();
      expect(await readMissingTables(engine)).toMatchObject({ status: 'checked', missing: [{ table: 'query_cache' }] });
      expect(await engine.executeRaw('SELECT count(*)::int AS n FROM core_edit_notices')).toEqual([{ n: 0 }]);
    }
  }), 180_000);
});
