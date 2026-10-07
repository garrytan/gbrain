/**
 * Foundations 2 (Lane C): `gbrain repair attribution-backfill` on a managed
 * brain with real journaled history (pages created, edited, deleted and
 * restored; facts remembered and forgotten), after the attribution of most
 * rows is reset to the pre-attribution state. Checks that the backfill fills
 * exactly the rows a committed request proves, back to the attribution the
 * coordinator wrote; leaves every other row `unrecorded`; and leaves canonical
 * content, revisions and rows that already carried attribution unchanged.
 * Prints the preview and apply counts (`GBRAIN_TEST_BACKFILL_FIXTURE_PAGES` sizes
 * the fixture; 40 pages by default).
 *
 * #6000: the proofs join the journal on an outcome key no index covers
 * (`outcome->>'revision'` for pages and page versions, `outcome->>'id'` for
 * facts). v193 adds the attribution columns without statistics, so the planner
 * takes nearly every row for attributed; a nested loop then reads the whole
 * journal once per unattributed row and the preview outlives the statement
 * timeout on a large brain. The second test explains every statement of the
 * preview and of the applied batches that joins the journal, in that state,
 * and checks none of them rescans the journal per row.
 *
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { WRITE_ATTRIBUTION_CONTENT_COLUMNS } from '../src/core/persistence/attribution-schema.ts';
import { attributionBackfillRepair } from '../src/core/repair/attribution-backfill.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { buildAttributionHistory } from './helpers/attribution-history-fixture.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends, requirePostgresTestDatabase } from './helpers/test-backends.ts';

const PAGES = Number(process.env.GBRAIN_TEST_BACKFILL_FIXTURE_PAGES ?? 40);

interface RepairResult { affected: number; applied: number; complete: boolean; residuals: Record<string, number> }
async function repair(engine: BrainEngine, args: string[]): Promise<RepairResult> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runRepairCommand(engine, ['attribution-backfill', ...args, '--json']); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')).results[0] as RepairResult;
}

const CONTENT = {
  pages: 'id, slug, type, title, compiled_truth, timeline, frontmatter::text AS frontmatter, content_hash, knowledge_revision::text AS revision, deleted_at::text AS deleted_at',
  page_versions: 'id, page_id, compiled_truth, frontmatter::text AS frontmatter, knowledge_revision::text AS revision',
  facts: WRITE_ATTRIBUTION_CONTENT_COLUMNS.facts.map(column => `${column}::text AS ${column}`).join(', '),
};
const FILLED = {
  pages: ['revision_write_request_id', 'revision_principal_kind', 'revision_principal_id'],
  page_versions: ['write_request_id', 'write_principal_kind', 'write_principal_id'],
  facts: ['write_request_id', 'write_principal_kind', 'write_principal_id'],
} as const;
const OTHER = {
  pages: [] as string[],
  page_versions: ['archived_write_request_id', 'archived_principal_kind', 'archived_principal_id'],
  facts: ['last_write_request_id', 'last_write_principal_kind', 'last_write_principal_id', 'last_written_at'],
};
type Table = keyof typeof CONTENT;
const TABLES: Table[] = ['pages', 'page_versions', 'facts'];
const scope = (table: Table) => table === 'page_versions' ? 'page_id IN (SELECT id FROM pages WHERE source_id=\'default\')' : 'source_id=\'default\'';
const read = (engine: BrainEngine, table: Table, columns: string) =>
  engine.executeRaw<Record<string, unknown>>(`SELECT ${columns} FROM ${table} WHERE ${scope(table)} ORDER BY id`);
const attribution = (engine: BrainEngine, table: Table) =>
  read(engine, table, ['id', ...[...FILLED[table], ...OTHER[table]].map(column => `${column}::text AS ${column}`)].join(', '));
const filled = (row: Record<string, unknown>, table: Table) => FILLED[table].some(column => row[column] !== null);

type PlanNode = Record<string, unknown>;
const planNodes = (plan: PlanNode): PlanNode[] => [plan, ...((plan.Plans as PlanNode[] | undefined) ?? []).flatMap(planNodes)];
/** Nested loops with a sequential scan of the journal on their inner side, which reads the whole journal once per outer row. */
const journalRescans = (plan: PlanNode) => planNodes(plan).filter(node => node['Node Type'] === 'Nested Loop'
  && ((node.Plans as PlanNode[] | undefined) ?? []).some(child => child['Parent Relationship'] === 'Inner'
    && planNodes(child).some(inner => inner['Node Type'] === 'Seq Scan' && inner['Relation Name'] === 'persistence_requests')));

/**
 * The engine, explaining each statement that joins the journal on the connection (and transaction) that runs it, and
 * refusing one planned to rescan the journal before it runs: such a plan takes minutes on this fixture, and PGLite
 * cannot interrupt a running statement.
 */
