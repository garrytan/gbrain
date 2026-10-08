/**
 * Engine graduation state inventory (src/core/persistence/graduation-inventory.ts).
 *
 * Protects: every relation of a fresh schema on each engine has exactly one
 * inventory row (carry, rebind, rebuild, discard or schema-owned) with the
 * right engine-presence flags; graduation_unclassified_table fires on an
 * unclassified or missing relation; the FK graph is acyclic apart from the
 * known self-references, no copied table references a table the copy skips,
 * and the copy order puts every parent before its children.
 * Fails when: a migration adds a table or view without an inventory row (add
 * one to GRADUATION_INVENTORY with its class, loss kind and reason), a
 * migration adds an FK cycle, or a transform names a missing or key column.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import {
  assertRelationSet, copyOrder, expectedRelations, fkClosure, foreignKeys, GRADUATION_INVENTORY, listRelations, topologicalOrder,
} from '../src/core/persistence/graduation-inventory.ts';
import { primaryKey, tableColumns } from '../src/core/persistence/graduation-digest.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: Array<{ kind: 'pglite' | 'postgres'; engine: BrainEngine }> = [];
let engine: PGLiteEngine;
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  engines.push({ kind: 'pglite', engine });
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push({ kind: 'postgres', engine: pg.engine });
    closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  await closePostgres?.();
});

/** Self-referencing FKs the copy handles in two passes; any other self-reference or cycle must be designed for first. */
const KNOWN_SELF_FKS = [
  'facts(superseded_by)', 'minion_jobs(budget_owner_job_id)', 'minion_jobs(parent_job_id)', 'minion_jobs(private_queue_owner_job_id)',
];

async function expectCode(promise: Promise<unknown>, code: string): Promise<OperationError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(OperationError);
  expect((error as OperationError).code).toBe(code);
  return error as OperationError;
}

