/**
 * recall `question` confidence weighting (#2941, recall.confidence_weighting)
 * and entity grouping (#2953, recall.group_by_entity). Both default off; off
 * must leave the response exactly as before. Keyless (term share only) so the
 * ranking is deterministic; facts are written straight to the database, the
 * repo-less shape (no git, no fence file).
 *
 * Both engines: PGLite always, Postgres through
 * test/e2e/recall-confidence-grouping-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { CONFIDENCE_WEIGHTING_KEY, GROUP_BY_ENTITY_KEY, recallConfigValueRefusal } from '../src/core/facts/recall-config.ts';
import { HALFLIFE_DAYS, confidenceFactor, recallConfidence, type RecallConfidenceFact } from '../src/core/facts/decay.ts';
import { withTrustPromotion } from '../src/core/persistence/context.ts';
import type { TrustTier } from '../src/core/trust/tier.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-01T00:00:00Z');
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const markers = (facts: R[]) => facts.map(f => String(f.fact).split(' ')[0]);
const row = (o: Partial<RecallConfidenceFact> & { daysAgo: number }): RecallConfidenceFact => ({
  kind: 'fact', confidence: 1, valid_until: null, expired_at: null, ...o, valid_from: new Date(NOW.getTime() - o.daysAgo * DAY),
});

describe('recallConfidence (pure)', () => {
  test('trust is a floor: confirmed and owner notes never decay; other tiers decay and carry their weight', () => {
    expect(recallConfidence(row({ daysAgo: 1000, trust_tier: 'user_confirmed' }), false, NOW)).toBe(1);
    expect(recallConfidence(row({ daysAgo: 1000, trust_tier: 'operator_curated' }), false, NOW)).toBe(1);
    expect(recallConfidence(row({ daysAgo: 0, trust_tier: 'agent_written' }), false, NOW)).toBeCloseTo(0.8, 6);
    expect(recallConfidence(row({ daysAgo: 0, trust_tier: 'external_untrusted' }), false, NOW)).toBeCloseTo(0.6, 6);
    expect(recallConfidence(row({ daysAgo: 0, trust_tier: 'tool_observed' }), false, NOW)).toBeCloseTo(0.9, 6);
    expect(recallConfidence(row({ daysAgo: 0 }), false, NOW)).toBeCloseTo(0.8, 6);
    expect(recallConfidence(row({ daysAgo: HALFLIFE_DAYS.fact, trust_tier: 'agent_written' }), false, NOW)).toBeCloseTo(0.8 * Math.exp(-1), 6);
  });

  test('an older confirmed fact outweighs fresh agent-written and external facts', () => {
    const old = recallConfidence(row({ daysAgo: 365, trust_tier: 'user_confirmed' }), false, NOW);
    for (const tier of ['agent_written', 'external_untrusted', 'tool_observed', 'unknown'] as TrustTier[]) {
      expect(old).toBeGreaterThan(recallConfidence(row({ daysAgo: 0, trust_tier: tier }), false, NOW));
    }
  });

  test('a writer-dated fact row does not decay; a writer-dated event does', () => {
    expect(recallConfidence(row({ daysAgo: 4000, trust_tier: 'agent_written' }), true, NOW)).toBeCloseTo(0.8, 6);
    expect(recallConfidence(row({ daysAgo: 70, kind: 'event', trust_tier: 'agent_written' }), true, NOW)).toBeLessThan(0.001);
  });

  test('expired or lapsed facts weigh 0 whatever their tier, and the factor stays in [0.5, 1]', () => {
    expect(recallConfidence(row({ daysAgo: 1, trust_tier: 'user_confirmed', expired_at: new Date(NOW.getTime() - DAY) }), false, NOW)).toBe(0);
    expect(recallConfidence(row({ daysAgo: 1, trust_tier: 'user_confirmed', valid_until: new Date(NOW.getTime() - DAY) }), false, NOW)).toBe(0);
    expect(confidenceFactor(0)).toBe(0.5);
    expect(confidenceFactor(1)).toBe(1);
    expect(confidenceFactor(7)).toBe(1);
  });
});

describe('recall config values', () => {
  test('switches take on/off; question_admission takes its rules; anything else is refused', () => {
    for (const key of [CONFIDENCE_WEIGHTING_KEY, GROUP_BY_ENTITY_KEY]) {
      for (const v of ['on', 'off', 'true', 'false', 'ON']) expect(recallConfigValueRefusal(key, v)).toBeNull();
      expect(recallConfigValueRefusal(key, 'bogus')).toContain('must be on or off');
    }
    expect(recallConfigValueRefusal('recall.question_admission', 'facts_arm')).toBeNull();
    expect(recallConfigValueRefusal('recall.question_admission', 'bogus')).toContain('reserve, facts_arm');
    expect(recallConfigValueRefusal('recall.unrelated', 'anything')).toBeNull();
  });
});

for (const kind of testBackends()) {
  describe(`recall confidence weighting and entity grouping (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const ids: Record<string, number> = {};
    let notices: Notice[] = [];
    const ctxOf = (remote: boolean): OperationContext => ({
      engine, config: {} as GBrainConfig, logger: noopLogger, dryRun: false, remote, transport: 'stdio', sourceId: 'default',
      emitNotice: (n: Notice) => notices.push(n),
    } as OperationContext);
    const recall = async (p: R, remote = false) => (await operationsByName.recall.handler(ctxOf(remote), p)) as R;
    const setFlag = (key: string, value: string | null) => value === null
      ? engine.executeRaw('DELETE FROM config WHERE key = $1', [key]) : engine.setConfig(key, value);

    async function fact(name: string, f: { text: string; entity: string | null; daysAgo: number; tier?: TrustTier; visibility?: 'world' | 'private' }) {
      const [r] = await engine.executeRaw<{ id: string | number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, created_at, source)
         VALUES ('default', $1, $2, 'fact', $3, now() - ($4 || ' days')::interval, now() - ($4 || ' days')::interval, 'test') RETURNING id`,
        [f.entity, f.text, f.visibility ?? 'world', String(f.daysAgo)]);
      ids[name] = Number(r!.id);
      const tier = f.tier ?? 'agent_written';
      await engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw('UPDATE facts SET trust_tier = $1 WHERE id = $2', [tier, ids[name]])));
    }

    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      __setEmbedTransportForTests(null);
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      // Weighting: identical term match, so only trust and age can separate them.
      await fact('confirmed', { text: 'OLDCONFIRMED widget-example warranty period lasts twelve months', entity: null, daysAgo: 400, tier: 'user_confirmed' });
      await fact('fresh', { text: 'FRESHAGENT widget-example warranty period lasts three months', entity: null, daysAgo: 1, tier: 'agent_written' });
      await fact('external', { text: 'FRESHEXTERNAL widget-example warranty period lasts six months', entity: null, daysAgo: 2, tier: 'external_untrusted' });
      // Duplicate claim: older confirmed copy, newer agent copy.
      await fact('dupOld', { text: 'gadget-example ships with a carbon fiber frame', entity: null, daysAgo: 300, tier: 'user_confirmed' });
      await fact('dupNew', { text: 'gadget-example ships with a carbon fiber frame', entity: null, daysAgo: 3, tier: 'agent_written' });
      // Grouping: two clients and a default, plus a private figure for a third client.
      await fact('priceA', { text: 'PRICEA annual subscription price quoted 5000 dollars', entity: 'companies/client-a-example', daysAgo: 5 });
      await fact('termsA', { text: 'TERMSA annual subscription price includes onboarding', entity: 'companies/client-a-example', daysAgo: 6 });
      await fact('priceB', { text: 'PRICEB annual subscription price quoted 10000 dollars', entity: 'companies/client-b-example', daysAgo: 4 });
      await fact('priceDefault', { text: 'PRICEDEFAULT standard annual subscription price list 10000 dollars', entity: null, daysAgo: 7 });
      await fact('priceC', { text: 'PRICEC annual subscription price quoted 7000 dollars', entity: 'companies/client-c-example', daysAgo: 3, visibility: 'private' });
    }, 180_000);
    afterAll(async () => { resetGateway(); await close?.(); });
    beforeEach(async () => {
      notices = [];
      __resetPrivateVisibilityCacheForTests();
      await setFlag(CONFIDENCE_WEIGHTING_KEY, null);
      await setFlag(GROUP_BY_ENTITY_KEY, null);
    });

    const WARRANTY = 'How long does the widget-example warranty period last?';
    const PRICE = 'What annual subscription price did we quote?';

    test('flags off (unset or off): the response carries no new fields and keeps relevance-then-newest order', async () => {
      const unset = await recall({ question: WARRANTY });
      await setFlag(CONFIDENCE_WEIGHTING_KEY, 'off');
      await setFlag(GROUP_BY_ENTITY_KEY, 'off');
      const off = await recall({ question: WARRANTY });
      expect(off).toEqual(unset);
      expect(markers(unset.facts)).toEqual(['FRESHAGENT', 'FRESHEXTERNAL', 'OLDCONFIRMED']);
      for (const f of unset.facts) { expect(f).not.toHaveProperty('rank_score'); expect(f).not.toHaveProperty('confidence_factor'); }
      expect(unset).not.toHaveProperty('facts_groups');
    });

    test('weighting on: the older confirmed fact outranks fresh agent and external facts; relevance stays raw; the admitted set is unchanged', async () => {
      const before = await recall({ question: WARRANTY });
      await setFlag(CONFIDENCE_WEIGHTING_KEY, 'on');
      const r = await recall({ question: WARRANTY });
      expect(markers(r.facts)).toEqual(['OLDCONFIRMED', 'FRESHAGENT', 'FRESHEXTERNAL']);
      expect(new Set(r.facts.map((f: R) => f.id))).toEqual(new Set(before.facts.map((f: R) => f.id)));
      const byMarker = Object.fromEntries(r.facts.map((f: R) => [markers([f])[0], f]));
      expect(byMarker.OLDCONFIRMED.confidence_factor).toBe(1);
      expect(byMarker.FRESHEXTERNAL.confidence_factor).toBeLessThan(byMarker.FRESHAGENT.confidence_factor);
      for (const f of r.facts) {
        expect(f.relevance).toBe(before.facts.find((b: R) => b.id === f.id).relevance);
        expect(f.rank_score).toBeCloseTo(f.relevance * f.confidence_factor, 3);
      }
    });

    test('weighting on: copies of one claim deliver the best-ranked copy (the confirmed one), not the newest', async () => {
      const off = await recall({ question: 'What frame does gadget-example ship with?' });
      expect(off.facts[0].id).toBe(ids.dupNew);
      await setFlag(CONFIDENCE_WEIGHTING_KEY, 'on');
      const on = await recall({ question: 'What frame does gadget-example ship with?' });
      expect(on.facts[0].id).toBe(ids.dupOld);
      expect(on.facts[0].collapsed_count).toBe(2);
      expect(on.facts[0].trust_tier).toBe('user_confirmed');
    });

    test('grouping on, no entity: each entity\'s facts sit together, no-entity facts form a group, and the notice offers one recall per entity', async () => {
      await setFlag(GROUP_BY_ENTITY_KEY, 'on');
      const r = await recall({ question: PRICE, limit: 10 });
      const groups = r.facts_groups as R[];
      expect(groups.map(g => g.entity_slug).sort()).toEqual([null, 'companies/client-a-example', 'companies/client-b-example', 'companies/client-c-example'].sort((a, b) => String(a).localeCompare(String(b))));
      expect(r.facts.map((f: R) => String(f.id))).toEqual(groups.flatMap(g => g.fact_ids));
      const a = groups.find(g => g.entity_slug === 'companies/client-a-example')!;
      expect(a.fact_ids.map(Number).sort()).toEqual([ids.priceA, ids.termsA].sort());
      expect(r.entity_unspecified.candidates.map((c: R) => c.entity_slug).sort()).toEqual(['companies/client-a-example', 'companies/client-b-example', 'companies/client-c-example']);
      const notice = notices.find(n => n.code === 'entity_unspecified')!;
      expect(notice.kind).toBe('info');
      const argvs = notice.decisions![0]!.options.map(o => o.argv!.join(' '));
      expect(argvs.some(a2 => a2.includes('companies/client-b-example'))).toBe(true);
    });

    test('grouping inherits the read policy: a remote caller never sees a group or candidate for a private fact', async () => {
      await setFlag(GROUP_BY_ENTITY_KEY, 'on');
      const r = await recall({ question: PRICE, limit: 10 }, true);
      expect((r.facts_groups as R[]).map(g => g.entity_slug)).not.toContain('companies/client-c-example');
      expect(r.entity_unspecified.candidates.map((c: R) => c.entity_slug)).not.toContain('companies/client-c-example');
      expect(markers(r.facts)).not.toContain('PRICEC');
    });

    test('grouping runs after the limit cut, and a call that names an entity is never grouped', async () => {
      await setFlag(GROUP_BY_ENTITY_KEY, 'on');
      const flat = await recall({ question: PRICE, limit: 1 });
      expect(flat.facts).toHaveLength(1);
      expect(flat.facts_groups).toHaveLength(1);
      expect(flat).not.toHaveProperty('entity_unspecified');
      const scoped = await recall({ question: PRICE, entity: 'companies/client-a-example' });
      expect(scoped).not.toHaveProperty('facts_groups');
      expect(markers(scoped.facts).every(m => m === 'PRICEA' || m === 'TERMSA')).toBe(true);
    });
  });
}
