/**
 * recall `question` (memory proof wave 2, W1): active facts ranked by
 * relevance to the question instead of recency, under recall's unchanged read
 * policy. Pins the ranking, the empty answer, every row of the parameter
 * contract, the read-policy composition (trust floor, quarantine and rederive
 * hiding, remote world-only, the private-provenance filter and its operator
 * opt-out), row-shape parity with the newest path, the degraded paths, the
 * recall_hint notice, and that the question's embedding goes through the
 * gateway's query-embedding cache.
 *
 * The embedder is a deterministic bag-of-words transport ($0, no keys) shared
 * by the stored fact vectors and the question.
 *
 * Both engines: PGLite always, Postgres through
 * test/e2e/recall-question-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { configureGateway, getEmbeddingModel, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { REMOTE_PRIVATE_PAGES_KEY, __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { QUESTION_ADMISSION_KEY, QUESTION_MAX_CHARS } from '../src/core/facts/question-recall.ts';
import { recallInteropNotices } from '../src/core/interop-notices.ts';
import { factsFtsDocument, getFtsLanguage } from '../src/core/fts-language.ts';
import { withTrustPromotion } from '../src/core/persistence/context.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;
const ENTITY = 'people/alice-example';
const OTHER = 'people/charlie-example';
const SESSION = 'sess-question';
const COFFEE = 'Does Alice Example drink dark roast coffee in the morning?';
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function bagOfWords(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3)) {
    let h = 2166136261;
    for (const ch of token) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % dims]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map(x => x / norm);
}

/** Fact markers in a payload, in order of appearance (every fact text starts with one). */
const markers = (facts: R[]) => facts.map(f => String(f.fact).split(' ')[0]);

