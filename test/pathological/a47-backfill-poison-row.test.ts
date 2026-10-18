/**
 * A-47 (GBRA-130): one poison row never wedges a backfill (src/core/backfill-base.ts).
 *
 * Protects: a row whose compute throws, or whose UPDATE violates a row
 * constraint, is isolated by bisecting its batch (each half in its own
 * transaction), recorded in `backfill.<name>.skipped` and the `skipped` result
 * field with a typed code and the command that retries it, and the checkpoint
 * moves past it while its siblings land. A content failure is held after 3
 * runs at the same row revision and gbrain version; a transient one is retried
 * on every run and never held. A run-scoped failure, a failed ROLLBACK, a lost
 * COMMIT acknowledgment or a systemic run stops the backfill, records nothing
 * and never moves the checkpoint past the batch.
 * Fails when: the batch is not bisected (the run throws and the checkpoint
 * stays before the batch), a skipped row is not recorded or not retried, a
 * transient failure is held, or an undecided batch is bisected or passed.
 * Seams: none in production; the ROLLBACK/COMMIT faults wrap the engine's
 * reserved connection in the test. PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runBackfill, type BackfillSpec } from '../../src/core/backfill-base.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

interface ProbeRow { id: number; slug: string; title: string }

const sqlError = (code: string, message: string) => Object.assign(new Error(message), { code });

async function seed(engine: BrainEngine, titles: string[]): Promise<{ sourceId: string; rows: ProbeRow[] }> {
  const sourceId = `bf-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [sourceId]);
  for (const [i, title] of titles.entries()) {
    await engine.putPage(`notes/row-${String(i).padStart(2, '0')}`, { type: 'note', title, compiled_truth: `# ${title}`, timeline: '' }, { sourceId });
  }
  const rows = await engine.executeRaw<ProbeRow>('SELECT id, slug, title FROM pages WHERE source_id = $1 ORDER BY id', [sourceId]);
  return { sourceId, rows: rows.map(r => ({ ...r, id: Number(r.id) })) };
}

type Compute = BackfillSpec<ProbeRow>['compute'];

/**
 * A backfill over one source's pages: it stamps effective_date and updated_at. A row titled `poison` writes an
 * invalid page_kind (a CHECK violation, 23514) unless `validWrites`; `computeFault` makes compute throw for any
 * batch holding a row it returns an error for.
 */
function probeSpec(sourceId: string, opts: { computeFault?: (row: ProbeRow) => unknown; computed?: ProbeRow[][]; validWrites?: boolean } = {}): BackfillSpec<ProbeRow> {
  const compute: Compute = async rows => {
    opts.computed?.push(rows);
    for (const row of rows) {
      const fault = opts.computeFault?.(row);
      if (fault) throw fault;
    }
    return rows.map(row => ({ id: Number(row.id), updates: { effective_date: '2026-01-01T00:00:00Z', updated_at: '2026-02-02T00:00:00Z',
      page_kind: row.title === 'poison' && !opts.validWrites ? 'bogus' : 'markdown' } }));
  };
  return { name: `probe_${sourceId.replace(/-/g, '_')}`, table: 'pages', selectColumns: ['slug', 'title'],
    needsBackfill: `effective_date IS NULL AND source_id = '${sourceId}'`, compute };
}

type RawConn = { executeRaw: (sql: string, params?: unknown[]) => Promise<unknown[]> };

