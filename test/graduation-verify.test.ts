/**
 * Graduation verify (src/core/persistence/graduation-verify.ts).
 *
 * Protects: a faithful copy of a brain with real persistence history (Lane A's
 * history fixture plus an active job, an orphaned running effect, a vector
 * and text keys that differ by case, '-' versus '_' and non-ASCII) verifies
 * green against a fenced target, with the inventory's transforms applied to
 * the source side; each kind of damage is reported with its table and, for
 * content, the first differing key and column: an edited row, a lost row, an
 * orphan FK, a disabled trigger, a missing fence, a lowered sequence, a source
 * written after the copy, an extra relation and a failing doctor check; the
 * replay probe resubmits the drained request through admission inside a
 * rolled-back transaction and reports passed, failed or not_available
 * (no caller input, revoked principal, archived source, changed topology).
 * Fails when: verify misses one of those, or the replay probe leaves a row,
 * a counter or the enabled flag behind.
 * The copy here is a minimal test copier (row-by-row, triggers bypassed with
 * session_replication_role); the production copier is graduation-copy.ts.
 * Runs PGLite -> PGLite, and PGLite -> Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import type { TableReceipt } from '../src/core/persistence/engine-graduation.types.ts';
import { copyOrder, GRADUATION_INVENTORY } from '../src/core/persistence/graduation-inventory.ts';
import { DIGEST_SESSION_SETTINGS, digestTable, quoteIdent, tableColumns } from '../src/core/persistence/graduation-digest.ts';
import { GRADUATION_FENCE_TRIGGER, replayProbe, verifyGraduation, type VerifyContext } from '../src/core/persistence/graduation-verify.ts';
import { buildHistoryFixture, type HistoryFixture } from '../scripts/persistence/history-fixture.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const RUN_ID = randomUUID();
const home = mkdtempSync(join(tmpdir(), 'gbrain-graduation-verify-'));
let source: PGLiteEngine;
let liteTarget: PGLiteEngine;
let fixture: HistoryFixture;
let callerIntent: Record<string, unknown>;
let receipts: TableReceipt[];
const targets: Array<{ name: string; engine: BrainEngine }> = [];
let closePostgres: (() => Promise<void>) | undefined;

const CONFIG_KEYS = ['graduation-Key', 'graduation-key', 'graduation_key', 'graduation key', 'graduation-ünï', 'Graduation-Ω'];

async function withProtocol(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<void>): Promise<void> {
  await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await fn(tx); });
}

/** Writes on the fenced target: the run's GUC, the persistence protocol and user triggers bypassed. */
async function targetWrite(target: BrainEngine, sql: string, params: unknown[] = []): Promise<void> {
  await target.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.graduation_run',$1,true), set_config('session_replication_role','replica',true), set_config('gbrain.persistence_protocol','2',true)", [RUN_ID]);
    await tx.executeRaw(sql, params);
  });
}

async function installFence(target: BrainEngine): Promise<void> {
  await target.executeRaw(`CREATE OR REPLACE FUNCTION gbrain_graduation_fence_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF current_setting('gbrain.graduation_run', true) IS DISTINCT FROM '${RUN_ID}' THEN RAISE EXCEPTION 'graduation_in_progress: fenced'; END IF;
    RETURN NULL; END $$`);
  for (const entry of await copyOrder(target)) await fenceTable(target, entry.relation);
}
async function fenceTable(target: BrainEngine, relation: string): Promise<void> {
  await target.executeRaw(`CREATE TRIGGER ${GRADUATION_FENCE_TRIGGER} BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${quoteIdent(relation)}
    FOR EACH STATEMENT EXECUTE FUNCTION gbrain_graduation_fence_probe()`);
  await target.executeRaw(`ALTER TABLE ${quoteIdent(relation)} ENABLE ALWAYS TRIGGER ${GRADUATION_FENCE_TRIGGER}`);
}

