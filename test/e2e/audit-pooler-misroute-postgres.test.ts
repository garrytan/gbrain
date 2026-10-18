/**
 * #6543 (I1): scripts/audit-pooler-misroute.ts on Postgres.
 *
 * Protects: a seeded misrouted effect (another request's source identity) and
 * a request carrying another source's incarnation or page are reported as
 * `mismatch` with the conflicting values; a clean window reports none and
 * counts every row verified; a row updated while the audit runs (between two
 * batches) is `unknown` (changed_during_audit), never `mismatch`, even when the
 * update makes it look misrouted; coverage gaps (compacted history, a removed
 * page, effects from before the identity columns) are `unknown`, never clean;
 * every statement the audit sends is a read inside a READ ONLY transaction; a
 * transaction-mode URL is refused and the session pooler port is accepted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { auditConnectionOptions, auditPoolerMisroute, refuseTransactionPoolerUrl } from '../../scripts/audit-pooler-misroute.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

let engine: PostgresEngine;
let databaseUrl: string;
let close: () => Promise<void>;
let a: { id: string; incarnation: string };
let b: { id: string; incarnation: string };

beforeAll(async () => {
  const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
  engine = pg.engine; databaseUrl = pg.databaseUrl; close = pg.close;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const source = async (id: string) => {
    const [row] = await engine.executeRaw<{ incarnation: string }>("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}') RETURNING incarnation::text", [id]);
    return { id, incarnation: row!.incarnation };
  };
  a = await source(`audit-a-${randomUUID().slice(0, 8)}`);
  b = await source(`audit-b-${randomUUID().slice(0, 8)}`);
}, 120_000);
afterAll(async () => { await close?.(); });

type Window = { since: Date; until: Date };
/** The window is read from the database clock, so each test sees only its own rows. */
const dbNow = async () => new Date((await engine.executeRaw<{ now: string }>('SELECT clock_timestamp()::text AS now'))[0]!.now);
async function window<T>(fn: () => Promise<T>): Promise<Window & { value: T }> {
  const since = await dbNow();
  const value = await fn();
  return { since, until: new Date((await dbNow()).getTime() + 1), value };
}
async function request(src: { id: string; incarnation: string }, opts: { slug?: string; incarnation?: string; pageId?: number | null; compacted?: boolean } = {}) {
  const [row] = await engine.executeRaw<{ id: string; request_id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,
      slug,page_id,digest,authority,intent_bytes,terminal_reservation,state,compacted)
    VALUES('local_cli','audit',gen_random_uuid(),'put_page',$1,$2::uuid,$3,$4,'d','{}'::jsonb,1,16384,'committed',$5) RETURNING id::text, request_id::text`,
  [src.id, opts.incarnation ?? src.incarnation, opts.slug ?? `audit/${randomUUID().slice(0, 8)}`, opts.pageId ?? null, opts.compacted ?? false]);
  return row!;
}
async function effect(requestRowId: string, identity: { source_id: string | null; source_incarnation: string | null }) {
  const [row] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation)
    VALUES($1::uuid,$2,'{}'::jsonb,$3,$4::uuid) RETURNING id::text`, [requestRowId, `embed-${randomUUID().slice(0, 6)}`, identity.source_id, identity.source_incarnation]);
  return row!.id;
}
async function page(src: { id: string }, slug: string) {
  const [row] = await engine.executeRaw<{ id: number }>("INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,$2,'note',$2,'') RETURNING id", [src.id, slug]);
  return row!.id;
}
async function audit(w: Window, opts: { batchSize?: number; onBatch?: (index: number) => Promise<void> } = {}) {
  const statements: string[] = [];
  const sql = postgres(databaseUrl, { ...auditConnectionOptions(), debug: (_connection: number, query: string) => { statements.push(query); } } as Parameters<typeof postgres>[1]);
  try {
    return { report: await auditPoolerMisroute(sql as never, { since: w.since, until: w.until, batchSize: opts.batchSize ?? 2, batchTimeoutMs: 10_000, onBatch: opts.onBatch }), statements };
  } finally { await sql.end({ timeout: 5 }); }
}
const readOnly = (statements: string[]) => {
  for (const statement of statements) expect(statement.trim()).toMatch(/^(begin isolation level repeatable read read only|SELECT\b|commit|rollback)/i);
};

