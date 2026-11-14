/**
 * Guest notes, slice 1 (GBRA-504): the database records and source rules.
 *
 * Protects: migration v312's guest_sources, guest_marks and guest_promotions
 * tables (RLS on); guest_marks rows refuse UPDATE and leave with their page;
 * the trust trigger's per-source ceiling on pages (INSERT, owner-tier content
 * rewrite, the backfill INSERT and the promotion UPDATE branches); facts,
 * takes and timeline rows refused in a guest source; the writer backstop (a
 * page INSERT or content UPDATE in a guest source needs a principal on the
 * source's writer list, while soft delete, restore, purge and non-content
 * updates pass); a guest source refusing a local_path; and pages outside a
 * guest source keeping their behavior. Runs on PGLite, and on Postgres (direct
 * and transaction-mode PgBouncer) through test/e2e/guest-notes-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withTrustBackfill, withTrustPromotion, withWriteAttribution } from '../src/core/persistence/context.ts';
import type { WriteAttribution } from '../src/core/persistence/attribution.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import type { TrustTier } from '../src/core/trust/tier.ts';

interface Backend { name: string; engine: BrainEngine; close: () => Promise<void> }
const backends: Backend[] = [];
beforeAll(async () => {
  for (const name of testBackends()) {
    if (name === 'pglite') {
      const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
      backends.push({ name, engine, close: () => engine.disconnect() });
    } else {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      backends.push({ name, engine: pg.engine, close: pg.close });
    }
  }
}, 180_000);
afterAll(async () => { for (const b of backends) await b.close(); });

const BROKER: Principal = { kind: 'oauth_client', id: 'client-a' };
const OTHER: Principal = { kind: 'oauth_client', id: 'client-b' };
const OWNER_CLI: Principal = { kind: 'local_cli', id: 'cli-a' };
const as = (principal: Principal, tier?: TrustTier): WriteAttribution =>
  ({ requestId: null, principal, ...(tier ? { trust: { tier, origin: { channel: 'test' } } } : {}) });
const writeAs = <T>(engine: BrainEngine, principal: Principal, tier: TrustTier | undefined, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withWriteAttribution(tx, as(principal, tier), () => fn(tx)));

async function guestSource(engine: BrainEngine, writers: Principal[] = [BROKER]): Promise<string> {
  const id = `guests-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES($1,$1,'{"federated":true,"guest":true}'::jsonb)`, [id]);
  await engine.executeRaw(`INSERT INTO guest_sources(source_id,writers) VALUES($1,$2::text[])`, [id, writers.map(p => `${p.kind}:${p.id}`)]);
  return id;
}
const insertPage = (db: BrainEngine, sourceId: string, slug = `guests/${randomUUID().slice(0, 8)}`, suppliedTier = '') =>
  db.executeRaw<{ id: number; slug: string; trust_tier: string }>(
    `INSERT INTO pages(slug,type,title,compiled_truth,source_id${suppliedTier ? ',trust_tier' : ''}) VALUES($1,'note','T','guest words',$2${suppliedTier ? `,'${suppliedTier}'` : ''}) RETURNING id, slug, trust_tier`,
    [slug, sourceId]).then(rows => rows[0]!);
const tierOf = async (engine: BrainEngine, id: number) =>
  (await engine.executeRaw<{ t: string }>('SELECT trust_tier AS t FROM pages WHERE id=$1', [id]))[0]!.t;
const failure = (promise: Promise<unknown>) => promise.then(() => null, (e: unknown) => String((e as Error)?.message ?? e));

for (const backendName of testBackends()) {
  const engineOf = () => backends.find(b => b.name === backendName)!.engine;

  describe(`guest notes schema (${backendName})`, () => {
    test('v312 creates the three tables with row-level security on', async () => {
      const rows = await engineOf().executeRaw<{ relname: string; relrowsecurity: boolean }>(
        `SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r' ORDER BY relname`,
        [['guest_marks', 'guest_promotions', 'guest_sources']]);
      expect(rows.map(r => r.relname)).toEqual(['guest_marks', 'guest_promotions', 'guest_sources']);
      const [role] = await engineOf().executeRaw<{ bypass: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) AS bypass`);
      if (role!.bypass) expect(rows.every(r => r.relrowsecurity)).toBe(true);
      const [index] = await engineOf().executeRaw<{ def: string }>(
        `SELECT indexdef AS def FROM pg_indexes WHERE tablename = 'guest_marks' AND indexdef LIKE '%audience_member%'`);
      expect(index?.def).toContain('(audience_member, saved_at)');
    });

    test('a guest mark refuses UPDATE, survives soft delete and restore, and leaves with its page', async () => {
      const engine = engineOf();
      const source = await guestSource(engine);
      const page = await writeAs(engine, BROKER, 'agent_written', tx => insertPage(tx, source));
      await engine.executeRaw(`INSERT INTO guest_marks(page_id,source_id,slug_at_write,audience_member,group_slug,sender_label,saved_at,writer_kind,writer_id,request_id)
        VALUES($1,$2,$3,'bob-example','team-a','bob-example',now(),'oauth_client','client-a',NULL)`, [page.id, source, page.slug]);
      expect(await failure(engine.executeRaw(`UPDATE guest_marks SET sender_label='alice-example' WHERE page_id=$1`, [page.id]))).toMatch(/guest_mark_immutable/);
      expect(await engine.softDeletePage(page.slug, { sourceId: source })).toEqual({ slug: page.slug });
      expect(await engine.restorePage(page.slug, { sourceId: source })).toBe(true);
      const [mark] = await engine.executeRaw<{ sender_label: string }>('SELECT sender_label FROM guest_marks WHERE page_id=$1', [page.id]);
      expect(mark?.sender_label).toBe('bob-example');
      await engine.executeRaw('DELETE FROM pages WHERE id=$1', [page.id]);
      expect(await engine.executeRaw('SELECT 1 FROM guest_marks WHERE page_id=$1', [page.id])).toEqual([]);
    });

    test('a guest promotion row leaves with its guest page', async () => {
      const engine = engineOf();
      const source = await guestSource(engine);
      const page = await writeAs(engine, BROKER, 'agent_written', tx => insertPage(tx, source));
      await engine.executeRaw(`INSERT INTO guest_promotions(guest_page_id,target_source_id,target_slug,promoted_by_kind,promoted_by_id) VALUES($1,'default','notes/kept','local_cli','cli-a')`, [page.id]);
      await engine.executeRaw('DELETE FROM pages WHERE id=$1', [page.id]);
      expect(await engine.executeRaw('SELECT 1 FROM guest_promotions WHERE guest_page_id=$1', [page.id])).toEqual([]);
    });

    test('the ceiling caps a page INSERT and an owner-tier content rewrite', async () => {
      const engine = engineOf();
      const source = await guestSource(engine);
      const page = await writeAs(engine, BROKER, 'agent_written', tx => insertPage(tx, source));
      expect(page.trust_tier).toBe('external_untrusted');
      await writeAs(engine, BROKER, 'operator_curated', tx => tx.executeRaw(`UPDATE pages SET compiled_truth='rewritten' WHERE id=$1`, [page.id]));
      expect(await tierOf(engine, page.id)).toBe('external_untrusted');
    });

    test('the ceiling holds on the backfill INSERT and promotion UPDATE branches', async () => {
      const engine = engineOf();
      const source = await guestSource(engine);
      const copied = await engine.transaction(tx => withWriteAttribution(tx, as(BROKER), () =>
        withTrustBackfill(tx, () => insertPage(tx, source, undefined, 'operator_curated'))));
      expect(copied.trust_tier).toBe('external_untrusted');
      await engine.transaction(tx => withTrustPromotion(tx, 'operator_curated', () =>
        tx.executeRaw(`UPDATE pages SET trust_tier='operator_curated' WHERE id=$1`, [copied.id])));
      expect(await tierOf(engine, copied.id)).toBe('external_untrusted');
    });

    test('facts, takes and timeline rows are refused in a guest source; lifecycle updates of older rows pass', async () => {
      const engine = engineOf();
      const source = await guestSource(engine);
      const page = await writeAs(engine, BROKER, 'agent_written', tx => insertPage(tx, source));
      expect(await failure(writeAs(engine, BROKER, 'agent_written', tx => tx.executeRaw(
        `INSERT INTO facts(source_id,entity_slug,fact,kind,source) VALUES($1,'e','claim','fact','test')`, [source])))).toMatch(/guest_page_immutable/);
      expect(await failure(writeAs(engine, BROKER, 'agent_written', tx => tx.executeRaw(
        `INSERT INTO takes(page_id,row_num,claim,kind,holder,weight) VALUES($1,1,'c','take','world',0.5)`, [page.id])))).toMatch(/guest_page_immutable/);
      expect(await failure(writeAs(engine, BROKER, 'agent_written', tx => tx.executeRaw(
        `INSERT INTO timeline_entries(page_id,date,summary,detail,source) VALUES($1,'2026-01-01','s','d','x')`, [page.id])))).toMatch(/guest_page_immutable/);

      const later = `guests-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw(`INSERT INTO sources(id,name) VALUES($1,$1)`, [later]);
      const [fact] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,kind,source) VALUES($1,'e','older claim','fact','test') RETURNING id`, [later]);
      await engine.executeRaw(`INSERT INTO guest_sources(source_id) VALUES($1)`, [later]);
      await engine.executeRaw(`UPDATE facts SET expired_at=now() WHERE id=$1`, [fact!.id]);
      expect(await failure(engine.executeRaw(`UPDATE facts SET fact='changed' WHERE id=$1`, [fact!.id]))).toMatch(/guest_page_immutable/);
    });

    test('only a listed writer creates or rewrites a guest page', async () => {
      const engine = engineOf();
      const source = await guestSource(engine);
      expect(await failure(insertPage(engine, source))).toMatch(/source_writer_restricted/);
      expect(await failure(writeAs(engine, OTHER, 'agent_written', tx => insertPage(tx, source)))).toMatch(/source_writer_restricted/);
      expect(await failure(writeAs(engine, OWNER_CLI, 'operator_curated', tx => insertPage(tx, source)))).toMatch(/source_writer_restricted/);
      const page = await writeAs(engine, BROKER, 'agent_written', tx => insertPage(tx, source));
      expect(await failure(writeAs(engine, OWNER_CLI, 'operator_curated', tx =>
        tx.executeRaw(`UPDATE pages SET compiled_truth='owner rewrite' WHERE id=$1`, [page.id])))).toMatch(/source_writer_restricted/);
      expect(await failure(engine.executeRaw(`UPDATE pages SET frontmatter='{"trust_tier":"user_confirmed"}'::jsonb WHERE id=$1`, [page.id]))).toMatch(/source_writer_restricted/);
      expect(await failure(engine.executeRaw(`UPDATE pages SET source_id='default' WHERE id=$1`, [page.id]))).toMatch(/source_writer_restricted/);
      const outside = await insertPage(engine, 'default', `notes/${randomUUID().slice(0, 8)}`);
      expect(await failure(engine.executeRaw(`UPDATE pages SET source_id=$2 WHERE id=$1`, [outside.id, source]))).toMatch(/source_writer_restricted/);
    });

    test('soft delete, restore, purge and non-content updates of a guest page need no listed writer', async () => {
      const engine = engineOf();
      const source = await guestSource(engine);
      const page = await writeAs(engine, BROKER, 'agent_written', tx => insertPage(tx, source));
      expect(await engine.softDeletePage(page.slug, { sourceId: source })).toEqual({ slug: page.slug });
      expect(await engine.restorePage(page.slug, { sourceId: source })).toBe(true);
      await engine.executeRaw(`UPDATE pages SET updated_at=now(), frontmatter=frontmatter || '{"captured_at":"2026-02-02"}'::jsonb WHERE id=$1`, [page.id]);
      expect(await tierOf(engine, page.id)).toBe('external_untrusted');
      await engine.executeRaw('DELETE FROM pages WHERE id=$1', [page.id]);
      expect(await engine.executeRaw('SELECT 1 FROM pages WHERE id=$1', [page.id])).toEqual([]);
    });

    test('a guest source refuses a local_path', async () => {
      const engine = engineOf();
      const source = await guestSource(engine);
      expect(await failure(engine.executeRaw(`UPDATE sources SET local_path='/tmp/guests-a' WHERE id=$1`, [source]))).toMatch(/guest_source_database_only/);
      const pathed = `source-a-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw(`INSERT INTO sources(id,name,local_path) VALUES($1,$1,'/tmp/source-a')`, [pathed]);
      expect(await failure(engine.executeRaw(`INSERT INTO guest_sources(source_id) VALUES($1)`, [pathed]))).toMatch(/guest_source_database_only/);
    });

    test('pages outside a guest source behave as before', async () => {
      const engine = engineOf();
      await guestSource(engine);
      const plain = await insertPage(engine, 'default', `notes/${randomUUID().slice(0, 8)}`);
      expect(plain.trust_tier).toBe('unknown');
      await writeAs(engine, OWNER_CLI, 'operator_curated', tx => tx.executeRaw(`UPDATE pages SET compiled_truth='owner edit' WHERE id=$1`, [plain.id]));
      expect(await tierOf(engine, plain.id)).toBe('operator_curated');
      const [fact] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,kind,source) VALUES('default','e','claim','fact','test') RETURNING id`);
      expect(fact!.id).toBeGreaterThan(0);
      await engine.executeRaw(`INSERT INTO timeline_entries(page_id,date,summary,detail,source) VALUES($1,'2026-01-01','s','d','x')`, [plain.id]);
    });
  });
}