/** Minimal copier: every carry/rebind row as text, transforms applied, triggers bypassed, then sequence positions. */
async function testCopy(target: BrainEngine): Promise<void> {
  const order = await copyOrder(source);
  const plans = await Promise.all(order.map(async entry => ({ entry, columns: (await tableColumns(source, entry.relation)).filter(c => !c.generated) })));
  const data = await source.transaction(async tx => {
    await tx.executeRaw(DIGEST_SESSION_SETTINGS);
    const out: Record<string, Array<Record<string, string | null>>> = {};
    for (const { entry, columns } of plans) {
      const transforms = new Map(entry.transforms.map(t => [t.column, t.expression!]));
      out[entry.relation] = await tx.executeRaw(`SELECT ${columns.map((c, i) => `(${transforms.get(c.name) ?? quoteIdent(c.name)})::text AS c${i}`).join(', ')}
        FROM ${quoteIdent(entry.relation)}${entry.rowFilter ? ` WHERE ${entry.rowFilter}` : ''}`);
    }
    return out;
  });
  await target.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.graduation_run',$1,true), set_config('session_replication_role','replica',true)", [RUN_ID]);
    for (const { entry } of [...plans].reverse()) await tx.executeRaw(`DELETE FROM ${quoteIdent(entry.relation)}${entry.rowFilter ? ` WHERE ${entry.rowFilter}` : ''}`);
    for (const { entry, columns } of plans) {
      const insert = `INSERT INTO ${quoteIdent(entry.relation)} (${columns.map(c => quoteIdent(c.name)).join(', ')})
        VALUES (${columns.map((c, i) => `$${i + 1}::text::${c.type}`).join(', ')})`;
      for (const row of data[entry.relation]!) await tx.executeRaw(insert, columns.map((_, i) => row[`c${i}`]));
    }
  });
  const seqs = await source.executeRaw<{ seq: string }>(`SELECT c.relname AS seq FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='S' AND n.nspname=current_schema() AND c.relname <> 'planner_stats_deltas_id_seq'`);
  for (const { seq } of seqs) {
    const [pos] = await source.executeRaw<{ v: string; called: unknown }>(`SELECT last_value::text AS v, is_called AS called FROM ${quoteIdent(seq)}`);
    await target.executeRaw('SELECT setval($1::regclass, $2::bigint, $3::boolean)', [quoteIdent(seq), pos!.v, pos!.called === true || pos!.called === 't']);
  }
}

function context(overrides: Partial<VerifyContext> = {}): VerifyContext {
  return { inventory: GRADUATION_INVENTORY, sourceReceipts: receipts, replayRequestId: fixture.queuedRequestId, replayCallerIntent: callerIntent,
    runId: RUN_ID, runDoctor: async () => [], ...overrides };
}