describe('audit-pooler-misroute', () => {
  test('a clean window reports no mismatch and verifies every row, over several batches, with reads only', async () => {
    const w = await window(async () => {
      for (let i = 0; i < 3; i++) {
        const r = await request(a);
        await effect(r.id, { source_id: a.id, source_incarnation: a.incarnation });
      }
      const slug = `audit/page-${randomUUID().slice(0, 8)}`;
      await request(b, { slug, pageId: await page(b, slug) });
    });
    const { report, statements } = await audit(w);
    expect(report.mismatch).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.verified_ok).toEqual({ requests: 4, effects: 3 });
    expect(report.batches).toBeGreaterThan(2);
    expect(report.snapshot).toBe('per_batch');
    expect(report.disclaimer).toContain('no global snapshot');
    readOnly(statements);
  }, 60_000);

  test('seeded misroutes are mismatches with the conflicting values; coverage gaps are unknown', async () => {
    const w = await window(async () => {
      const victim = await request(a);
      const misroutedEffect = await effect(victim.id, { source_id: b.id, source_incarnation: b.incarnation });
      const foreignIncarnation = await request(a, { incarnation: b.incarnation });
      const foreignPage = await request(a, { pageId: await page(b, `audit/foreign-${randomUUID().slice(0, 8)}`) });
      const compacted = await request(a, { compacted: true });
      const removedPage = await request(a, { pageId: 2_000_000_000 });
      const legacy = await request(a);
      const legacyEffect = await effect(legacy.id, { source_id: null, source_incarnation: null });
      return { victim, misroutedEffect, foreignIncarnation, foreignPage, compacted, removedPage, legacy, legacyEffect };
    });
    const ids = w.value;
    const { report, statements } = await audit(w);
    expect(report.mismatch).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'persistence_effects', id: ids.misroutedEffect, request_id: ids.victim.request_id, field: 'source_id', value: b.id, expected: a.id }),
      expect.objectContaining({ table: 'persistence_effects', id: ids.misroutedEffect, field: 'source_incarnation', value: b.incarnation, expected: a.incarnation }),
      expect.objectContaining({ table: 'persistence_requests', id: ids.foreignIncarnation.id, field: 'source_incarnation', value: b.incarnation, belongs_to: { table: 'sources', id: b.id } }),
      expect.objectContaining({ table: 'persistence_requests', id: ids.foreignPage.id, field: 'page_id', belongs_to: { table: 'sources', id: b.id } }),
    ]));
    expect(report.mismatch).toHaveLength(4);
    expect(report.unknown).toEqual(expect.arrayContaining([
      { table: 'persistence_requests', id: ids.compacted.id, request_id: ids.compacted.request_id, reasons: ['compacted_history'] },
      { table: 'persistence_requests', id: ids.removedPage.id, request_id: ids.removedPage.request_id, reasons: ['page_removed'] },
      { table: 'persistence_effects', id: ids.legacyEffect, request_id: ids.legacy.request_id, reasons: ['effect_identity_unset'] },
    ]));
    expect(report.unknown_by_reason).toEqual({ compacted_history: 1, page_removed: 1, effect_identity_unset: 1 });
    expect(report.verified_ok).toEqual({ requests: 2, effects: 0 });
    readOnly(statements);
  }, 60_000);

  test('a row updated between batches is unknown (changed_during_audit), never a mismatch, even when the update makes it look misrouted', async () => {
    const w = await window(async () => {
      const rows = [];
      for (let i = 0; i < 4; i++) rows.push(await request(a));
      const effects = [];
      for (const r of rows) effects.push(await effect(r.id, { source_id: a.id, source_incarnation: a.incarnation }));
      return { rows, effects };
    });
    const late = w.value.effects[3]!;
    const { report } = await audit(w, { batchSize: 2, onBatch: async index => {
      // After the first batch committed: a concurrent writer rewrites an effect the audit has not read yet.
      if (index === 1) await engine.executeRaw('UPDATE persistence_effects SET source_id=$1, source_incarnation=$2::uuid, updated_at=now() WHERE id=$3', [b.id, b.incarnation, late]);
    } });
    expect(report.mismatch).toEqual([]);
    expect(report.unknown).toEqual([{ table: 'persistence_effects', id: late, request_id: w.value.rows[3]!.request_id, reasons: ['changed_during_audit'] }]);
    expect(report.verified_ok).toEqual({ requests: 4, effects: 3 });
  }, 60_000);

  test('a transaction-mode URL is refused; a direct URL and the session pooler port are accepted', () => {
    expect(refuseTransactionPoolerUrl('postgresql://u:p@pooler.example.invalid:6543/postgres')).toContain('port 6543');
    expect(refuseTransactionPoolerUrl('postgresql://u:p@db.example.invalid:5432/postgres?prepare=false')).toContain('prepare=false');
    expect(refuseTransactionPoolerUrl('postgresql://u:p@pooler.example.invalid:5432/postgres')).toBeNull();
    expect(refuseTransactionPoolerUrl('postgresql://u:p@db.example.invalid/postgres')).toBeNull();
    expect(refuseTransactionPoolerUrl('not a url')).toContain('not a valid');
  });
});
