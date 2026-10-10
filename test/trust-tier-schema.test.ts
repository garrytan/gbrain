/**
 * Memory trust tiers in the database (#5575: A1, A2, CEO-10, CEO-12, CEO-16,
 * CEO-1, ENG-2, ENG-10, ENG-13, ENG-18).
 *
 * Protects: the BEFORE ROW tier trigger on facts, takes, timeline_entries and
 * pages (INSERT forced to the writer's tier or `unknown`; content rewrites
 * restamp for owner writers and take min(prior, writer) otherwise; unchanged
 * content keeps the tier without error; a direct raise is refused with
 * trust_raise_refused; the backfill exception), the TRUST_CONTENT_COLUMNS
 * classification and its drift against attribution and the page revision
 * tuple, the trigger firing last, the page_versions snapshot, min(outer,
 * inner) nesting through the attribution seam with the group per-member reset,
 * the managed-writer guard treating a page or fact tier change as guarded
 * content, the write_origin JSONB binding, and get_write_attribution's trust
 * fields. Fails if any of those regress on either engine. Runs on PGLite, and
 * on Postgres (direct and transaction-mode PgBouncer) through
 * test/e2e/trust-tier-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { TRUST_CONTENT_COLUMNS, TRUST_EPHEMERAL_FRONTMATTER_KEYS, TRUST_TABLES, TRUST_TIER_TRIGGER, TRUST_TIER_TRIGGER_PREDECESSORS } from '../src/core/trust/schema.ts';
import { WRITE_ATTRIBUTION_CONTENT_COLUMNS } from '../src/core/persistence/attribution-schema.ts';
import { PAGE_STATE_SCHEMA_SQL } from '../src/core/page-state/schema.ts';
import { HASH_EPHEMERAL_FRONTMATTER_KEYS } from '../src/core/utils.ts';
import { QUARANTINE_OVERRIDE_KEY } from '../src/core/quarantine-override.ts';
import {
  currentWriteTrust, setMemberAttribution, withCoordinatedWrite, withTrustBackfill, withTrustPromotion, withWriteAttribution, withWriteTrust,
} from '../src/core/persistence/context.ts';
import { databaseRefusal } from '../src/core/persistence/publication-failure.ts';
import { trustRaiseRefusal } from '../src/core/trust/confirm.ts';
import { effectiveWriteTrust, type TaintInput, type TrustTier, type WriteTrust } from '../src/core/trust/tier.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { WriteAttribution } from '../src/core/persistence/attribution.ts';

describe('TRUST_CONTENT_COLUMNS (ENG-2)', () => {
  test('facts, takes and timeline content is attribution content; the rest of attribution content is lifecycle or placement', () => {
    const lifecycle: Record<'facts' | 'takes' | 'timeline_entries', string[]> = {
      facts: ['id', 'source_id', 'visibility', 'notability', 'valid_from', 'valid_until', 'expired_at', 'superseded_by', 'consolidated_at',
        'consolidated_into', 'source', 'source_session', 'confidence', 'created_at', 'row_num', 'source_markdown_slug', 'value_hash', 'dim_status', 'attributed_to'],
      takes: ['id', 'page_id', 'row_num', 'weight', 'since_date', 'until_date', 'source', 'superseded_by', 'active', 'resolved_at', 'resolved_outcome',
        'resolved_value', 'resolved_unit', 'resolved_source', 'resolved_by', 'created_at', 'resolved_quality'],
      timeline_entries: ['id', 'page_id', 'source', 'event_page_id', 'created_at'],
    };
    for (const table of ['facts', 'takes', 'timeline_entries'] as const) {
      const content = TRUST_CONTENT_COLUMNS[table];
      expect({ table, outside: content.filter(c => !WRITE_ATTRIBUTION_CONTENT_COLUMNS[table].includes(c)) }).toEqual({ table, outside: [] });
      expect({ table, rest: WRITE_ATTRIBUTION_CONTENT_COLUMNS[table].filter(c => !content.includes(c)).sort() })
        .toEqual({ table, rest: [...lifecycle[table]].sort() });
    }
  });

  test('pages use the pages_knowledge_revision tuple minus hash-ephemeral frontmatter keys', () => {
    const tuple = /IF \(NEW\.source_id,([^)]*)\)\s*IS DISTINCT FROM/.exec(PAGE_STATE_SCHEMA_SQL)?.[0] ?? '';
    const columns = [...tuple.matchAll(/NEW\.([a-z_]+)/g)].map(m => m[1]);
    expect(columns.length).toBeGreaterThan(5);
    expect([...TRUST_CONTENT_COLUMNS.pages]).toEqual(columns);
    expect([...TRUST_EPHEMERAL_FRONTMATTER_KEYS].sort()).toEqual([...HASH_EPHEMERAL_FRONTMATTER_KEYS.filter(key => key !== 'trust_tier'), QUARANTINE_OVERRIDE_KEY].sort());
    expect(HASH_EPHEMERAL_FRONTMATTER_KEYS).toContain('trust_tier');
    expect(TRUST_EPHEMERAL_FRONTMATTER_KEYS).not.toContain('trust_tier');
  });
});

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

const trust = (tier: TrustTier, channel = 'test'): WriteTrust => ({ tier, origin: { channel } });
const attribution = (t?: WriteTrust): WriteAttribution => ({ requestId: null, principal: { kind: 'application', id: 'host:trust-test' }, ...(t ? { trust: t } : {}) });
async function page(engine: BrainEngine, slug: string): Promise<{ id: number; trust_tier: string; write_origin: unknown }> {
  const [row] = await engine.executeRaw<{ id: number; trust_tier: string; write_origin: unknown }>('SELECT id, trust_tier, write_origin FROM pages WHERE slug=$1', [slug]);
  return row!;
}
const tierOf = async (engine: BrainEngine, table: string, id: number) =>
  (await engine.executeRaw<{ t: string }>(`SELECT trust_tier AS t FROM ${table} WHERE id=$1`, [id]))[0]!.t;
async function newPage(engine: BrainEngine, t?: WriteTrust, frontmatter: Record<string, unknown> = {}): Promise<{ slug: string; id: number }> {
  const slug = `trust/${randomUUID().slice(0, 8)}`;
  const insert = (db: BrainEngine) => db.executeRaw(`INSERT INTO pages(slug,type,title,compiled_truth,source_id,frontmatter) VALUES($1,'note','T','body','default',$2::text::jsonb)`,
    [slug, JSON.stringify(frontmatter)]);
  if (t) await engine.transaction(tx => withWriteTrust(tx, t, () => insert(tx))); else await insert(engine);
  return { slug, id: (await page(engine, slug)).id };
}
const inTrust = (engine: BrainEngine, t: WriteTrust, fn: (tx: BrainEngine) => Promise<unknown>) => engine.transaction(tx => withWriteTrust(tx, t, () => fn(tx)));
const promote = (engine: BrainEngine, ceiling: TrustTier, sql: string, params: unknown[]) =>
  engine.transaction(tx => withTrustPromotion(tx, ceiling, () => tx.executeRaw(sql, params)));

for (const backendName of testBackends()) {
  const engineOf = () => backends.find(b => b.name === backendName)!.engine;

  describe(`trust tier trigger (${backendName})`, () => {
    test('a page whose frontmatter is not a JSON object still updates (legacy or raw-SQL rows)', async () => {
      const { id } = await newPage(engineOf());
      await engineOf().executeRaw(`UPDATE pages SET frontmatter = '"scalar"'::jsonb WHERE id = $1`, [id]);
      await engineOf().executeRaw(`UPDATE pages SET frontmatter = '{}'::jsonb WHERE id = $1`, [id]);
      expect(await tierOf(engineOf(), 'pages', id)).toBe('unknown');
    });

    test('fires last among BEFORE ROW triggers on every trust table', async () => {
      for (const table of TRUST_TABLES) {
        const names = (await engineOf().executeRaw<{ tgname: string }>(
          `SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal AND (tgtype & 3) = 3 ORDER BY tgname COLLATE "C"`, [table])).map(r => r.tgname);
        expect({ table, last: names.at(-1) }).toEqual({ table, last: TRUST_TIER_TRIGGER });
        for (const predecessor of TRUST_TIER_TRIGGER_PREDECESSORS[table]) expect({ table, predecessor, present: names.includes(predecessor) }).toEqual({ table, predecessor, present: true });
      }
    });

    test('INSERT cannot spoof a tier: no writer -> unknown, writer -> its tier (ENG-13)', async () => {
      const engine = engineOf();
      const slug = `trust/${randomUUID().slice(0, 8)}`;
      await engine.executeRaw(`INSERT INTO pages(slug,type,title,compiled_truth,source_id,trust_tier) VALUES($1,'note','T','b','default','user_confirmed')`, [slug]);
      expect((await page(engine, slug)).trust_tier).toBe('unknown');
      const slug2 = `trust/${randomUUID().slice(0, 8)}`;
      await inTrust(engine, trust('agent_written', 'mcp:put_page'), tx => tx.executeRaw(
        `INSERT INTO pages(slug,type,title,compiled_truth,source_id,trust_tier) VALUES($1,'note','T','b','default','operator_curated')`, [slug2]));
      expect(await page(engine, slug2)).toMatchObject({ trust_tier: 'agent_written', write_origin: { channel: 'mcp:put_page' } });
    });

    test('a writer tier above operator_curated needs a covering promotion', async () => {
      const engine = engineOf();
      await expect(newPage(engine, trust('user_confirmed'))).rejects.toThrow(/trust_raise_refused/);
      const slug = `trust/${randomUUID().slice(0, 8)}`;
      await engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', () => withWriteTrust(tx, trust('user_confirmed', 'cli:remember --confirm'),
        () => tx.executeRaw(`INSERT INTO pages(slug,type,title,compiled_truth,source_id) VALUES($1,'note','T','b','default')`, [slug]))));
      expect((await page(engine, slug)).trust_tier).toBe('user_confirmed');
    });

    test('content rewrite: owner writer restamps, lower writers take min(prior, writer) (CEO-12)', async () => {
      const engine = engineOf();
      const legacy = await newPage(engine);
      await inTrust(engine, trust('operator_curated', 'sync'), tx => tx.executeRaw(`UPDATE pages SET compiled_truth='owner edit' WHERE id=$1`, [legacy.id]));
      expect(await page(engine, legacy.slug)).toMatchObject({ trust_tier: 'operator_curated', write_origin: { channel: 'sync' } });
      await inTrust(engine, trust('agent_written', 'mcp:put_page'), tx => tx.executeRaw(`UPDATE pages SET compiled_truth='agent edit' WHERE id=$1`, [legacy.id]));
      expect((await page(engine, legacy.slug)).trust_tier).toBe('agent_written');
      const external = await newPage(engine, trust('external_untrusted', 'connector:google'));
      await inTrust(engine, trust('agent_written'), tx => tx.executeRaw(`UPDATE pages SET compiled_truth='body ' WHERE id=$1`, [external.id]));
      expect((await page(engine, external.slug)).trust_tier).toBe('external_untrusted');
      const curated = await newPage(engine, trust('operator_curated'));
      await engine.executeRaw(`UPDATE pages SET title='edited by an undeclared writer' WHERE id=$1`, [curated.id]);
      expect((await page(engine, curated.slug)).trust_tier).toBe('unknown');
    });

    test('unchanged content keeps the tier without error; ephemeral frontmatter and tags are not content (CEO-16)', async () => {
      const engine = engineOf();
      const legacy = await newPage(engine, undefined, { captured_at: '2026-01-01' });
      await inTrust(engine, trust('operator_curated', 'sync'), async tx => {
        await tx.executeRaw(`UPDATE pages SET compiled_truth=compiled_truth WHERE id=$1`, [legacy.id]);
        await tx.executeRaw(`UPDATE pages SET frontmatter=frontmatter || '{"captured_at":"2026-02-02","quarantine":true}'::jsonb WHERE id=$1`, [legacy.id]);
        await tx.executeRaw(`UPDATE pages SET trust_tier='operator_curated' WHERE id=$1`, [legacy.id]);
      });
      expect((await page(engine, legacy.slug)).trust_tier).toBe('unknown');
    });

    test('a direct raise is refused on every trust table; promotion allows it; lowering is always allowed', async () => {
      const engine = engineOf();
      const p = await newPage(engine, trust('agent_written'));
      const refused = await engine.executeRaw(`UPDATE pages SET trust_tier='user_confirmed' WHERE id=$1`, [p.id]).then(() => null, (e: unknown) => e);
      expect(String((refused as Error)?.message)).toContain('trust_raise_refused');
      expect(databaseRefusal(refused)).toMatchObject({ code: 'trust_raise_refused', detail: { origin: 'database_trigger', table: 'pages' } });
      expect(trustRaiseRefusal(refused)?.code).toBe('trust_raise_refused');
      await promote(engine, 'operator_curated', `UPDATE pages SET trust_tier='operator_curated' WHERE id=$1`, [p.id]);
      expect((await page(engine, p.slug)).trust_tier).toBe('operator_curated');
      await expect(promote(engine, 'operator_curated', `UPDATE pages SET trust_tier='user_confirmed' WHERE id=$1`, [p.id])).rejects.toThrow(/trust_raise_refused/);
      await engine.executeRaw(`UPDATE pages SET trust_tier='external_untrusted' WHERE id=$1`, [p.id]);
      expect((await page(engine, p.slug)).trust_tier).toBe('external_untrusted');

      const [fact] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,kind,source) VALUES('default','e','claim','fact','test') RETURNING id`);
      const [take] = await engine.executeRaw<{ id: number }>(`INSERT INTO takes(page_id,row_num,claim,kind,holder,weight) VALUES($1,1,'c','take','world',0.5) RETURNING id`, [p.id]);
      const [entry] = await engine.executeRaw<{ id: number }>(`INSERT INTO timeline_entries(page_id,date,summary,detail,source) VALUES($1,'2026-01-01','s','d','x') RETURNING id`, [p.id]);
      for (const [table, id] of [['facts', fact!.id], ['takes', take!.id], ['timeline_entries', entry!.id]] as const) {
        expect(await tierOf(engine, table, id)).toBe('unknown');
        await expect(engine.executeRaw(`UPDATE ${table} SET trust_tier='tool_observed' WHERE id=$1`, [id])).rejects.toThrow(/trust_raise_refused/);
      }
    });

    test('lifecycle and placement columns keep a confirmed tier; content columns do not (ENG-2)', async () => {
      const engine = engineOf();
      const [fact] = await engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', () => withWriteTrust(tx, trust('user_confirmed'),
        () => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,kind,source) VALUES('default','e','confirmed claim','fact','test') RETURNING id`))));
      await inTrust(engine, trust('operator_curated', 'sync'), tx => tx.executeRaw(
        `UPDATE facts SET row_num=7, source_markdown_slug='e', visibility='private', confidence=0.5, notability='high', expired_at=now() WHERE id=$1`, [fact!.id]));
      expect(await tierOf(engine, 'facts', fact!.id)).toBe('user_confirmed');
      await inTrust(engine, trust('operator_curated', 'sync'), tx => tx.executeRaw(`UPDATE facts SET context='new context' WHERE id=$1`, [fact!.id]));
      expect(await tierOf(engine, 'facts', fact!.id)).toBe('operator_curated');
    });

    test('backfill moves only unknown rows and never to user_confirmed (CEO-10)', async () => {
      const engine = engineOf();
      const legacy = await newPage(engine);
      const backfill = (sql: string, params: unknown[]) => engine.transaction(tx => withTrustBackfill(tx, () => tx.executeRaw(sql, params)));
      await expect(backfill(`UPDATE pages SET trust_tier='user_confirmed' WHERE id=$1`, [legacy.id])).rejects.toThrow(/trust_raise_refused/);
      await backfill(`UPDATE pages SET trust_tier='tool_observed' WHERE id=$1`, [legacy.id]);
      expect((await page(engine, legacy.slug)).trust_tier).toBe('tool_observed');
      const agent = await newPage(engine, trust('agent_written'));
      await expect(backfill(`UPDATE pages SET trust_tier='operator_curated' WHERE id=$1`, [agent.id])).rejects.toThrow(/trust_raise_refused/);
    });

    test('page_versions snapshot the page tier and origin; a supplied value is ignored (ENG-10)', async () => {
      const engine = engineOf();
      const p = await newPage(engine, trust('operator_curated', 'sync'));
      const [v] = await engine.executeRaw<{ trust_tier: string; write_origin: unknown }>(
        `INSERT INTO page_versions(page_id,compiled_truth,frontmatter,trust_tier) VALUES($1,'body','{}'::jsonb,'user_confirmed') RETURNING trust_tier, write_origin`, [p.id]);
      expect(v).toEqual({ trust_tier: 'operator_curated', write_origin: { channel: 'sync' } });
    });
  });

  describe(`trust declarations through the attribution seam (${backendName})`, () => {
    test('nested declarations combine as min(outer, inner); undeclared scopes keep the outer one', async () => {
      const engine = engineOf();
      const seen = await engine.transaction(tx => withWriteTrust(tx, trust('operator_curated', 'sync'), async () => {
        const lowered = await withWriteTrust(tx, trust('agent_written', 'derived'), () => currentWriteTrust(tx));
        const notRaised = await withWriteAttribution(tx, attribution(trust('user_confirmed')), () => currentWriteTrust(tx)).catch(() => null);
        const kept = await withWriteAttribution(tx, attribution(), () => currentWriteTrust(tx));
        const restored = await currentWriteTrust(tx);
        return { lowered, notRaised, kept, restored };
      }));
      expect(seen.lowered).toEqual({ tier: 'agent_written', origin: { channel: 'derived' } });
      expect(seen.notRaised?.tier).toBe('operator_curated');
      expect(seen.kept).toEqual({ tier: 'operator_curated', origin: { channel: 'sync' } });
      expect(seen.restored).toEqual({ tier: 'operator_curated', origin: { channel: 'sync' } });
      expect(await engine.transaction(tx => currentWriteTrust(tx))).toBeNull();
    });

    test('withCoordinatedWrite nests min(outer, inner) and a group member resets to its own declaration', async () => {
      const engine = engineOf();
      const [a, b] = [`trust/${randomUUID().slice(0, 8)}`, `trust/${randomUUID().slice(0, 8)}`];
      const insert = (tx: BrainEngine, slug: string) => tx.executeRaw(`INSERT INTO pages(slug,type,title,compiled_truth,source_id) VALUES($1,'note','T','b','default')`, [slug]);
      const inner = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
        const nested = await withCoordinatedWrite(tx, ['default'], () => currentWriteTrust(tx), attribution(trust('operator_curated', 'inner')));
        await setMemberAttribution(tx, attribution(trust('external_untrusted', 'connector:github')));
        await insert(tx, a);
        await setMemberAttribution(tx, attribution());
        await insert(tx, b);
        return nested;
      }, attribution(trust('agent_written', 'outer'))));
      expect(inner).toEqual({ tier: 'agent_written', origin: { channel: 'inner' } });
      expect(await page(engine, a)).toMatchObject({ trust_tier: 'external_untrusted', write_origin: { channel: 'connector:github' } });
      expect(await page(engine, b)).toMatchObject({ trust_tier: 'unknown', write_origin: null });
    });

    test('the declared tier is the stored tier (ENG-18) and write_origin binds as a JSON object', async () => {
      const engine = engineOf();
      const declared = effectiveWriteTrust({ channel: 'agent_written', lowerTo: ['external_untrusted'], origin: { channel: 'mcp:remember', source_uri: 'https://example.com/a' } });
      const row = await inTrust(engine, declared, async tx => {
        const [f] = await tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,kind,source) VALUES('default','e','f','fact','test') RETURNING id`);
        return { id: f!.id, scope: await currentWriteTrust(tx) };
      }) as { id: number; scope: WriteTrust };
      const [stored] = await engine.executeRaw<{ trust_tier: string; write_origin: unknown; kind: string }>(
        `SELECT trust_tier, write_origin, jsonb_typeof(write_origin) AS kind FROM facts WHERE id=$1`, [row.id]);
      expect(stored!.trust_tier).toBe(row.scope.tier);
      expect(stored!.kind).toBe('object');
      expect(stored!.write_origin).toEqual(declared.origin);
    });

    test('the managed-writer guard treats a page or fact tier change as guarded content', async () => {
      const engine = engineOf();
      const p = await newPage(engine, trust('agent_written'));
      const [f] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,kind,source) VALUES('default','e','g','fact','test') RETURNING id`);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        await expect(engine.executeRaw(`UPDATE pages SET trust_tier='unknown' WHERE id=$1`, [p.id])).rejects.toThrow(/writer_coordinator_required/);
        await expect(engine.executeRaw(`UPDATE facts SET trust_tier='external_untrusted' WHERE id=$1`, [f!.id])).rejects.toThrow(/writer_coordinator_required/);
        await engine.executeRaw(`UPDATE facts SET write_origin='{"channel":"note"}'::jsonb WHERE id=$1`, [f!.id]);
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(`UPDATE pages SET trust_tier='unknown' WHERE id=$1`, [p.id]), attribution()));
      } finally {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
      expect((await page(engine, p.slug)).trust_tier).toBe('unknown');
    });
  });

  describe(`get_write_attribution trust fields (${backendName})`, () => {
    test('a fact derived from an external page names that page and its tier; 40 inputs keep 32 (CEO-1)', async () => {
      const engine = engineOf();
      const source = await newPage(engine, trust('external_untrusted', 'connector:google'));
      const inputs: TaintInput[] = [{ table: 'pages', id: source.id, tier: 'external_untrusted' },
        ...Array.from({ length: 39 }, (_, i): TaintInput => ({ table: 'facts', id: 1000 + i, tier: 'operator_curated' }))];
      const declared = effectiveWriteTrust({ channel: 'agent_written', derived: true, inputs, origin: { channel: 'facts:extract' } });
      const [fact] = await inTrust(engine, declared, tx => tx.executeRaw<{ id: number }>(
        `INSERT INTO facts(source_id,entity_slug,fact,kind,source) VALUES('default',$1,'derived claim','fact','sync:import') RETURNING id`, [source.slug])) as Array<{ id: number }>;
      const ctx = { engine, remote: false, dryRun: false, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const out = await operationsByName.get_write_attribution!.handler(ctx, { slug: source.slug, fact: fact!.id }) as Record<string, any>;
      expect(out.trust_tier).toBe('external_untrusted');
      expect(out.write_origin.taint_inputs[0]).toEqual({ table: 'pages', id: source.id, tier: 'external_untrusted' });
      expect(out.write_origin).toMatchObject({ channel: 'facts:extract', taint_inputs_truncated: true, taint_input_count: 40 });
      expect(out.write_origin.taint_inputs).toHaveLength(32);
      expect(out.created.origin).toBeDefined();
      const pageView = await operationsByName.get_write_attribution!.handler(ctx, { slug: source.slug, versions: true }) as Record<string, any>;
      expect(pageView).toMatchObject({ trust_tier: 'external_untrusted', write_origin: { channel: 'connector:google' } });
    });
  });
}
