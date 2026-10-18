/**
 * Trust policy generation counter (#5575 ENG-11).
 *
 * Protects: trust_policy_state and its deferred, WHEN-guarded triggers bump
 * the generation once per committing transaction on every listed transition
 * (tier change on facts, takes, timeline entries and pages; a page entering
 * or leaving quarantine, a quarantined page inserted, soft-deleted, renamed
 * or deleted; a token or client read floor change; a `trust.%` config
 * insert, update or delete; purge ledger and needs_rederive inserts), never
 * on an ordinary write, and not at all for a rolled-back transaction; the
 * bump runs at commit (inside the transaction the generation has not moved). Fails if a transition
 * stops bumping (caches would serve pre-change content) or an ordinary
 * write starts bumping (every cache would thrash). Runs on PGLite, and on
 * Postgres (direct and transaction-mode PgBouncer) through
 * test/e2e/trust-generation-postgres.test.ts.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { readTrustGeneration, trustCacheIdentity } from '../src/core/eligibility/generation.ts';
import { TRUST_GENERATION_TRIGGERS, TRUST_GENERATION_WHEN } from '../src/core/eligibility/generation-schema.ts';
import { withTrustPromotion, withWriteTrust } from '../src/core/persistence/context.ts';
import { setMinTrust } from '../src/core/trust/min-trust.ts';

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

const gen = async (engine: BrainEngine) => BigInt(await readTrustGeneration(engine));
/** How much `fn` moved the generation. */
async function bumps(engine: BrainEngine, fn: () => Promise<unknown>): Promise<number> {
  const before = await gen(engine);
  await fn();
  return Number((await gen(engine)) - before);
}
const agent = { tier: 'agent_written' as const, origin: { channel: 'test' } };

