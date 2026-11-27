/**
 * The SQL engines' scanTextColumns against a real catalog (src/core/engine-sql/eval-harness-reads.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the scan reads the tables it found in the catalog of the current schema, by schema-qualified name; it
 *    treats a page_id column as a page link only when it is an integer; and it refuses, naming the tables, when the
 *    running role cannot read every row of a scanned table (no SELECT, or row-level security applies to it).
 *  - Regression: the scan used unqualified names (a temporary table of the same name was read instead), joined every
 *    page_id to pages.id (a uuid page_id aborted the whole scan with 42883), and a role that row security filtered got
 *    an empty answer, which reads as "the text is gone" (also when the table's only text column is a domain over
 *    text, which the visibility check did not count as text), and a pause that waited on the brain row lock read the
 *    topology count from before the wait, so a brain-wide change committed meanwhile failed its restore.
 *  - Why existing coverage misses it: the engine parity file runs only gbrain's own tables as their owner, and the
 *    byte-for-byte pins answer the catalog with a recorder; the pins also cannot show what a pause sees after it
 *    waits on another connection's lock.
 *  - Seam: none. Real PGLite and, with DATABASE_URL, real Postgres; the row security case needs a real role.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine, NewFact } from '../src/core/engine.ts';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const ROLLBACK = 'eval-harness-scan rollback';

const rolledBack = async (engine: BrainEngine, fn: (tx: BrainEngine) => Promise<void>) => {
  try {
    await engine.transaction(async tx => { await fn(tx); throw new Error(ROLLBACK); });
  } catch (error) {
    if ((error as Error).message !== ROLLBACK) throw error;
  }
};

/** The facts hits of a scan for `token`, as [table, value]. */
const factHits = async (engine: BrainEngine, token: string) =>
  (await engine.scanTextColumns({ pattern: token, activeOnly: false, tables: ['facts', 'eval_scan_links'] })).map(h => [h.table, h.value]);

/**
 * Waits, at most 10 s, until another backend waits on a lock of persistence_brain (the brain row), so a test knows its
 * statement is blocked on that lock rather than not yet sent. Throws when it never is.
 */
const waitForBrainLockWaiter = async (engine: BrainEngine) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [{ n }] = await engine.executeRaw<{ n: string }>(`SELECT count(*)::text AS n FROM pg_catalog.pg_locks l
      WHERE NOT l.granted AND l.pid <> pg_backend_pid()
        AND (l.relation = 'persistence_brain'::regclass OR l.locktype IN ('transactionid', 'tuple'))`);
    if (Number(n) > 0) return;
    await Bun.sleep(25);
  }
  throw new Error('no statement waited on the brain row lock within 10 s');
};

function catalogCases(open: () => BrainEngine) {
  test('a temporary table named like a scanned table does not hide the stored rows', async () => {
    const engine = open();
    await engine.insertFact({ fact: 'shadowedtoken is stored', entity_slug: null, visibility: 'world', source: 'test', embedding: null } as NewFact, { source_id: 'default' });
    await rolledBack(engine, async tx => {
      await tx.executeRaw('CREATE TEMPORARY TABLE facts (id bigint, fact text) ON COMMIT DROP');
      expect(await factHits(tx, 'shadowedtoken')).toEqual([['facts', 'shadowedtoken is stored']]);
    });
  }, 60_000);

  test('a table whose page_id is not an integer is scanned without a page join', async () => {
    const engine = open();
    await rolledBack(engine, async tx => {
      await tx.executeRaw('CREATE TABLE eval_scan_links (page_id uuid, note text)');
      await tx.executeRaw(`INSERT INTO eval_scan_links VALUES ('${randomUUID()}', 'uuidpagetoken here')`);
      const hits = await tx.scanTextColumns({ pattern: 'uuidpagetoken', activeOnly: true, tables: ['eval_scan_links'] });
      expect(hits.map(h => [h.table, h.column, h.page_id, h.value])).toEqual([['eval_scan_links', 'note', null, 'uuidpagetoken here']]);
    });
  }, 60_000);
}

