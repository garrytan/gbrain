/**
 * Warmed caches after each trust transition (#5575 ENG-11).
 *
 * Protects: hot memory (`_meta.brain_hot_memory`) and the OpenClaw core lane
 * never deliver content cached before a trust transition. Each test warms the
 * cache, commits one transition by direct SQL (so neither the in-process
 * dispatcher invalidation nor the withdrawal watermark fires: only the trust
 * policy generation can catch it), and asserts the next delivery reflects
 * the change: a tier raise by confirmation and a tier lowering under a token
 * floor, quarantine on and off, the read floor through `trust.read_policy`,
 * a purge (row deleted, ledger row inserted) and a needs_rederive row. A
 * failed refresh (generation unreadable, rebuild throwing, core fetch failing
 * or timing out) delivers nothing, never the cached payload. Hot-memory facts
 * carry trust_tier and origin. Runs on PGLite, and on Postgres (direct and
 * transaction-mode PgBouncer) through test/e2e/trust-generation-postgres.test.ts.
 *
 * `trust.agent_activation=allow` is set for the hot-memory tests: until the
 * write gate's receipts table is on this branch, activation control's SQL
 * has nothing to read; suppression itself is covered by the activation tests.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { TrustTier } from '../src/core/trust/tier.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { withTrustPromotion, withWriteTrust } from '../src/core/persistence/context.ts';
import { createOpenClawCoreLane, refreshCoreFromEngine, type CoreRefresh } from '../src/core/context/openclaw-core.ts';
import { makeContextPackIpcHandler } from '../src/mcp/context-pack-handler.ts';
import { CORE_CONFIG_KEYS } from '../src/core/core-memory.ts';

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
  for (const b of backends) {
    await b.engine.setConfig('trust.agent_activation', 'allow');
    await b.engine.setConfig(CORE_CONFIG_KEYS.enabled, 'true');
  }
}, 180_000);
afterAll(async () => { for (const b of backends) await b.close(); });
beforeEach(() => { __resetHotMemoryCacheForTests(); });

const ENTITY = 'people/alice-example';
const writer = (tier: TrustTier) => ({ tier, origin: { channel: 'mcp:remember' } });

/** One fact in its own session, so each test reads only its own rows. */
async function seed(engine: BrainEngine, tier: TrustTier = 'agent_written'): Promise<{ id: number; marker: string; session: string }> {
  const marker = `cnrytrust${randomUUID().slice(0, 8)}`;
  const session = `session-${marker}`;
  const { id } = await engine.transaction(tx => withWriteTrust(tx, writer(tier), () => tx.insertFact(
    { fact: `Keeps bees ${marker}`, kind: 'fact', entity_slug: ENTITY, visibility: 'world', source: 'test', source_session: session },
    { source_id: 'default' })));
  return { id, marker, session };
}
const ctx = (engine: BrainEngine, session: string, minTrust?: TrustTier): OperationContext => ({
  engine, remote: true, sourceId: 'default', sessionId: session, config: {} as never, dryRun: false,
  logger: { info() {}, warn() {}, error() {} },
  ...(minTrust ? { auth: { token: 't', clientId: 'c', scopes: ['read'], minTrust } as never } : {}),
});
const hotFacts = async (c: OperationContext) =>
  ((await getBrainHotMemoryMeta('get_stats', c))?.brain_hot_memory as { facts?: Array<Record<string, unknown>> } | undefined)?.facts ?? [];
const carries = async (c: OperationContext, marker: string) => JSON.stringify(await hotFacts(c)).includes(marker);
const promote = (engine: BrainEngine, id: number) => engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed',
  () => tx.executeRaw(`UPDATE facts SET trust_tier = 'user_confirmed' WHERE id = $1`, [id])));