async function newPage(engine: BrainEngine, frontmatter: Record<string, unknown> = {}): Promise<{ slug: string; id: number }> {
  const slug = `gen/${randomUUID().slice(0, 8)}`;
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages(slug,type,title,compiled_truth,source_id,frontmatter) VALUES($1,'note','T','body','default',$2::text::jsonb) RETURNING id`,
    [slug, JSON.stringify(frontmatter)]);
  return { slug, id: Number(row!.id) };
}
async function newFact(engine: BrainEngine): Promise<number> {
  const { id } = await engine.transaction(tx => withWriteTrust(tx, agent, () => tx.insertFact(
    { fact: `gen fact ${randomUUID().slice(0, 8)}`, kind: 'fact', entity_slug: 'people/alice-example', visibility: 'world', source: 'test' },
    { source_id: 'default' })));
  return id;
}
const promote = (engine: BrainEngine, table: string, id: number) => engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed',
  () => tx.executeRaw(`UPDATE ${table} SET trust_tier = 'user_confirmed' WHERE id = $1`, [id])));

describe('trust generation schema', () => {
  test('every listed table carries a generation trigger, write_gate_receipts included', () => {
    expect(Object.keys(TRUST_GENERATION_WHEN).sort()).toEqual(
      ['access_tokens', 'config', 'fact_purges', 'facts', 'needs_rederive', 'oauth_clients', 'page_purges', 'pages', 'take_purges', 'takes', 'timeline_entries', 'write_gate_receipts']);
  });

  test('the identity changes with the generation, the floor and the activation mode', () => {
    const base = trustCacheIdentity('7', { floor: 'unknown', suppressFlagged: true });
    expect(trustCacheIdentity('8', { floor: 'unknown', suppressFlagged: true })).not.toBe(base);
    expect(trustCacheIdentity('7', { suppressFlagged: true })).not.toBe(base);
    expect(trustCacheIdentity('7', { floor: 'unknown' })).not.toBe(base);
    expect(trustCacheIdentity('7', { floor: 'unknown', suppressFlagged: true })).toBe(base);
  });
});

for (const backendName of testBackends()) {
  const engineOf = () => backends.find(b => b.name === backendName)!.engine;

  describe(`trust generation triggers (${backendName})`, () => {
    test('installed as deferrable constraint triggers on every listed table', async () => {
      const rows = await engineOf().executeRaw<{ tbl: string; tgname: string; deferrable: boolean; deferred: boolean }>(
        `SELECT tgrelid::regclass::text AS tbl, tgname, tgdeferrable AS deferrable, tginitdeferred AS deferred
           FROM pg_trigger WHERE tgname = ANY($1::text[]) ORDER BY 1, 2`, [Object.values(TRUST_GENERATION_TRIGGERS)]);
      const expected = Object.entries(TRUST_GENERATION_WHEN).flatMap(([table, events]) =>
        Object.keys(events).map(event => `${table}.${TRUST_GENERATION_TRIGGERS[event as keyof typeof TRUST_GENERATION_TRIGGERS]}`)).sort();
      expect(rows.map(r => `${r.tbl}.${r.tgname}`).sort()).toEqual(expected);
      expect(rows.every(r => r.deferrable && r.deferred)).toBe(true);
    });

    test('a tier change on facts, takes, timeline entries and pages bumps; ordinary writes do not', async () => {
      const engine = engineOf();
      const factId = await newFact(engine);
      expect(await bumps(engine, () => engine.executeRaw('UPDATE facts SET confidence = 0.5 WHERE id = $1', [factId]))).toBe(0);
      expect(await bumps(engine, () => promote(engine, 'facts', factId))).toBe(1);
      expect(await bumps(engine, () => engine.executeRaw(`UPDATE facts SET trust_tier = 'unknown' WHERE id = $1`, [factId]))).toBe(1);
      expect(await bumps(engine, () => newFact(engine))).toBe(0);

      const page = await newPage(engine);
      expect(await bumps(engine, () => engine.executeRaw(`UPDATE pages SET compiled_truth = 'edited' WHERE id = $1`, [page.id]))).toBe(0);
      expect(await bumps(engine, () => promote(engine, 'pages', page.id))).toBe(1);
      const [take] = await engine.executeRaw<{ id: number }>(
        `INSERT INTO takes(page_id,row_num,claim,kind,holder,weight) VALUES($1,1,'a claim','take','world',0.5) RETURNING id`, [page.id]);
      expect(await bumps(engine, () => promote(engine, 'takes', Number(take!.id)))).toBe(1);
      const [entry] = await engine.executeRaw<{ id: number }>(
        `INSERT INTO timeline_entries(page_id,date,summary) VALUES($1,'2026-01-01','an event') RETURNING id`, [page.id]);
      expect(await bumps(engine, () => promote(engine, 'timeline_entries', Number(entry!.id)))).toBe(1);
    });

    test('quarantine transitions bump: on, off, insert, soft-delete, rename and delete of a quarantined page', async () => {
      const engine = engineOf();
      const q = JSON.stringify({ quarantine: { reason: 'test' } });
      const plain = await newPage(engine);
      expect(await bumps(engine, () => engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || $2::text::jsonb WHERE id = $1`, [plain.id, q]))).toBe(1);
      expect(await bumps(engine, () => engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter - 'quarantine' WHERE id = $1`, [plain.id]))).toBe(1);
      expect(await bumps(engine, () => engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE id = $1`, [plain.id]))).toBe(0);
      let held!: { slug: string; id: number };
      expect(await bumps(engine, async () => { held = await newPage(engine, { quarantine: { reason: 'test' } }); })).toBe(1);
      expect(await bumps(engine, () => engine.executeRaw(`UPDATE pages SET compiled_truth = 'still held' WHERE id = $1`, [held.id]))).toBe(0);
      expect(await bumps(engine, () => engine.executeRaw(`UPDATE pages SET slug = $2 WHERE id = $1`, [held.id, `${held.slug}-moved`]))).toBe(1);
      expect(await bumps(engine, () => engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE id = $1`, [held.id]))).toBe(1);
      expect(await bumps(engine, () => engine.executeRaw(`DELETE FROM pages WHERE id = $1`, [held.id]))).toBe(1);
      expect(await bumps(engine, () => engine.executeRaw(`DELETE FROM pages WHERE id = $1`, [plain.id]))).toBe(0);
    });

    test('read floor changes on tokens and clients bump; other token updates do not', async () => {
      const engine = engineOf();
      const name = `gen-token-${randomUUID().slice(0, 8)}`;
      const [token] = await engine.executeRaw<{ id: string }>(
        `INSERT INTO access_tokens(name, token_hash) VALUES($1, $2) RETURNING id::text AS id`, [name, `hash-${randomUUID()}`]);
      expect(await bumps(engine, () => setMinTrust(engine, token!.id, 'tool_observed'))).toBe(1);
      expect(await bumps(engine, () => setMinTrust(engine, token!.id, 'tool_observed'))).toBe(0);
      expect(await bumps(engine, () => engine.executeRaw(`UPDATE access_tokens SET last_used_at = now() WHERE id = $1::uuid`, [token!.id]))).toBe(0);
      expect(await bumps(engine, () => setMinTrust(engine, token!.id, null))).toBe(1);
      const clientId = `gen-client-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id, client_name, redirect_uris) VALUES($1, 'test client', '{}')`, [clientId]);
      expect(await bumps(engine, () => setMinTrust(engine, clientId, 'operator_curated'))).toBe(1);
    });

    test('trust.% config writes bump; other config keys and same-value writes do not', async () => {
      const engine = engineOf();
      expect(await bumps(engine, () => engine.setConfig('trust.read_policy', 'filter'))).toBe(1);
      expect(await bumps(engine, () => engine.setConfig('trust.read_policy', 'filter'))).toBe(0);
      expect(await bumps(engine, () => engine.setConfig('trust.read_policy', 'label'))).toBe(1);
      expect(await bumps(engine, () => engine.unsetConfig('trust.read_policy'))).toBe(1);
      expect(await bumps(engine, () => engine.setConfig('memory.core.max_chars', '1234'))).toBe(0);
    });

    test('purge ledger and needs_rederive inserts bump', async () => {
      const engine = engineOf();
      const hash = randomUUID();
      expect(await bumps(engine, () => engine.executeRaw(`INSERT INTO fact_purges(source_id, visibility, fact_hash) VALUES('default','world',$1)`, [hash]))).toBe(1);
      expect(await bumps(engine, () => engine.executeRaw(`INSERT INTO take_purges(source_id, claim_hash) VALUES('default',$1)`, [hash]))).toBe(1);
      expect(await bumps(engine, () => engine.executeRaw(`INSERT INTO page_purges(source_id, content_hash, slug) VALUES('default',$1,'gen/purged')`, [hash]))).toBe(1);
      expect(await bumps(engine, () => engine.executeRaw(`INSERT INTO needs_rederive(derived_table, derived_id, source_id, reason) VALUES('facts',$1,'default','test')`, [hash]))).toBe(1);
    });

    test('a write-gate receipt insert, verdict change and delete bump; a re-sighting does not', async () => {
      const engine = engineOf();
      const hash = randomUUID();
      const insert = () => engine.executeRaw(`INSERT INTO write_gate_receipts (target_table, target_id, source_id, content_hash, tier, detector_version, verdict, reason_families)
        VALUES ('facts', '999999', 'default', $1, 'agent_written', 1, 'flag', ARRAY['standing_instruction'])
        ON CONFLICT (target_table, target_id, content_hash, detector_version) DO UPDATE SET last_seen_at = now()`, [hash]);
      expect(await bumps(engine, insert)).toBe(1);
      expect(await bumps(engine, insert)).toBe(0);
      expect(await bumps(engine, () => engine.executeRaw(`UPDATE write_gate_receipts SET verdict = 'quarantine' WHERE content_hash = $1`, [hash]))).toBe(1);
      expect(await bumps(engine, () => engine.executeRaw('DELETE FROM write_gate_receipts WHERE content_hash = $1', [hash]))).toBe(1);
    });

    test('a transaction bumps once however many transitions it commits; a rollback bumps nothing', async () => {
      const engine = engineOf();
      const ids = [await newFact(engine), await newFact(engine), await newFact(engine)];
      expect(await bumps(engine, () => engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', async () => {
        for (const id of ids) await tx.executeRaw(`UPDATE facts SET trust_tier = 'user_confirmed' WHERE id = $1`, [id]);
        await tx.setConfig('trust.agent_activation', 'allow');
      })))).toBe(1);
      expect(await bumps(engine, () => engine.transaction(async tx => {
        const before = await gen(tx);
        await tx.executeRaw(`UPDATE facts SET trust_tier = 'agent_written' WHERE id = $1`, [ids[1]]);
        expect(await gen(tx)).toBe(before);
      }))).toBe(1);
      expect(await bumps(engine, async () => {
        await engine.transaction(async tx => {
          await tx.executeRaw(`UPDATE facts SET trust_tier = 'unknown' WHERE id = $1`, [ids[0]]);
          throw new Error('roll back');
        }).catch(() => undefined);
      })).toBe(0);
      expect(await gen(engine)).toBeGreaterThan(0n);
      await engine.unsetConfig('trust.agent_activation');
    });
  });
}