describe('graduation inventory', () => {
  test('rows are unique, classified once, and match the reviewed class counts', () => {
    const names = GRADUATION_INVENTORY.entries.map(e => e.relation);
    expect(new Set(names).size).toBe(names.length);
    const counts: Record<string, number> = {};
    for (const e of GRADUATION_INVENTORY.entries) counts[e.class] = (counts[e.class] ?? 0) + 1;
    expect(counts).toEqual({ carry: 110, rebind: 2, rebuild: 2, discard: 7, schema_owned: 3 });
    for (const e of GRADUATION_INVENTORY.entries) {
      expect({ relation: e.relation, reason: e.reason.length > 5, present: e.engines.pglite || e.engines.postgres })
        .toEqual({ relation: e.relation, reason: true, present: true });
    }
    expect(expectedRelations('pglite').filter(r => !expectedRelations('postgres').includes(r))).toEqual(['planner_stats_deltas', 'planner_stats_state']);
    expect(expectedRelations('postgres').filter(r => !expectedRelations('pglite').includes(r))).toEqual(['file_migration_ledger']);
    expect(GRADUATION_INVENTORY.entries.filter(e => e.lossKind === 'security').map(e => e.relation).sort()).toEqual([
      'access_tokens', 'oauth_clients', 'oauth_codes', 'oauth_grant_audit', 'oauth_tokens', 'persistence_local_writers', 'shared_skill_state']);
  });

  test('every relation of a fresh schema has a row on each engine', async () => {
    for (const { kind, engine } of engines) {
      expect({ kind, relations: (await listRelations(engine)).map(r => r.relation) }).toEqual({ kind, relations: [...expectedRelations(kind)] });
      await assertRelationSet(engine, kind);
    }
  });

  test('an unclassified or missing relation refuses with graduation_unclassified_table', async () => {
    for (const { kind, engine } of engines) {
      await engine.executeRaw('CREATE TABLE graduation_probe_unlisted (id int PRIMARY KEY)');
      try {
        const error = await expectCode(assertRelationSet(engine, kind), 'graduation_unclassified_table');
        expect(error.message).toContain('graduation_probe_unlisted');
        expect(error.reason).toBe('missing_inventory_row');
        expect(error.fix?.verify?.argv).toEqual(['gbrain', 'migrate', '--to', 'postgres', '--plan', '--url-env', 'GBRAIN_TARGET_URL', '--json']);
      } finally { await engine.executeRaw('DROP TABLE graduation_probe_unlisted'); }
      const extra = { ...GRADUATION_INVENTORY, entries: [...GRADUATION_INVENTORY.entries, { ...GRADUATION_INVENTORY.entries[0]!, relation: 'graduation_probe_absent' }] };
      expect((await expectCode(assertRelationSet(engine, kind, extra), 'graduation_unclassified_table')).message).toContain('missing: graduation_probe_absent');
    }
  });

  test('a schema newer than this binary names the upgrade instead of a maintainer bug', async () => {
    const { kind, engine } = engines[0]!;
    const [version] = await engine.executeRaw<{ value: string }>("SELECT value FROM config WHERE key='version'");
    await engine.executeRaw("UPDATE config SET value='99999' WHERE key='version'");
    await engine.executeRaw('CREATE TABLE graduation_probe_future (id int PRIMARY KEY)');
    try {
      const error = await expectCode(assertRelationSet(engine, kind), 'graduation_unclassified_table');
      expect(error.reason).toBe('newer_schema');
      expect(error.fix?.argv).toEqual(['gbrain', 'upgrade']);
    } finally {
      await engine.executeRaw('DROP TABLE graduation_probe_future');
      await engine.executeRaw("UPDATE config SET value=$1 WHERE key='version'", [version!.value]);
    }
  });

  test('transforms and row filters name real, non-key columns of copied tables', async () => {
    for (const { engine } of engines) {
      for (const entry of GRADUATION_INVENTORY.entries) {
        if (!entry.transforms.length && !entry.rowFilter) continue;
        expect({ relation: entry.relation, copied: entry.class === 'carry' || entry.class === 'rebind' }).toEqual({ relation: entry.relation, copied: true });
        const columns = (await tableColumns(engine, entry.relation)).map(c => c.name);
        const key = (await primaryKey(engine, entry.relation)).map(c => c.name);
        for (const t of entry.transforms) {
          expect({ relation: entry.relation, column: t.column, exists: columns.includes(t.column), key: key.includes(t.column), sql: Boolean(t.expression) })
            .toEqual({ relation: entry.relation, column: t.column, exists: true, key: false, sql: true });
        }
        const filter = entry.rowFilter ? ` WHERE ${entry.rowFilter}` : '';
        await engine.executeRaw(`SELECT ${entry.transforms.map(t => `(${t.expression})::text`).join(', ') || '1'} FROM ${entry.relation}${filter} LIMIT 1`);
      }
    }
  });

  test('every copied table has a primary key', async () => {
    for (const { engine } of engines) {
      for (const entry of await copyOrder(engine)) expect((await primaryKey(engine, entry.relation)).length).toBeGreaterThan(0);
    }
  });

  test('the FK graph is acyclic apart from known self-references, and copied tables reference only copied tables', async () => {
    const copied = new Set(GRADUATION_INVENTORY.entries.filter(e => e.class === 'carry' || e.class === 'rebind').map(e => e.relation));
    for (const { kind, engine } of engines) {
      const fks = await foreignKeys(engine);
      expect({ kind, self: fks.filter(f => f.child === f.parent).map(f => `${f.child}(${f.childColumns.join(',')})`).sort() }).toEqual({ kind, self: KNOWN_SELF_FKS });
      const tables = (await listRelations(engine)).filter(r => r.kind === 'table').map(r => r.relation);
      expect(topologicalOrder(tables, fks)).toHaveLength(tables.length);
      expect({ kind, crossing: fks.filter(f => copied.has(f.child) && !copied.has(f.parent)).map(f => f.name) }).toEqual({ kind, crossing: [] });
    }
  });

  test('copy order holds every carry and rebind table, parents first', async () => {
    for (const { kind, engine } of engines) {
      const order = (await copyOrder(engine)).map(e => e.relation);
      const expected = GRADUATION_INVENTORY.entries.filter(e => (e.class === 'carry' || e.class === 'rebind') && e.engines[kind]).map(e => e.relation).sort();
      expect([...order].sort()).toEqual(expected);
      for (const fk of await foreignKeys(engine)) {
        if (fk.child === fk.parent || !order.includes(fk.child)) continue;
        expect({ fk: fk.name, parentFirst: order.indexOf(fk.parent) < order.indexOf(fk.child) }).toEqual({ fk: fk.name, parentFirst: true });
      }
    }
  });

  test('fkClosure returns the relation and every transitive child in topological order', async () => {
    for (const { engine } of engines) {
      const closure = await fkClosure(engine, 'pages');
      expect(closure[0]).toBe('pages');
      for (const child of ['content_chunks', 'links', 'tags', 'timeline_entries', 'page_versions', 'raw_data']) expect(closure).toContain(child);
      const fks = await foreignKeys(engine);
      for (const fk of fks) {
        if (fk.parent === fk.child || !closure.includes(fk.parent)) continue;
        expect(closure.indexOf(fk.parent)).toBeLessThan(closure.indexOf(fk.child));
      }
      expect(closure).not.toContain('sources');
      expect(await fkClosure(engine, 'config')).toEqual(['config']);
    }
  });

  test('topologicalOrder throws on a cycle and ignores self-references', () => {
    expect(topologicalOrder(['a', 'b'], [{ parent: 'a', child: 'a' }, { parent: 'a', child: 'b' }])).toEqual(['a', 'b']);
    expect(() => topologicalOrder(['a', 'b', 'c'], [{ parent: 'a', child: 'b' }, { parent: 'b', child: 'a' }])).toThrow(/cycle among a, b/);
  });
});