describe.if(backends.includes('pglite'))('scanTextColumns on PGLite', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });
  catalogCases(() => engine);
});

describe.if(backends.includes('postgres'))('scanTextColumns on Postgres', () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  const reader = `gbrain_eval_scan_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  beforeAll(async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; close = pg.close;
    await engine.executeRaw(`CREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  }, 180_000);
  afterAll(async () => {
    await engine?.executeRaw(`DROP OWNED BY ${reader}`).catch(() => undefined);
    await engine?.executeRaw(`DROP ROLE IF EXISTS ${reader}`);
    await close?.();
  });
  catalogCases(() => engine);

  test('a role that row security filters is refused, naming the table, instead of answering no hits', async () => {
    await engine.insertFact({ fact: 'hiddentoken is stored', entity_slug: null, visibility: 'world', source: 'test', embedding: null } as NewFact, { source_id: 'default' });
    await rolledBack(engine, async tx => {
      const [{ schema }] = await tx.executeRaw<{ schema: string }>('SELECT current_schema()::text AS schema');
      await tx.executeRaw(`GRANT USAGE ON SCHEMA "${schema}" TO ${reader}`);
      await tx.executeRaw(`GRANT SELECT ON facts, pages TO ${reader}`);
      await tx.executeRaw('ALTER TABLE facts ENABLE ROW LEVEL SECURITY');
      await tx.executeRaw(`SET LOCAL ROLE ${reader}`);
      const refused = await tx.scanTextColumns({ pattern: 'hiddentoken', activeOnly: false, tables: ['facts'] }).then(() => 'ok', (e: Error) => e.message);
      // gbrain turns row security on for pages itself; the scan reads pages for the slug join, so it is named too.
      expect(refused).toBe('scanTextColumns: the running role cannot read every row of facts, pages; run the scan as the table owner or a BYPASSRLS role');
    });
    expect(await factHits(engine, 'hiddentoken')).toEqual([['facts', 'hiddentoken is stored']]);
  }, 120_000);

  test('a role that row security filters is refused for a table whose only text column is a domain over text', async () => {
    await rolledBack(engine, async tx => {
      const [{ schema }] = await tx.executeRaw<{ schema: string }>('SELECT current_schema()::text AS schema');
      await tx.executeRaw('CREATE DOMAIN eval_scan_note AS text');
      await tx.executeRaw('CREATE TABLE eval_scan_domain (id bigint, note eval_scan_note)');
      await tx.executeRaw("INSERT INTO eval_scan_domain VALUES (1, 'domaintoken is stored')");
      await tx.executeRaw('ALTER TABLE eval_scan_domain ENABLE ROW LEVEL SECURITY');
      await tx.executeRaw(`GRANT USAGE ON SCHEMA "${schema}" TO ${reader}`);
      await tx.executeRaw(`GRANT SELECT ON eval_scan_domain, pages TO ${reader}`);
      // The owner reads the row: the catalog lists the domain column as text.
      expect((await tx.scanTextColumns({ pattern: 'domaintoken', activeOnly: false, tables: ['eval_scan_domain'] })).map(h => h.value)).toEqual(['domaintoken is stored']);
      await tx.executeRaw(`SET LOCAL ROLE ${reader}`);
      const refused = await tx.scanTextColumns({ pattern: 'domaintoken', activeOnly: false, tables: ['eval_scan_domain'] }).then(h => JSON.stringify(h), (e: Error) => e.message);
      expect(refused).toBe('scanTextColumns: the running role cannot read every row of eval_scan_domain, pages; run the scan as the table owner or a BYPASSRLS role');
    });
  }, 120_000);

  test('a role with no privilege on a scanned table is refused, naming it, instead of answering no hits', async () => {
    await engine.insertFact({ fact: 'unreadabletoken is stored', entity_slug: null, visibility: 'world', source: 'test', embedding: null } as NewFact, { source_id: 'default' });
    await rolledBack(engine, async tx => {
      const [{ schema }] = await tx.executeRaw<{ schema: string }>('SELECT current_schema()::text AS schema');
      await tx.executeRaw(`GRANT USAGE ON SCHEMA "${schema}" TO ${reader}`);
      await tx.executeRaw(`SET LOCAL ROLE ${reader}`);
      const refused = await tx.scanTextColumns({ pattern: 'unreadabletoken', activeOnly: false, tables: ['facts'] }).then(() => 'ok', (e: Error) => e.message);
      expect(refused).toBe('scanTextColumns: the running role cannot read every row of facts, pages; run the scan as the table owner or a BYPASSRLS role');
    });
  }, 120_000);

  test('a harness pause that waits on a committing brain-wide change counts it, so its restore still succeeds', async () => {
    const store = await engine.writerReleaseStore();
    await store.setBrainEnabled(true);
    let locked!: () => void;
    let release!: () => void;
    const holding = new Promise<void>(r => { locked = r; });
    const gate = new Promise<void>(r => { release = r; });
    // Another connection holds the brain row lock and records a brain-wide topology change, then commits.
    const change = (engine as PostgresEngine).transaction(async tx => {
      await tx.executeRaw('SELECT 1 FROM persistence_brain WHERE singleton = 1 FOR UPDATE');
      await tx.executeRaw(`INSERT INTO persistence_topology_changes (principal_id, request_id, digest, operation, source_id, state)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'eval-scan', 'writer_activate', '*', 'committed')`);
      locked();
      await gate;
    });
    try {
      await holding;
      const pausing = engine.pauseManagedPersistence();
      let done = false;
      void pausing.then(() => { done = true; }, () => { done = true; });
      await waitForBrainLockWaiter(engine);
      const waited = !done;
      release();
      await change;
      const prior = await pausing;
      const [{ n }] = await engine.executeRaw<{ n: string }>("SELECT count(*)::text AS n FROM persistence_topology_changes WHERE source_id = '*'");
      const result = { waited, counted: prior.brain_topology_changes === n, restored: await engine.restoreManagedPersistence(prior),
        enabled: JSON.parse(await engine.readWriterAdminState()).brain.enabled };
      expect(result).toEqual({ waited: true, counted: true, restored: true, enabled: true });
    } finally {
      release();
      await change.catch(() => undefined);
      await engine.executeRaw("DELETE FROM persistence_topology_changes WHERE digest = 'eval-scan'");
      await store.setBrainEnabled(false);
    }
  }, 120_000);

  test('a harness restore that waits on a committing deactivation keeps the deactivation', async () => {
    const store = await engine.writerReleaseStore();
    await store.setBrainEnabled(true);
    const prior = await engine.pauseManagedPersistence();
    let locked!: () => void;
    let release!: () => void;
    const holding = new Promise<void>(r => { locked = r; });
    const gate = new Promise<void>(r => { release = r; });
    // Another connection deactivates: it holds the brain row lock and records a topology change, then commits.
    const deactivation = (engine as PostgresEngine).transaction(async tx => {
      await tx.executeRaw('SELECT 1 FROM persistence_brain WHERE singleton = 1 FOR UPDATE');
      await tx.executeRaw(`INSERT INTO persistence_topology_changes (principal_id, request_id, digest, operation, source_id, state)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'eval-scan', 'writer_deactivate', '*', 'committed')`);
      locked();
      await gate;
    });
    try {
      await holding;
      const restoring = engine.restoreManagedPersistence(prior);
      let done = false;
      void restoring.then(() => { done = true; }, () => { done = true; });
      await waitForBrainLockWaiter(engine);
      const waited = !done;
      release();
      await deactivation;
      const result = { waited, restored: await restoring, enabled: JSON.parse(await engine.readWriterAdminState()).brain.enabled };
      expect(result).toEqual({ waited: true, restored: false, enabled: false });
    } finally {
      release();
      await deactivation.catch(() => undefined);
      await engine.executeRaw("DELETE FROM persistence_topology_changes WHERE digest = 'eval-scan'");
      await store.setBrainEnabled(false);
    }
  }, 120_000);
});