/** The engine with its reserved connection's statements routed through `fault` (the batch's BEGIN/UPDATE/COMMIT/ROLLBACK). */
function withConnectionFault(engine: BrainEngine, fault: (sql: string, run: () => Promise<unknown[]>) => Promise<unknown[]>): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'withReservedConnection') {
        const reserve = target.withReservedConnection.bind(target) as unknown as (fn: (conn: RawConn) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
        return (fn: (conn: RawConn) => Promise<unknown>, opts?: unknown) =>
          reserve(conn => fn({ executeRaw: (sql, params) => fault(sql, () => conn.executeRaw(sql, params)) }), opts);
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const config = async (engine: BrainEngine, key: string) => (await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1', [key]))[0]?.value ?? null;
const skipLedger = async (engine: BrainEngine, name: string) => {
  const raw = await config(engine, `backfill.${name}.skipped`);
  return raw ? JSON.parse(raw) as { version: number; items: Record<string, Record<string, unknown>> } : null;
};
const checkpoint = (engine: BrainEngine, name: string) => config(engine, `backfill.${name}.last_id`);
const titles = (poisonAt: number[], count = 8) => Array.from({ length: count }, (_, i) => poisonAt.includes(i) ? 'poison' : `healthy ${i}`);

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-47 backfill poison row (${backend})`, () => {
    let engine: BrainEngine;
    let closePostgres: (() => Promise<void>) | null = null;

    beforeAll(async () => {
      if (databaseUrl) ({ engine, close: closePostgres } = await isolatedPersistencePostgres(databaseUrl));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    }, 180_000);

    afterAll(async () => {
      if (closePostgres) await closePostgres();
      else await engine.disconnect();
    });

    test('item: a row whose UPDATE violates a CHECK is skipped, recorded and passed; its siblings land', async () => {
      const { sourceId, rows } = await seed(engine, titles([3]));
      const spec = probeSpec(sourceId);
      const poison = rows[3]!;
      const before = await snapshotItems(engine, sourceId);
      const result = await expectUnitNotAborted(() => runBackfill(engine, spec, { batchSize: 100 }));
      expect(result.updated).toBe(7);
      expect(result.skipped.map(s => s.id)).toEqual([poison.id]);
      expectItemFailure(result.skipped[0], { key: String(poison.id), code: 'invalid_data', fix: new RegExp(`^gbrain backfill ${spec.name}$`) });
      expect(result.skipped[0]).toMatchObject({ class: 'content', state: 'failing', attempts: 1 });
      expect(await checkpoint(engine, spec.name)).toBe(String(rows.at(-1)!.id));
      expect(Object.keys((await skipLedger(engine, spec.name))!.items)).toEqual([String(poison.id)]);
      expectOthersUnchanged(before, await snapshotItems(engine, sourceId), { expectProgress: rows.filter(r => r !== poison).map(r => r.slug), progressFields: ['updated_at'] });

      const again = await expectUnitNotAborted(() => runBackfill(engine, spec, { batchSize: 100 }));
      expect({ updated: again.updated, skipped: again.skipped.map(s => [s.id, s.attempts]) }).toEqual({ updated: 0, skipped: [[poison.id, 2]] });
    });

    test('item: a row whose compute throws is isolated by bisection', async () => {
      const { sourceId, rows } = await seed(engine, titles([5]));
      const computed: ProbeRow[][] = [];
      const spec = probeSpec(sourceId, { computed, validWrites: true, computeFault: row => row.title === 'poison' ? sqlError('22007', 'invalid input syntax for type timestamp') : null });
      const poison = rows[5]!;
      const before = await snapshotItems(engine, sourceId);
      const result = await expectUnitNotAborted(() => runBackfill(engine, spec, { batchSize: 100 }));
      expect(result.updated).toBe(7);
      expect(result.skipped.length).toBe(1);
      expectItemFailure(result.skipped[0], { key: String(poison.id), code: 'invalid_data', fix: /^gbrain backfill / });
      expect(computed.length).toBeLessThan(2 * rows.length);
      expect(await checkpoint(engine, spec.name)).toBe(String(rows.at(-1)!.id));
      expectOthersUnchanged(before, await snapshotItems(engine, sourceId), { expectProgress: rows.filter(r => r !== poison).map(r => r.slug), progressFields: ['updated_at'] });
    });

    test('hold: a content failure is held after 3 runs at the same revision and gbrain version, then not retried', async () => {
      const { sourceId, rows } = await seed(engine, titles([2]));
      const computed: ProbeRow[][] = [];
      const spec = probeSpec(sourceId, { computed });
      const poison = rows[2]!;
      for (let run = 1; run <= 3; run++) await expectUnitNotAborted(() => runBackfill(engine, spec, { batchSize: 100 }));
      const held = (await skipLedger(engine, spec.name))!.items[String(poison.id)]!;
      expect(held).toMatchObject({ state: 'held', attempts: 3, code: 'invalid_data', class: 'content' });
      computed.length = 0;
      const fourth = await expectUnitNotAborted(() => runBackfill(engine, spec, { batchSize: 100 }));
      expect(computed.flat().map(r => Number(r.id))).toEqual([]);
      expectItemFailure(fourth.skipped[0], { key: String(poison.id), code: 'invalid_data', fix: new RegExp(`^gbrain backfill ${spec.name} --fresh$`) });
      expect(fourth.skipped[0]).toMatchObject({ state: 'held', attempts: 3 });
    });

    test('transient: an unknown compute error is never held and is retried on every run', async () => {
      const { sourceId, rows } = await seed(engine, titles([4]));
      const spec = probeSpec(sourceId, { validWrites: true, computeFault: row => row.title === 'poison' ? new TypeError('frontmatter.date is undefined') : null });
      const poison = rows[4]!;
      let last;
      for (let run = 1; run <= 4; run++) last = await expectUnitNotAborted(() => runBackfill(engine, spec, { batchSize: 100 }));
      expectItemFailure(last!.skipped[0], { key: String(poison.id), code: 'internal', fix: /^gbrain backfill / });
      expect(last!.skipped[0]).toMatchObject({ class: 'transient', state: 'failing', attempts: 4 });
    });

    test('recovery: a held row is retried and lands once its content or the gbrain version changes, or on --fresh', async () => {
      const { sourceId, rows } = await seed(engine, titles([1, 4, 7], 10));
      const spec = probeSpec(sourceId);
      for (let run = 1; run <= 3; run++) await runBackfill(engine, spec, { batchSize: 100 });
      expect(Object.values((await skipLedger(engine, spec.name))!.items).map(i => i.state)).toEqual(['held', 'held', 'held']);
      const [contentFixed, versionMoved, freshRetried] = [rows[1]!, rows[4]!, rows[7]!];
      await engine.executeRaw(`UPDATE pages SET title = 'fixed' WHERE id = $1`, [contentFixed.id]);
      const ledger = (await skipLedger(engine, spec.name))!;
      ledger.items[String(versionMoved.id)]!.producer = '0.0.1';
      await engine.setConfig(`backfill.${spec.name}.skipped`, JSON.stringify(ledger));
      const before = await snapshotItems(engine, sourceId);
      // The version-moved row is retried and still fails (its count restarts); the content-fixed row lands.
      const retried = await expectUnitNotAborted(() => runBackfill(engine, spec, { batchSize: 100 }));
      expect(retried.updated).toBe(1);
      expect(retried.skipped.map(s => [s.id, s.state, s.attempts])).toEqual([[versionMoved.id, 'failing', 1], [freshRetried.id, 'held', 3]]);
      expectOthersUnchanged(before, await snapshotItems(engine, sourceId), { expectProgress: [contentFixed.slug], progressFields: ['updated_at'] });
      await engine.executeRaw(`UPDATE pages SET title = 'fixed' WHERE id IN ($1, $2)`, [versionMoved.id, freshRetried.id]);
      const fresh = await expectUnitNotAborted(() => runBackfill(engine, spec, { batchSize: 100, fresh: true }));
      expect({ updated: fresh.updated, skipped: fresh.skipped }).toEqual({ updated: 2, skipped: [] });
      expect(await skipLedger(engine, spec.name)).toEqual({ version: 1, items: {} });
    });

    test('ledger: a failed skip-ledger read stops the run before any row, so older retry records are never overwritten', async () => {
      const { sourceId, rows } = await seed(engine, titles([1, 6]));
      const spec = probeSpec(sourceId);
      await expectUnitNotAborted(() => runBackfill(engine, spec, { batchSize: 4 }));
      const ledgerBefore = await skipLedger(engine, spec.name);
      expect(Object.keys(ledgerBefore!.items)).toEqual([String(rows[1]!.id), String(rows[6]!.id)]);
      const checkpointBefore = await checkpoint(engine, spec.name);
      const before = await snapshotItems(engine, sourceId);
      const readFailure = sqlError('57014', 'canceling statement due to statement timeout');
      const flaky = new Proxy(engine, {
        get(target, prop) {
          if (prop === 'executeRaw') {
            return (sql: string, params?: unknown[]) => String(params?.[0] ?? '').endsWith('.skipped') && sql.includes('SELECT value FROM config')
              ? Promise.reject(readFailure) : target.executeRaw(sql, params as never);
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as BrainEngine;
      expect(await runBackfill(flaky, spec, { batchSize: 4, fresh: true }).catch(e => e)).toBe(readFailure);
      expect(await skipLedger(engine, spec.name)).toEqual(ledgerBefore);
      expect(await checkpoint(engine, spec.name)).toBe(checkpointBefore);
      expectOthersUnchanged(before, await snapshotItems(engine, sourceId));
    });

    test('run: a role without UPDATE privilege (a real 42501) stops the backfill at its first write and records nothing', async () => {
      const { sourceId } = await seed(engine, titles([]));
      const spec = probeSpec(sourceId);
      const role = `gbra130_ro_${randomUUID().slice(0, 8)}`;
      await engine.executeRaw(`CREATE ROLE ${role}`);
      await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await engine.executeRaw(`GRANT SELECT ON pages TO ${role}`);
      try {
        const readOnly = new Proxy(engine, {
          get(target, prop) {
            if (prop === 'withReservedConnection') {
              const reserve = target.withReservedConnection.bind(target) as unknown as (fn: (conn: RawConn) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
              return (fn: (conn: RawConn) => Promise<unknown>, opts?: unknown) => reserve(conn => fn({
                executeRaw: async (sql, params) => {
                  const out = await conn.executeRaw(sql, params);
                  if (/^\s*BEGIN/i.test(sql)) await conn.executeRaw(`SET LOCAL ROLE ${role}`);
                  return out;
                },
              }), opts);
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as BrainEngine;
        const before = await snapshotItems(engine, sourceId);
        const thrown = await runBackfill(readOnly, spec, { batchSize: 100 }).catch(e => e);
        expect(String((thrown as { code?: unknown })?.code)).toBe('42501');
        expect(await skipLedger(engine, spec.name)).toBeNull();
        expect(await checkpoint(engine, spec.name)).toBeNull();
        expectOthersUnchanged(before, await snapshotItems(engine, sourceId));
      } finally {
        await engine.executeRaw(`REVOKE ALL ON pages FROM ${role}`);
        await engine.executeRaw(`REVOKE ALL ON SCHEMA public FROM ${role}`);
        await engine.executeRaw(`DROP ROLE ${role}`);
      }
    });

    test('breaker: when most rows fail the run stops item_failures_systemic and records no skip', async () => {
      const { sourceId } = await seed(engine, titles([0, 1, 2, 3, 4, 5, 6, 7]));
      const spec = probeSpec(sourceId);
      const before = await snapshotItems(engine, sourceId);
      const error = await runBackfill(engine, spec, { batchSize: 100 }).catch(e => e);
      expect(error?.code).toBe('item_failures_systemic');
      expect(await skipLedger(engine, spec.name)).toBeNull();
      expect(await checkpoint(engine, spec.name)).toBeNull();
      expectOthersUnchanged(before, await snapshotItems(engine, sourceId));
    });

    for (const { name, error } of runScopedErrors()) {
      test(`run: a run-scoped failure (${name}) in compute stops the backfill and records nothing`, async () => {
        const { sourceId } = await seed(engine, titles([3]));
        const injected = error();
        const spec = probeSpec(sourceId, { computeFault: row => row.title === 'poison' ? injected : null });
        const before = await snapshotItems(engine, sourceId);
        const thrown = await runBackfill(engine, spec, { batchSize: 100 }).catch(e => e);
        expect(thrown).toBe(injected);
        expect(await skipLedger(engine, spec.name)).toBeNull();
        expect(await checkpoint(engine, spec.name)).toBeNull();
        expectOthersUnchanged(before, await snapshotItems(engine, sourceId));
      });
    }

    test('run: a failed transaction (25P02) on a row UPDATE stops the backfill without bisecting', async () => {
      const { sourceId } = await seed(engine, titles([]));
      const computed: ProbeRow[][] = [];
      const spec = probeSpec(sourceId, { computed });
      let updates = 0;
      const faulty = withConnectionFault(engine, async (sql, run) => {
        if (sql.startsWith('UPDATE') && ++updates === 2) throw sqlError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
        return run();
      });
      const before = await snapshotItems(engine, sourceId);
      const thrown = await runBackfill(faulty, spec, { batchSize: 100 }).catch(e => e);
      expect(thrown?.code).toBe('25P02');
      expect(computed.length).toBe(1);
      expect(await skipLedger(engine, spec.name)).toBeNull();
      expect(await checkpoint(engine, spec.name)).toBeNull();
      expectOthersUnchanged(before, await snapshotItems(engine, sourceId));
    });

    test('rollback: a failed ROLLBACK after a row-constraint failure stops without bisecting or recording', async () => {
      const { sourceId } = await seed(engine, titles([3]));
      const computed: ProbeRow[][] = [];
      const spec = probeSpec(sourceId, { computed });
      const faulty = withConnectionFault(engine, async (sql, run) => {
        if (sql === 'ROLLBACK') { await run(); throw sqlError('08006', 'connection failure during ROLLBACK'); }
        return run();
      });
      const before = await snapshotItems(engine, sourceId);
      const thrown = await runBackfill(faulty, spec, { batchSize: 100 }).catch(e => e);
      expect(thrown?.name).toBe('BackfillRollbackError');
      expect(computed.length).toBe(1);
      expect(await skipLedger(engine, spec.name)).toBeNull();
      expect(await checkpoint(engine, spec.name)).toBeNull();
      expectOthersUnchanged(before, await snapshotItems(engine, sourceId));
    });

    test('commit: a lost COMMIT acknowledgment stops without bisecting and never passes the batch', async () => {
      const { sourceId } = await seed(engine, titles([], 6));
      const computed: ProbeRow[][] = [];
      const spec = probeSpec(sourceId, { computed });
      const faulty = withConnectionFault(engine, async (sql, run) => {
        if (sql === 'COMMIT') { await run(); throw sqlError('08006', 'Connection terminated unexpectedly'); }
        return run();
      });
      const thrown = await runBackfill(faulty, spec, { batchSize: 100 }).catch(e => e);
      expect(thrown?.name).toBe('BackfillCommitIndeterminateError');
      expect(thrown?.fix).toBe(`gbrain backfill ${spec.name} --resume`);
      expect(computed.length).toBe(1);
      expect(await skipLedger(engine, spec.name)).toBeNull();
      expect(await checkpoint(engine, spec.name)).toBeNull();
      // The resumed run finds the committed rows done and nothing to redo.
      const resumed = await expectUnitNotAborted(() => runBackfill(engine, spec, { batchSize: 100 }));
      expect({ examined: resumed.examined, skipped: resumed.skipped }).toEqual({ examined: 0, skipped: [] });
    });
  });
}