beforeAll(async () => {
  source = new PGLiteEngine();
  await source.connect({});
  await source.initSchema();
  liteTarget = new PGLiteEngine();
  await liteTarget.connect({});
  await liteTarget.initSchema();
  const databaseUrl = process.env.DATABASE_URL;
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    fixture = await buildHistoryFixture(source, { pages: 12, seed: 5, sources: 2, worktrees: 1, root: join(home, 'checkouts') });
  });
  const [queued] = await source.executeRaw<{ intent: unknown }>('SELECT intent FROM persistence_requests WHERE request_id=$1::uuid', [fixture.queuedRequestId]);
  callerIntent = (typeof queued!.intent === 'string' ? JSON.parse(queued!.intent) : queued!.intent) as Record<string, unknown>;
  await withProtocol(source, async tx => {
    await tx.executeRaw(`UPDATE persistence_requests SET state='committed', outcome='{"status":"committed","drained":true}'::jsonb, completed_at=now()
      WHERE request_id=$1::uuid`, [fixture.queuedRequestId]);
    await tx.executeRaw(`UPDATE persistence_effects SET state='running', execution_token=gen_random_uuid(), claim_expires_at=now() - interval '1 minute'
      WHERE id = (SELECT min(id) FROM persistence_effects WHERE state='committed')`);
  });
  await source.executeRaw(`INSERT INTO minion_jobs (name, status, submission_authority) VALUES ('graduation-verify-probe', 'waiting', '{}'::jsonb)`);
  await source.executeRaw(`UPDATE minion_jobs SET status='active', claim_generation=1, lock_token='lease-token', lock_until=now() + interval '1 minute',
    started_at=now(), timeout_at=now() + interval '1 hour', attempts_started=1 WHERE name='graduation-verify-probe'`);
  for (const key of CONFIG_KEYS) await source.executeRaw('INSERT INTO config(key, value) VALUES ($1, $2)', [key, `value of ${key}`]);
  await source.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const [dims] = await source.executeRaw<{ n: number }>("SELECT atttypmod AS n FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
  await source.executeRaw(`UPDATE content_chunks SET embedding = (SELECT array_agg(sin(g * id)::real)::vector FROM generate_series(1, $1::int) g)
    WHERE id IN (SELECT id FROM content_chunks ORDER BY id LIMIT 3)`, [dims!.n]);
  await source.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  receipts = [];
  for (const entry of await copyOrder(source)) receipts.push(await digestTable(source, entry, { applyTransforms: true }));

  targets.push({ name: 'pglite', engine: liteTarget });
  if (databaseUrl) {
    const pg = await isolatedPersistencePostgres(databaseUrl);
    targets.push({ name: 'postgres', engine: pg.engine });
    closePostgres = pg.close;
  }
  for (const { engine } of targets) { await installFence(engine); await testCopy(engine); }
}, 300_000);
afterAll(async () => {
  await source.disconnect();
  await liteTarget.disconnect();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

describe('verifyGraduation', () => {
  test('a faithful, fenced copy of a brain with history verifies green, with transforms applied to the source side', async () => {
    for (const { name, engine } of targets) {
      const [before] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests');
      const result = await verifyGraduation({ source, target: engine }, context());
      expect({ name, failures: result.failures }).toEqual({ name, failures: [] });
      expect(result.ok).toBe(true);
      expect(result.replay).toEqual({ status: 'passed', requestId: fixture.queuedRequestId });
      expect(result.tables.map(t => t.relation)).toEqual((await copyOrder(source)).map(e => e.relation));
      expect(result.tables.find(t => t.relation === 'config')!.rows).toBeGreaterThan(CONFIG_KEYS.length);
      const [job] = await engine.executeRaw<{ status: string; lock_token: string | null }>("SELECT status, lock_token FROM minion_jobs WHERE name='graduation-verify-probe'");
      expect(job).toEqual({ status: 'waiting', lock_token: null });
      expect((await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE state='running'")).length).toBe(0);
      expect(await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL')).toEqual([{ n: 3 }]);
      expect((await engine.executeRaw<{ key: string }>('SELECT key FROM config WHERE key = ANY($1::text[]) ORDER BY key COLLATE "C"', [CONFIG_KEYS])).map(r => r.key))
        .toEqual([...CONFIG_KEYS].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
      expect((await engine.executeRaw<{ value: string }>("SELECT value FROM config WHERE key='engine'")).every(r => r.value === engine.kind)).toBe(true);
      const [after] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests');
      expect(after!.n).toBe(before!.n);
      const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain');
      expect(brain!.enabled).toBe(false);
    }
  }, 120_000);

  test('each kind of damage is reported with its table, first key and column', async () => {
    for (const { name, engine } of targets) {
      const [page] = await engine.executeRaw<{ id: number; title: string }>('SELECT id, title FROM pages ORDER BY id LIMIT 1');
      await targetWrite(engine, "UPDATE pages SET title = title || ' (edited)' WHERE id=$1", [page!.id]);
      await targetWrite(engine, 'DELETE FROM timeline_entries WHERE id = (SELECT max(id) FROM timeline_entries)');
      await targetWrite(engine, "INSERT INTO tags (page_id, tag) VALUES (2147483000, 'orphan')");
      await engine.executeRaw('ALTER TABLE pages DISABLE TRIGGER bump_page_generation_trg');
      await engine.executeRaw(`DROP TRIGGER ${GRADUATION_FENCE_TRIGGER} ON links`);
      await engine.executeRaw("SELECT setval('pages_id_seq', 1)");
      await engine.executeRaw('CREATE TABLE graduation_verify_stray (id int PRIMARY KEY)');
      await source.executeRaw("UPDATE config SET value='changed after copy' WHERE key='graduation-key'");
      try {
        const result = await verifyGraduation({ source, target: engine }, context({ runDoctor: async () => ['embedding_coverage'] }));
        expect(result.ok).toBe(false);
        const has = (match: Record<string, unknown>) => expect({ name, failures: result.failures }).toMatchObject({ name, failures: expect.arrayContaining([expect.objectContaining(match)]) });
        has({ relation: 'pages', kind: 'digest', firstKey: JSON.stringify([String(page!.id)]), column: 'title' });
        has({ relation: 'timeline_entries', kind: 'count' });
        has({ relation: 'timeline_entries', kind: 'digest' });
        has({ relation: 'tags', kind: 'fk', column: 'page_id', firstKey: '["2147483000"]' });
        has({ relation: 'pages', kind: 'trigger', detail: expect.stringContaining('bump_page_generation_trg') });
        has({ relation: 'links', kind: 'trigger', detail: expect.stringContaining('missing') });
        has({ relation: 'pages_id_seq', kind: 'sequence' });
        has({ relation: `(${engine.kind} schema)`, kind: 'relation_set', detail: expect.stringContaining('graduation_verify_stray') });
        has({ relation: 'config', kind: 'digest', detail: expect.stringContaining('source changed since the copy') });
        has({ relation: 'config', kind: 'digest', firstKey: '["graduation-key"]', column: 'value' });
        has({ relation: '(target doctor)', kind: 'doctor', detail: expect.stringContaining('embedding_coverage') });
        expect(result.doctorFailingChecks).toEqual(['embedding_coverage']);
      } finally {
        await source.executeRaw("UPDATE config SET value='value of graduation-key' WHERE key='graduation-key'");
        await engine.executeRaw('DROP TABLE graduation_verify_stray');
        await engine.executeRaw('ALTER TABLE pages ENABLE TRIGGER bump_page_generation_trg');
        await fenceTable(engine, 'links');
        await testCopy(engine);
      }
      expect((await verifyGraduation({ source, target: engine }, context())).failures).toEqual([]);
    }
  }, 240_000);

  test('after cutover the fence must be gone; missing receipts are failures', async () => {
    for (const { name, engine } of targets) {
      const result = await verifyGraduation({ source, target: engine }, context({ expectFence: false, sourceReceipts: receipts.filter(r => r.relation !== 'pages') }));
      expect({ name, fenceFailures: result.failures.filter(f => f.kind === 'trigger' && f.detail.includes('still installed')).length > 0 }).toEqual({ name, fenceFailures: true });
      expect(result.failures).toContainEqual(expect.objectContaining({ relation: 'pages', kind: 'digest', detail: expect.stringContaining('No copy-time source receipt') }));
    }
  }, 120_000);
});

describe('replayProbe', () => {
  test('resubmits the drained request with the original caller input and leaves nothing behind', async () => {
    for (const { engine } of targets) {
      const reordered = Object.fromEntries(Object.entries(callerIntent).reverse());
      expect(await replayProbe(engine, fixture.queuedRequestId, reordered, { sourceEnabled: true, runId: RUN_ID }))
        .toEqual({ status: 'passed', requestId: fixture.queuedRequestId });
      const changed = await replayProbe(engine, fixture.queuedRequestId, { ...callerIntent, content: 'different' }, { sourceEnabled: true, runId: RUN_ID });
      expect(changed).toMatchObject({ status: 'failed', detail: expect.stringContaining('used for a different write') });
      const unfenced = await replayProbe(engine, fixture.queuedRequestId, callerIntent, { sourceEnabled: true });
      expect(unfenced).toMatchObject({ status: 'failed', detail: expect.stringContaining('graduation_in_progress') });
      expect(await replayProbe(engine, fixture.queuedRequestId, undefined)).toEqual({ status: 'not_available', reason: 'no_caller_input' });
      expect(await replayProbe(engine, randomUUID(), callerIntent)).toMatchObject({ status: 'failed', detail: expect.stringContaining('not on the target') });
      const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain');
      expect(brain!.enabled).toBe(false);
    }
  }, 120_000);

  test('a revoked principal, an archived source and a changed topology report not_available', async () => {
    for (const { engine } of targets) {
      const [row] = await engine.executeRaw<{ principal_id: string; source_id: string }>('SELECT principal_id, source_id FROM persistence_requests WHERE request_id=$1::uuid', [fixture.queuedRequestId]);
      const probe = () => replayProbe(engine, fixture.queuedRequestId, callerIntent, { sourceEnabled: true, runId: RUN_ID });
      await targetWrite(engine, 'UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [row!.principal_id]);
      try { expect(await probe()).toEqual({ status: 'not_available', reason: 'revoked_principal' }); }
      finally { await targetWrite(engine, 'UPDATE persistence_local_writers SET revoked_at=NULL WHERE id=$1::uuid', [row!.principal_id]); }
      await targetWrite(engine, 'UPDATE sources SET archived=true WHERE id=$1', [row!.source_id]);
      try { expect(await probe()).toEqual({ status: 'not_available', reason: 'archived_source' }); }
      finally { await targetWrite(engine, 'UPDATE sources SET archived=false WHERE id=$1', [row!.source_id]); }
      await targetWrite(engine, 'UPDATE persistence_source_bindings SET topology_generation=topology_generation+1 WHERE source_id=$1', [row!.source_id]);
      try { expect(await probe()).toEqual({ status: 'not_available', reason: 'source_changed' }); }
      finally { await targetWrite(engine, 'UPDATE persistence_source_bindings SET topology_generation=topology_generation-1 WHERE source_id=$1', [row!.source_id]); }
      expect(await probe()).toEqual({ status: 'passed', requestId: fixture.queuedRequestId });
    }
  }, 120_000);

  test('without a named request verify picks the newest uncompacted terminal request and needs its caller input', async () => {
    const { engine } = targets[0]!;
    const result = await verifyGraduation({ source, target: engine }, context({ replayRequestId: undefined, replayCallerIntent: undefined }));
    expect(result.replay).toEqual({ status: 'not_available', reason: 'no_caller_input' });
    expect(result.failures).toEqual([]);
  }, 120_000);
});