for (const kind of testBackends()) {
  describe(`recall question ranking (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let dims = 1536;
    let providerCalls: string[] = [];
    const ids: Record<string, number> = {};
    let notices: Notice[] = [];

    const ctxOf = (remote: boolean | undefined): OperationContext => ({
      engine, config: {} as GBrainConfig, logger: noopLogger, dryRun: false, remote: remote as boolean,
      transport: 'stdio', sourceId: 'default', emitNotice: (n: Notice) => notices.push(n),
    } as OperationContext);
    const local = () => ctxOf(false);
    const untrusted = () => [ctxOf(true), ctxOf(undefined)];
    const recall = async (ctx: OperationContext, p: R) => (await operationsByName.recall.handler(ctx, p)) as R;

    function keyed(): void {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-fake' } });
      __setEmbedTransportForTests((async (args: { values: string[] }) => {
        providerCalls.push(...args.values);
        return { embeddings: args.values.map(v => bagOfWords(v, dims)) };
      }) as never);
      providerCalls = [];
    }
    function keyless(): void {
      __setEmbedTransportForTests(null);
      resetGateway();
    }

    async function fact(name: string, f: {
      text: string; entity?: string | null; visibility?: 'world' | 'private'; provenance?: string; daysAgo: number; embed?: boolean; session?: string;
    }): Promise<void> {
      const vec = f.embed === false ? null : `[${bagOfWords(f.text, dims).join(',')}]`;
      const [row] = await engine.executeRaw<{ id: string | number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, created_at, source, source_session, source_markdown_slug,
                            embedding, embedding_model, embedded_text_hash, embedded_at)
         VALUES ('default', $1, $2, 'fact', $3, now() - ($4 || ' days')::interval, now() - ($4 || ' days')::interval, 'test', $5, $6,
                 $7::text::vector, CASE WHEN $7::text IS NULL THEN NULL ELSE $8 END, CASE WHEN $7::text IS NULL THEN NULL ELSE md5($2) END,
                 CASE WHEN $7::text IS NULL THEN NULL ELSE now() END)
         RETURNING id`,
        [f.entity === undefined ? ENTITY : f.entity, f.text, f.visibility ?? 'world', String(f.daysAgo), f.session ?? null, f.provenance ?? 'meetings/open-sync', vec, getEmbeddingModel()]);
      ids[name] = Number(row.id);
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
      const [col] = await engine.executeRaw<{ dims: number }>(`SELECT a.atttypmod AS dims FROM pg_attribute a WHERE a.attrelid = to_regclass('facts') AND a.attname = 'embedding'`);
      dims = Number(col!.dims);
      keyed();
      await engine.putPage(ENTITY, { type: 'person', title: 'Alice Example', compiled_truth: 'Alice is a founder.' });
      await engine.putPage(OTHER, { type: 'person', title: 'Charlie Example', compiled_truth: 'Charlie is an engineer.' });
      await engine.putPage('meetings/open-sync', { type: 'meeting', title: 'open sync', compiled_truth: 'An open meeting.' });
      await engine.putPage('meetings/secret-sync', { type: 'meeting', title: 'secret sync', compiled_truth: 'A private meeting.', frontmatter: { visibility: 'private' } });
      await engine.putPage('notes/scraped', { type: 'note', title: 'scraped listing', compiled_truth: 'Scraped listing.' });
      await fact('roast', { text: 'ROAST Alice Example drinks dark roast coffee every morning', daysAgo: 30, session: SESSION });
      await fact('tea', { text: 'TEA Alice Example switched her afternoon coffee for green tea', daysAgo: 20 });
      await fact('secret', { text: 'SECRETPROV Alice Example coffee roast supplier is a private contract', provenance: 'meetings/secret-sync', daysAgo: 25 });
      await fact('private', { text: 'PRIVVIS Alice Example coffee roast budget', visibility: 'private', daysAgo: 26 });
      await fact('scraped', { text: 'SCRAPED Alice Example coffee roast review', provenance: 'notes/scraped', daysAgo: 27 });
      await fact('unembedded', { text: 'NOVEC Alice Example roast coffee grinder', daysAgo: 28, embed: false });
      await fact('offsite', { text: 'OFFSITE The quarterly offsite moved to Denver', entity: null, daysAgo: 1 });
      await fact('hiring', { text: 'HIRING Charlie Example opened two backend roles', entity: OTHER, daysAgo: 2 });
      await fact('stuffed', {
        text: `STUFFED alice example drink dark roast coffee morning ${Array.from({ length: 120 }, (_, i) => `filler${i.toString(36)}word`).join(' ')}`,
        entity: null, daysAgo: 3, embed: false,
      });
    }, 180_000);
    afterAll(async () => { keyless(); await close?.(); });
    beforeEach(() => { notices = []; __resetPrivateVisibilityCacheForTests(); keyed(); });

    test('without question: facts stay newest first and facts_order says so', async () => {
      const r = await recall(local(), {});
      expect(r.facts_order).toBe('newest');
      expect(markers(r.facts).slice(0, 2)).toEqual(['OFFSITE', 'HIRING']);
      expect(r.facts.every((f: R) => !('relevance' in f))).toBe(true);
    });

    test('with question: relevant facts first, irrelevant newer facts left out, each row carries relevance (descending)', async () => {
      const r = await recall(local(), { question: COFFEE });
      expect(r.facts_order).toBe('relevance');
      const got = markers(r.facts);
      expect(got[0]).toBe('ROAST');
      expect(got).not.toContain('OFFSITE');
      expect(got).not.toContain('HIRING');
      const scores = r.facts.map((f: R) => f.relevance);
      expect(scores.every((s: unknown) => typeof s === 'number' && s > 0)).toBe(true);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    });

    test('a below-threshold question returns an empty list, not the newest facts', async () => {
      const r = await recall(local(), { question: 'zymurgy xylophone quokka' });
      expect(r.facts).toEqual([]);
      expect(r.total).toBe(0);
      expect(r.facts_order).toBe('relevance');
    });

    test('limit caps the ranked list at the top rows', async () => {
      const r = await recall(local(), { question: COFFEE, limit: 1 });
      expect(markers(r.facts)).toEqual(['ROAST']);
    });

    test('read policy: local sees private-provenance and private facts; remote (true and unset) hides both', async () => {
      const localGot = markers((await recall(local(), { question: COFFEE })).facts);
      expect(localGot).toEqual(expect.arrayContaining(['SECRETPROV', 'PRIVVIS']));
      for (const c of untrusted()) {
        const remote = markers((await recall(c, { question: COFFEE })).facts);
        expect(remote).toContain('ROAST');
        expect(remote).not.toContain('SECRETPROV');
        expect(remote).not.toContain('PRIVVIS');
      }
    });

    test('read policy: the operator opt-out (search.remote_private_pages=visible) shows the private-sourced world fact remotely, never the private fact', async () => {
      await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
      __resetPrivateVisibilityCacheForTests();
      try {
        for (const c of untrusted()) {
          const remote = markers((await recall(c, { question: COFFEE })).facts);
          expect(remote).toContain('SECRETPROV');
          expect(remote).not.toContain('PRIVVIS');
        }
      } finally {
        await engine.executeRaw('DELETE FROM config WHERE key = $1', [REMOTE_PRIVATE_PAGES_KEY]);
        __resetPrivateVisibilityCacheForTests();
      }
    });

    test('read policy: a quarantined provenance page hides its fact, local and remote', async () => {
      await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"quarantine": {"reason": "junk_pattern", "detail": "test"}}'::jsonb WHERE slug = 'notes/scraped'`);
      try {
        expect(markers((await recall(local(), { question: COFFEE })).facts)).not.toContain('SCRAPED');
        for (const c of untrusted()) expect(markers((await recall(c, { question: COFFEE })).facts)).not.toContain('SCRAPED');
      } finally {
        await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter - 'quarantine' WHERE slug = 'notes/scraped'`);
      }
      expect(markers((await recall(local(), { question: COFFEE })).facts)).toContain('SCRAPED');
    });

    test('read policy: the trust floor (min_trust) and the rederive hold apply to the ranked list', async () => {
      await engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw('UPDATE facts SET trust_tier = $1 WHERE id = $2', ['external_untrusted', ids.tea])));
      await engine.executeRaw(`INSERT INTO needs_rederive (derived_table, derived_id, source_id, reason) VALUES ('facts', $1, 'default', 'test')`, [String(ids.scraped)]);
      try {
        const all = markers((await recall(local(), { question: COFFEE })).facts);
        expect(all).toContain('TEA');
        expect(all).not.toContain('SCRAPED');
        const floored = markers((await recall(local(), { question: COFFEE, min_trust: 'unknown' })).facts);
        expect(floored).not.toContain('TEA');
        expect(floored).toContain('ROAST');
      } finally {
        await engine.executeRaw(`DELETE FROM needs_rederive WHERE derived_table = 'facts' AND derived_id = $1`, [String(ids.scraped)]);
        await engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw('UPDATE facts SET trust_tier = $1 WHERE id = $2', ['agent_written', ids.tea])));
      }
    });

    test('the question path returns a subset of the newest path under the same filters, local and remote', async () => {
      for (const ctx of [local(), ...untrusted()]) {
        const newest = new Set((await recall(ctx, { entity: ENTITY, limit: 100 })).facts.map((f: R) => f.id));
        const ranked = (await recall(ctx, { entity: ENTITY, question: COFFEE, limit: 100 })).facts.map((f: R) => f.id);
        expect(ranked.length).toBeGreaterThan(0);
        for (const id of ranked) expect(newest.has(id)).toBe(true);
      }
    });

    test('row shape: question rows carry every newest-path key plus relevance, with the same normalized timestamps', async () => {
      const newest = (await recall(local(), { limit: 100 })).facts as R[];
      const ranked = (await recall(local(), { question: COFFEE })).facts as R[];
      const byId = new Map(newest.map(f => [f.id, f]));
      for (const row of ranked) {
        const twin = byId.get(row.id)!;
        expect(Object.keys(row).filter(k => k !== 'relevance').sort()).toEqual(Object.keys(twin).sort());
        const { relevance: _r, ...rest } = row;
        expect(rest).toEqual(twin);
      }
    });

    test('filters compose inside the pool: entity, session_id, since and grep rank within the filtered set', async () => {
      expect(markers((await recall(local(), { question: 'backend roles', entity: OTHER })).facts)).toEqual(['HIRING']);
      expect(markers((await recall(local(), { question: 'backend roles', entity: ENTITY })).facts)).toEqual([]);
      expect(markers((await recall(local(), { question: COFFEE, session_id: SESSION })).facts)).toEqual(['ROAST']);
      const since = markers((await recall(local(), { question: COFFEE, since: '22d' })).facts);
      expect(since).toContain('TEA');
      expect(since).not.toContain('ROAST');
      expect(markers((await recall(local(), { question: COFFEE, grep: 'green tea' })).facts)).toEqual(['TEA']);
    });

    test('invalid combinations refuse with the corrected call as fix.mcp', async () => {
      const refusal = async (p: R) => {
        try { await recall(local(), p); } catch (e) { return e as OperationError; }
        throw new Error('expected a refusal');
      };
      const sup = await refusal({ question: COFFEE, supersessions: true });
      expect(sup.code).toBe('invalid_params');
      expect(sup.fix?.mcp).toEqual({ tool: 'recall', arguments: { question: COFFEE } });
      const exp = await refusal({ question: COFFEE, include_expired: true, entity: ENTITY });
      expect(exp.code).toBe('invalid_params');
      expect(exp.fix?.mcp).toEqual({ tool: 'recall', arguments: { question: COFFEE, entity: ENTITY } });
      const long = await refusal({ question: 'coffee '.repeat(400) });
      expect(long.code).toBe('invalid_params');
      expect(String((long.fix?.mcp?.arguments as R).question).length).toBe(QUESTION_MAX_CHARS);
    });

    test('the admission rule is configurable between the two preregistered rule sets', async () => {
      await engine.setConfig(QUESTION_ADMISSION_KEY, 'facts_arm');
      try {
        const r = await recall(local(), { question: COFFEE });
        expect(r.facts_order).toBe('relevance');
        expect(markers(r.facts)).toContain('ROAST');
        expect(markers(r.facts)).not.toContain('OFFSITE');
      } finally {
        await engine.executeRaw('DELETE FROM config WHERE key = $1', [QUESTION_ADMISSION_KEY]);
      }
    });

    test('term stuffing: a fact holding every question word plus many others does not pass on term share', async () => {
      keyless();
      const r = await recall(local(), { question: COFFEE });
      expect(markers(r.facts)).toContain('ROAST');
      expect(markers(r.facts)).not.toContain('STUFFED');
    });

    test('keyless: term-share ranking with facts_degraded naming the reason; a stopword-only question returns no_query_terms', async () => {
      keyless();
      const r = await recall(local(), { question: COFFEE });
      expect(r.facts_order).toBe('relevance');
      expect(r.facts_degraded).toEqual({ reason: 'keyword_only_no_embedding_provider' });
      expect(markers(r.facts)).toContain('ROAST');
      const none = await recall(local(), { question: 'what is the' });
      expect(none.facts).toEqual([]);
      expect(none.facts_degraded).toEqual({ reason: 'no_query_terms' });
      const stages = recallInteropNotices('recall', none, {}, { question: 'what is the' }, { transport: 'stdio' });
      expect(stages.find(n => n.code === 'degraded_recall')?.why).toContain('no_query_terms');
    });

    test('unembedded facts are counted over the authorized pool and come with the preview-then-approve embed fix', async () => {
      const r = await recall(local(), { question: COFFEE });
      expect(r.facts_degraded?.unembedded).toBe(2);
      const notice = notices.find(n => n.code === 'facts_unembedded')!;
      expect(notice.fix?.argv).toEqual(['gbrain', 'embed', '--stale', '--facts', '--source', 'default', '--dry-run']);
      expect(notice.fix?.then?.consent).toEqual(['paid']);
      await fact('privnovec', { text: 'PRIVNOVEC Alice Example coffee note', visibility: 'private', daysAgo: 29, embed: false });
      try {
        expect((await recall(local(), { question: COFFEE })).facts_degraded?.unembedded).toBe(3);
        for (const c of untrusted()) expect((await recall(c, { question: COFFEE })).facts_degraded?.unembedded).toBe(2);
      } finally {
        await engine.executeRaw('DELETE FROM facts WHERE id = $1', [ids.privnovec]);
      }
    });

    test('unembedded also counts another embedding model and a stale text hash, through the v233 indexes', async () => {
      await fact('othermodel', { text: 'OTHERMODEL Alice Example coffee roast', daysAgo: 31 });
      await fact('stalehash', { text: 'STALEHASH Alice Example coffee roast', daysAgo: 32 });
      await engine.executeRaw(`UPDATE facts SET embedding_model = 'other:model' WHERE id = $1`, [ids.othermodel]);
      await engine.executeRaw(`UPDATE facts SET fact = fact || ' edited' WHERE id = $1`, [ids.stalehash]);
      try {
        expect((await recall(local(), { question: COFFEE })).facts_degraded?.unembedded).toBe(4);
      } finally {
        await engine.executeRaw('DELETE FROM facts WHERE id = ANY($1::bigint[])', [[ids.othermodel, ids.stalehash]]);
      }
    });

    test('v233: the keyword document matches idx_facts_fts and the uncomparable probes have their indexes', async () => {
      const names = (await engine.executeRaw<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'facts' AND indexname IN ('idx_facts_fts', 'idx_facts_unembedded', 'idx_facts_embedding_model') ORDER BY indexname`)).map(r => r.indexname);
      expect(names).toEqual(['idx_facts_embedding_model', 'idx_facts_fts', 'idx_facts_unembedded']);
      // The planner matches an expression index structurally; the deparsed query expression must equal the index's.
      const plan = (await engine.executeRaw<Record<string, string>>(
        `EXPLAIN SELECT f.id FROM facts f WHERE ${factsFtsDocument('f')} @@ plainto_tsquery('${getFtsLanguage()}'::regconfig, 'coffee')`)).map(r => Object.values(r)[0]).join('\n');
      const queried = /to_tsvector\(.*\)\) @@/.exec(plan)?.[0].replace(/ @@$/, '');
      const [{ def }] = await engine.executeRaw<{ def: string }>(`SELECT pg_get_indexdef('idx_facts_fts'::regclass) AS def`);
      expect(queried).toBeTruthy();
      expect(def).toContain(`gin (${queried})`);
      expect(def).toContain('WHERE (expired_at IS NULL)');
      const sent: string[] = [];
      const real = engine.executeRaw;
      engine.executeRaw = function (this: BrainEngine, sql: string, params?: unknown[]) { sent.push(sql); return real.call(this, sql, params); } as typeof real;
      try {
        await recall(local(), { question: COFFEE });
      } finally {
        engine.executeRaw = real;
      }
      expect(sent.find(q => q.includes('plainto_tsquery'))).toContain(`${factsFtsDocument('f')} @@ `);
      // The keyword arm and the uncomparable count each run under a per-call custom plan (cached generic plans nest the policy joins).
      expect(sent.filter(q => q === 'SET LOCAL plan_cache_mode = force_custom_plan')).toHaveLength(2);
    });

    test('the question embedding goes through the gateway cache: a repeat recall, a query+question recall and a query followed by recall embed once', async () => {
      await recall(local(), { question: COFFEE });
      await recall(local(), { question: COFFEE });
      expect(providerCalls.filter(v => v.includes(COFFEE))).toHaveLength(1);
      keyed();
      await recall(local(), { question: COFFEE, query: COFFEE });
      expect(providerCalls.filter(v => v.includes(COFFEE))).toHaveLength(1);
      keyed();
      await operationsByName.query.handler(local(), { query: COFFEE });
      expect(providerCalls.filter(v => v.includes(COFFEE))).toHaveLength(1);
      const ranked = await recall(local(), { question: COFFEE });
      expect(providerCalls.filter(v => v.includes(COFFEE))).toHaveLength(1);
      expect(ranked.facts_order).toBe('relevance');
      expect(ranked.facts_degraded?.reason).toBeUndefined();
    });

    test('recall_hint: query without question or fact filter names question and carries the retry call; otherwise no hint', async () => {
      const r = await recall(local(), { query: COFFEE });
      expect(r.facts_order).toBe('newest');
      const hint = notices.find(n => n.code === 'recall_hint')!;
      expect(hint.kind).toBe('info');
      expect(hint.fix?.mcp).toEqual({ tool: 'recall', arguments: { query: COFFEE, question: COFFEE } });
      for (const p of [{ query: COFFEE, question: COFFEE }, { query: COFFEE, entity: ENTITY }, { query: COFFEE, since: '30d' }, {}]) {
        notices = [];
        await recall(local(), p);
        expect(notices.some(n => n.code === 'recall_hint')).toBe(false);
      }
    });
  });
}