for (const backendName of testBackends()) {
  const engineOf = () => backends.find(b => b.name === backendName)!.engine;

  describe(`hot memory after trust transitions (${backendName})`, () => {
    test('facts carry trust_tier and origin', async () => {
      const engine = engineOf();
      const { marker, session } = await seed(engine);
      const [fact] = await hotFacts(ctx(engine, session));
      expect(String(fact?.fact)).toContain(marker);
      expect({ trust_tier: fact?.trust_tier, origin: fact?.origin }).toEqual({ trust_tier: 'agent_written', origin: 'mcp:remember' });
    });

    test('a confirmation (tier raise) and a tier lowering under a token floor', async () => {
      const engine = engineOf();
      const { id, marker, session } = await seed(engine);
      const floored = ctx(engine, session, 'tool_observed');
      expect(await carries(floored, marker)).toBe(false);
      await promote(engine, id);
      expect(await carries(floored, marker)).toBe(true);
      await engine.executeRaw(`UPDATE facts SET trust_tier = 'agent_written' WHERE id = $1`, [id]);
      expect(await carries(floored, marker)).toBe(false);
    });

    test('quarantine on and off on the fact\'s source page', async () => {
      const engine = engineOf();
      const { id, marker, session } = await seed(engine);
      const slug = `trust-cache/${marker}`;
      await engine.executeRaw(`INSERT INTO pages(slug,type,title,compiled_truth,source_id) VALUES($1,'note','T','body','default')`, [slug]);
      await engine.executeRaw('UPDATE facts SET source_markdown_slug = $1 WHERE id = $2', [slug, id]);
      const c = ctx(engine, session);
      expect(await carries(c, marker)).toBe(true);
      await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"quarantine":{"reason":"test"}}'::jsonb WHERE slug = $1`, [slug]);
      expect(await carries(c, marker)).toBe(false);
      await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter - 'quarantine' WHERE slug = $1`, [slug]);
      expect(await carries(c, marker)).toBe(true);
    });

    test('the read floor through trust.read_policy', async () => {
      const engine = engineOf();
      const { marker, session } = await seed(engine, 'external_untrusted');
      const c = ctx(engine, session);
      expect(await carries(c, marker)).toBe(true);
      await engine.setConfig('trust.read_policy', 'filter');
      try {
        expect(await carries(c, marker)).toBe(false);
      } finally {
        await engine.unsetConfig('trust.read_policy');
      }
      expect(await carries(c, marker)).toBe(true);
    });

    test('a purge (row deleted, ledger row written) and a needs_rederive row', async () => {
      const engine = engineOf();
      const purged = await seed(engine);
      const c = ctx(engine, purged.session);
      expect(await carries(c, purged.marker)).toBe(true);
      await engine.transaction(async tx => {
        await tx.executeRaw(`INSERT INTO fact_purges(source_id, visibility, fact_hash)
          SELECT source_id, visibility, gbrain_fact_fingerprint(fact) FROM facts WHERE id = $1`, [purged.id]);
        await tx.executeRaw('DELETE FROM facts WHERE id = $1', [purged.id]);
      });
      expect(await carries(c, purged.marker)).toBe(false);

      const hidden = await seed(engine);
      const h = ctx(engine, hidden.session);
      expect(await carries(h, hidden.marker)).toBe(true);
      await engine.executeRaw(`INSERT INTO needs_rederive(derived_table, derived_id, source_id, reason) VALUES('facts', $1, 'default', 'test')`, [String(hidden.id)]);
      expect(await carries(h, hidden.marker)).toBe(false);
    });

    test('an unreadable generation delivers nothing, and a failed rebuild after a transition never serves the cached payload', async () => {
      const engine = engineOf();
      const { id, marker, session } = await seed(engine);
      const c = ctx(engine, session);
      expect(await carries(c, marker)).toBe(true);

      const mutable = engine as unknown as Record<string, unknown>;
      const realRaw = engine.executeRaw.bind(engine);
      mutable.executeRaw = async (sql: string, params?: unknown[]) => {
        if (sql.includes('trust_policy_state')) throw new Error('generation read failed');
        return realRaw(sql, params);
      };
      try {
        expect(await getBrainHotMemoryMeta('get_stats', c)).toBeUndefined();
      } finally {
        delete mutable.executeRaw;
      }
      expect(await carries(c, marker)).toBe(true);

      await engine.executeRaw(`UPDATE facts SET trust_tier = 'unknown' WHERE id = $1`, [id]);
      mutable.listFactsBySession = async () => { throw new Error('rebuild failed'); };
      mutable.listFactsSince = async () => { throw new Error('rebuild failed'); };
      try {
        await expect(getBrainHotMemoryMeta('get_stats', c)).rejects.toThrow('rebuild failed');
        await expect(getBrainHotMemoryMeta('get_stats', c)).rejects.toThrow('rebuild failed');
      } finally {
        delete mutable.listFactsBySession;
        delete mutable.listFactsSince;
      }
      const [fact] = await hotFacts(c);
      expect(fact?.trust_tier).toBe('unknown');
    });
  });

  describe(`OpenClaw core lane after trust transitions (${backendName})`, () => {
    async function corePage(engine: BrainEngine, body: string): Promise<string> {
      const slug = `core/${randomUUID().slice(0, 8)}`;
      await engine.executeRaw(`INSERT INTO pages(slug,type,title,compiled_truth,source_id,frontmatter) VALUES($1,'note','Core','${body}','default','{"always_load": true}'::jsonb)`, [slug]);
      return slug;
    }
    function lane(engine: BrainEngine, fail: { now: boolean } = { now: false }) {
      const kinds: string[] = [];
      const l = createOpenClawCoreLane({
        timeoutMs: 5_000,
        fetcher: async (_session, memo): Promise<CoreRefresh> => {
          if (fail.now) throw new Error('core fetch failed');
          const r = await refreshCoreFromEngine(engine, 'default', memo);
          kinds.push(r?.kind ?? 'null');
          return r;
        },
      });
      const text = async () => (await l.additions({ sessionId: 's', messages: [] })).join('\n');
      return { text, kinds };
    }

    test('the memo is revalidated on every delivery and rebuilt after a transition', async () => {
      const engine = engineOf();
      const marker = `cnrycore${randomUUID().slice(0, 8)}`;
      const slug = await corePage(engine, `first ${marker}`);
      const { text, kinds } = lane(engine);
      expect(await text()).toContain(`first ${marker}`);
      await engine.executeRaw(`UPDATE pages SET compiled_truth = $1 WHERE slug = $2`, [`second ${marker}`, slug]);
      expect(await text()).toContain(`first ${marker}`);
      expect(kinds).toEqual(['fresh', 'unchanged']);
      // A generation-only transition (eligibility unchanged): another page enters quarantine.
      const other = `trust-cache/${marker}-other`;
      await engine.executeRaw(`INSERT INTO pages(slug,type,title,compiled_truth,source_id) VALUES($1,'note','T','body','default')`, [other]);
      await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"quarantine":{"reason":"test"}}'::jsonb WHERE slug = $1`, [other]);
      expect(await text()).toContain(`second ${marker}`);
      expect(kinds).toEqual(['fresh', 'unchanged', 'fresh']);
      await engine.executeRaw(`UPDATE pages SET compiled_truth = $1 WHERE slug = $2`, [`third ${marker}`, slug]);
      await engine.setConfig('trust.read_policy', 'filter');
      try {
        expect(await text()).toContain(`third ${marker}`);
      } finally {
        await engine.unsetConfig('trust.read_policy');
      }
      expect(kinds).toEqual(['fresh', 'unchanged', 'fresh', 'fresh']);
    });

    test('a failed refresh delivers no core block, never the memo', async () => {
      const engine = engineOf();
      const marker = `cnrycore${randomUUID().slice(0, 8)}`;
      await corePage(engine, marker);
      const fail = { now: false };
      const { text } = lane(engine, fail);
      expect(await text()).toContain(marker);
      fail.now = true;
      expect(await text()).not.toContain(marker);
      fail.now = false;
      expect(await text()).toContain(marker);
    });

    test('a timed-out refresh delivers no core block', async () => {
      const engine = engineOf();
      const marker = `cnrycore${randomUUID().slice(0, 8)}`;
      await corePage(engine, marker);
      const slow = { now: false };
      const l = createOpenClawCoreLane({
        timeoutMs: 50,
        fetcher: async (_s, memo) => {
          if (slow.now) await new Promise(r => setTimeout(r, 200));
          return refreshCoreFromEngine(engine, 'default', memo);
        },
      });
      expect((await l.additions({ sessionId: 's', messages: [] })).join('\n')).toContain(marker);
      slow.now = true;
      expect((await l.additions({ sessionId: 's', messages: [] })).join('\n')).not.toContain(marker);
    });

    test('the serve coreOnly arm answers unchanged for a matching identity and a fresh block after a transition', async () => {
      const engine = engineOf();
      const marker = `cnrycore${randomUUID().slice(0, 8)}`;
      await corePage(engine, marker);
      const handler = makeContextPackIpcHandler(engine, 'default');
      const first = await handler({ kind: 'context_pack', protocol: 2, secret: 's', coreOnly: true });
      expect(first?.core?.text).toContain(marker);
      const identity = first?.coreTrust?.identity;
      expect(first?.coreTrust?.unchanged).toBe(false);
      expect(typeof identity).toBe('string');
      const again = await handler({ kind: 'context_pack', protocol: 2, secret: 's', coreOnly: true, coreIdentity: identity });
      expect(again?.coreTrust).toEqual({ identity: identity!, unchanged: true });
      expect(again?.core).toBeUndefined();
      await engine.setConfig('trust.read_policy', 'filter');
      try {
        const after = await handler({ kind: 'context_pack', protocol: 2, secret: 's', coreOnly: true, coreIdentity: identity });
        expect(after?.coreTrust?.unchanged).toBe(false);
        expect(after?.coreTrust?.identity).not.toBe(identity);
        expect(after?.core?.text).toContain(marker);
      } finally {
        await engine.unsetConfig('trust.read_policy');
      }
    });
  });
}