function explaining(engine: BrainEngine, plans: PlanNode[]): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        if (sql.includes('persistence_requests r')) {
          const [row] = await target.executeRaw<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
          const doc = Object.values(row)[0];
          const plan = (typeof doc === 'string' ? JSON.parse(doc) : doc as Array<{ Plan: PlanNode }>)[0].Plan;
          plans.push(plan);
          if (journalRescans(plan).length) throw new Error(`planned a nested loop over the journal: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
        }
        return target.executeRaw(sql, params);
      };
      if (prop === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => fn(explaining(tx, plans)));
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const NOTES = 300;
const FACTS = 200;
const JOURNAL = 6_000;
const REQUEST = `principal_kind, principal_id, request_id, operation, source_id, source_incarnation, page_id, slug, digest, authority,
  intent_bytes, terminal_reservation, state, outcome`;

for (const backend of testBackends()) {
  describe(`attribution-backfill on a managed history fixture (${backend})`, () => {
    test('fills exactly the journal-proven rows and changes no content, revision or existing attribution', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        const history = await buildAttributionHistory(ctx, PAGES);
        const content = Object.fromEntries(await Promise.all(TABLES.map(async table => [table, await read(engine, table, CONTENT[table])])));
        const original = Object.fromEntries(await Promise.all(TABLES.map(async table => [table, await attribution(engine, table)])));
        const kept = (id: unknown) => Number(id) % 4 === 0;

        await engine.transaction(async tx => {
          await tx.executeRaw('SET LOCAL session_replication_role = replica');
          for (const table of TABLES) {
            await tx.executeRaw(`UPDATE ${table} SET ${[...FILLED[table], ...OTHER[table]].map(column => `${column}=NULL`).join(', ')}
              WHERE ${scope(table)} AND id % 4 <> 0`);
          }
        });
        const reset = Object.fromEntries(TABLES.map(table => [table, (original[table] as Array<Record<string, unknown>>).filter(row => !kept(row.id) && filled(row, table)).length]));

        const preview = await repair(engine, []);
        const applied = await repair(engine, ['--apply']);
        const after = Object.fromEntries(await Promise.all(TABLES.map(async table => [table, await attribution(engine, table)])));
        const counts = Object.fromEntries(TABLES.map(table => {
          const rows = after[table] as Array<Record<string, unknown>>;
          return [table, { rows: rows.length, reset: reset[table], refilled: rows.filter(row => !kept(row.id) && filled(row, table)).length,
            unrecorded: rows.filter(row => !filled(row, table)).length }];
        }));
        console.error(`[attribution-backfill-fixture] ${JSON.stringify({ backend, history, preview: { affected: preview.affected, residuals: preview.residuals },
          apply: { applied: applied.applied, complete: applied.complete }, counts })}`);

        expect(applied.complete).toBe(true);
        expect((await repair(engine, ['--apply'])).applied).toBe(0);
        for (const table of TABLES) {
          expect(await read(engine, table, CONTENT[table])).toEqual(content[table]);
          const before = new Map((original[table] as Array<Record<string, unknown>>).map(row => [row.id, row]));
          for (const row of after[table] as Array<Record<string, unknown>>) {
            const was = before.get(row.id)!;
            if (kept(row.id)) { expect(row).toEqual(was); continue; }
            for (const column of OTHER[table]) expect(row[column]).toBeNull();
            if (filled(row, table)) for (const column of FILLED[table]) expect(row[column]).toEqual(was[column]);
          }
        }
        expect(counts.pages.refilled).toBeGreaterThan(0);
        expect(counts.page_versions.refilled).toBeGreaterThan(0);
        expect(counts.facts.refilled).toBeGreaterThan(0);
      }, backend === 'postgres' ? { databaseUrl: requirePostgresTestDatabase() } : {});
    }, Math.max(600_000, PAGES * 1_000));
  });

  describe(`attribution-backfill when the attribution columns have no statistics (${backend})`, () => {
    test('the preview and the applied batches read the journal once instead of once per unattributed row (#6000)', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        // Notes and facts written before attribution existed: every other one proven by one committed put_page or remember,
        // among unrelated committed requests.
        await engine.transaction(async tx => {
          await tx.executeRaw('SET LOCAL session_replication_role = replica');
          await tx.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth)
            SELECT 'default', 'notes/n-' || g, 'note', 'Note ' || g, 'body' FROM generate_series(1, $1::int) g`, [NOTES]);
          await tx.executeRaw(`INSERT INTO persistence_requests (${REQUEST})
            SELECT 'local_cli', 'cli:example', gen_random_uuid(), 'put_page', 'default', s.incarnation, p.id, p.slug, 'd', '{}'::jsonb, 1, 16384, 'committed',
              jsonb_build_object('status', 'created_or_updated', 'revision', p.knowledge_revision::text)
              FROM pages p, sources s WHERE s.id = 'default' AND p.source_id = 'default' AND p.slug LIKE 'notes/n-%' AND p.id % 2 = 0`);
          await tx.executeRaw(`INSERT INTO persistence_requests (${REQUEST})
            SELECT 'local_cli', 'cli:example', gen_random_uuid(), 'put_page', 'default', s.incarnation, NULL, 'notes/n-' || (g % $2::int + 1), 'd', '{}'::jsonb, 1, 16384, 'committed',
              jsonb_build_object('status', 'created_or_updated', 'revision', gen_random_uuid()::text)
              FROM generate_series(1, $1::int) g, sources s WHERE s.id = 'default'`, [JOURNAL, NOTES]);
          await tx.executeRaw(`INSERT INTO facts (source_id, fact, source)
            SELECT 'default', 'Fact ' || g, 'attribution-test' FROM generate_series(1, $1::int) g`, [FACTS]);
          await tx.executeRaw(`INSERT INTO persistence_requests (${REQUEST})
            SELECT 'local_cli', 'cli:example', gen_random_uuid(), 'remember', 'default', s.incarnation, NULL, 'notes/n-1', 'd', '{}'::jsonb, 1, 16384, 'committed',
              jsonb_build_object('status', 'inserted', 'id', f.id::text)
              FROM facts f, sources s WHERE s.id = 'default' AND f.source = 'attribution-test' AND f.id % 2 = 0`);
        });
        // The brain as v193 leaves it: the tables analyzed before the metadata-only ADD COLUMN, the new columns without statistics.
        await engine.executeRaw('ANALYZE');
        await engine.executeRaw(`DELETE FROM pg_statistic s USING pg_attribute a WHERE a.attrelid = s.starelid AND a.attnum = s.staattnum
          AND (a.attrelid = 'pages'::regclass AND a.attname LIKE 'revision\\_%'
            OR a.attrelid IN ('page_versions'::regclass, 'facts'::regclass) AND a.attname LIKE 'write\\_%')`);

        const plans: PlanNode[] = [];
        const proxy = explaining(engine, plans);
        const plan = await attributionBackfillRepair.plan(proxy, await resolveRepairScope(engine), null);
        // Every proven row lands in one batch per table, which fills it from the request that proves it.
        for (const { table, proven, filled } of [
          { table: 'pages', proven: `SELECT id FROM pages WHERE source_id = 'default' AND slug LIKE 'notes/n-%' AND id % 2 = 0`,
            filled: `SELECT count(*)::int AS n FROM pages t JOIN persistence_requests r
              ON r.id = t.revision_write_request_id AND r.outcome->>'revision' = t.knowledge_revision::text WHERE t.slug LIKE 'notes/n-%'` },
          { table: 'facts', proven: `SELECT id FROM facts WHERE source = 'attribution-test' AND id % 2 = 0`,
            filled: `SELECT count(*)::int AS n FROM facts t JOIN persistence_requests r
              ON r.id = t.write_request_id AND r.outcome->>'id' = t.id::text WHERE t.source = 'attribution-test'` },
        ]) {
          const rows = (await engine.executeRaw(proven)).length;
          const batches = plan.items.filter(item => item.action === `fill_${table}_attribution`);
          expect(batches.map(item => item.change!.to)).toEqual([`${rows} row(s)`]);
          expect(await attributionBackfillRepair.apply({ ...ctx, engine: proxy }, batches[0])).toEqual({ applied: true, outcome: 'filled', reason: `${rows} row(s)` });
          expect((await engine.executeRaw<{ n: number }>(filled))[0].n).toBe(rows);
        }

        // Three preview proofs (pages, page_versions, facts), then each batch's proof and its update, all explained and none refused.
        expect(plans.length).toBe(7);
      }, backend === 'postgres' ? { databaseUrl: requirePostgresTestDatabase() } : {});
    }, 120_000);

    test('the planner setting stays inside the repair: a caller transaction keeps its own setting on success and on error', async () => {
      await managedBrain(async ({ engine }) => {
        const scope = await resolveRepairScope(engine);
        const setting = async (tx: BrainEngine) => (await tx.executeRaw<{ enable_nestloop: string }>('SHOW enable_nestloop'))[0].enable_nestloop;
        expect(await engine.transaction(async tx => {
          await attributionBackfillRepair.plan(tx, scope, null);
          return setting(tx);
        })).toBe('on');
        expect(await engine.transaction(async tx => {
          await expect(attributionBackfillRepair.plan(failingProofs(tx), scope, null)).rejects.toThrow('proof failed');
          return setting(tx);
        })).toBe('on');
        expect(await setting(engine)).toBe('on');
      }, backend === 'postgres' ? { databaseUrl: requirePostgresTestDatabase() } : {});
    }, 120_000);
  });
}

/** The engine, failing every statement that joins the journal (inside the repair's own transaction). */
function failingProofs(engine: BrainEngine): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        if (sql.includes('persistence_requests r')) throw new Error('proof failed');
        return target.executeRaw(sql, params);
      };
      if (prop === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => fn(failingProofs(tx)));
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
