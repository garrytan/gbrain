/**
 * #6803 part 3: held embedding budgets, surfaced (PGLite, and Postgres via
 * test/e2e/held-embedding-budgets-postgres.test.ts).
 *
 * Protects: one count of the large pages that wait for embedding approval
 * (held or at their per-page cap) against the active vector column, with no
 * row cap, and one phrase for it; `sizeStateLines` names a command that exists
 * (`gbrain embed --held --dry-run --source <id>`, never `gbrain reindex
 * --held`); doctor `partial_embedding` is its own registry entry, so a slow
 * full `pages` scan in the content-sanity entry no longer turns it unknown;
 * its fix is a per-source approve with a concrete N; the embed-backfill job
 * reports `budget_limited` without counting it as a failure; a local model's
 * per-page ledger charges $0 (#6847); the printed N is a ceiling with the
 * `derivedCapUsd` floor.
 * Fails when: any surface goes silent again, truncates at 1,000 rows, or
 * prints a placeholder or a command that does not exist.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChunkInput } from '../src/core/types.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { PAGE_INLINE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { PAGE_EMBED_CAP_KEY, holdPageEmbedding, listBudgetLimitedPages, planPageEmbedding, readPageSizeStates, addSizeState, sizeStateLines } from '../src/core/page-embedding-budget.ts';
import { budgetLimitedField, budgetLimitedFinding, heldEmbedArgv, readBudgetLimited } from '../src/core/held-embedding.ts';
import { FREE_APPROVAL_USD, approvalAmount, budgetLimitedPhrase, ledgerPricePerMTok } from '../src/core/held-embedding-action.ts';
import { derivedCapUsd } from '../src/core/consent.ts';
import { makeEmbedBackfillHandler } from '../src/core/minions/handlers/embed-backfill.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

const BODY = 'Weekly notes from acme-example with alice-example. '.repeat(Math.ceil((PAGE_INLINE_MAX_BYTES + 4096) / 51));
const vector = () => new Float32Array(1536).fill(0.1);

for (const backend of testBackends()) {
  describe(`held embedding budgets (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { resetGateway(); await close(); });
    beforeEach(async () => {
      if (backend === 'pglite') await resetPgliteState(engine as PGLiteEngine);
      else {
        await engine.executeRaw('DELETE FROM page_embedding_budget');
        await engine.executeRaw('DELETE FROM pages');
        await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`);
      }
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('alpha', 'alpha') ON CONFLICT (id) DO NOTHING`);
    });

    /** A large page with `chunks` chunks; the indexes in `embedded` carry a vector. */
    async function largePage(slug: string, sourceId: string, chunks: number, embedded: number[] = []): Promise<number> {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: BODY }, { sourceId });
      const inputs: ChunkInput[] = Array.from({ length: chunks }, (_, i) => ({ chunk_index: i, chunk_text: `chunk ${i} `.padEnd(2000, 'acme-example '),
        chunk_source: 'compiled_truth', token_count: 500, ...(embedded.includes(i) ? { embedding: vector() } : {}) }));
      await installFixtureChunks(engine, slug, inputs, { sourceId });
      const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [slug, sourceId]);
      return Number(row!.id);
    }
    const cap = (pageId: number) => engine.executeRaw(`INSERT INTO page_embedding_budget (page_id, state, reason, spent_usd, cap_usd) VALUES ($1, 'capped', 'cap_reached', 2, 2)
      ON CONFLICT (page_id) DO UPDATE SET state = 'capped', reason = 'cap_reached'`, [pageId]);

    test('the phrase: a held page with one retained vector and a capped page with an embedded chunk', async () => {
      await holdPageEmbedding(engine, await largePage('chats/held', 'default', 3, [2]), 'upgrade_backfill');
      await cap(await largePage('chats/capped', 'alpha', 4, [3]));
      await holdPageEmbedding(engine, await largePage('chats/done', 'default', 2, [0, 1]), 'upgrade_backfill');
      const b = await readBudgetLimited(engine);
      expect(b).toEqual({ held: 1, capped: 1, held_reasons: { upgrade_backfill: 1 }, pending_chunks: 5, by_source: [
        { source_id: 'alpha', held: 0, capped: 1, pending_chunks: 3, pending_chars: 6000 },
        { source_id: 'default', held: 1, capped: 0, pending_chunks: 2, pending_chars: 4000 },
      ] });
      expect(budgetLimitedPhrase(b)).toBe('2 large page(s) have chunks waiting for embedding approval (1 held: upgrade_backfill; 1 at their per-page cap); those chunks are keyword-only until approved.');
      expect((await readBudgetLimited(engine, { sourceId: 'default' })).by_source.map(s => s.source_id)).toEqual(['default']);
    }, 60_000);

    test('a page whose vectors came from another embedding signature still waits', async () => {
      const id = await largePage('chats/old-model', 'default', 2, [0, 1]);
      await holdPageEmbedding(engine, id, 'upgrade_backfill');
      await engine.executeRaw(`UPDATE pages SET embedding_signature = 'openai:text-embedding-3-small:1536' WHERE id = $1`, [id]);
      expect((await readBudgetLimited(engine, { signature: 'openai:text-embedding-3-large:1536' })).pending_chunks).toBe(2);
      expect((await readBudgetLimited(engine, { signature: 'openai:text-embedding-3-small:1536' })).held).toBe(0);
    }, 60_000);

    test('more than 1000 held pages are counted and listed, none truncated', async () => {
      await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at)
        SELECT 'archive/day-' || g, 'default', 'note', 'Day ' || g, repeat('x', ${PAGE_INLINE_MAX_BYTES + 1}), '{}', 'h' || g, now(), now() FROM generate_series(1, 1001) AS g`);
      await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text) SELECT id, 0, 'acme-example notes' FROM pages WHERE slug LIKE 'archive/day-%'`);
      await engine.executeRaw(`INSERT INTO page_embedding_budget (page_id, state, reason) SELECT id, 'held', 'upgrade_backfill' FROM pages WHERE slug LIKE 'archive/day-%'`);
      expect((await readBudgetLimited(engine)).held).toBe(1001);
      expect(await listBudgetLimitedPages(engine, { limit: null })).toHaveLength(1001);
      const listing = await heldEmbedArgv(engine, ['--held', '--dry-run'], null, () => {});
      expect('pages' in listing && listing.pages).toHaveLength(1001);
      const run = await heldEmbedArgv(engine, ['--held', '--max-usd', '1'], null, () => {});
      expect('argv' in run && run.argv.filter(a => a.startsWith('archive/day-'))).toHaveLength(1001);
    }, 60_000);

    test('sizeStateLines names the source-scoped preview that exists, not gbrain reindex --held', async () => {
      await holdPageEmbedding(engine, await largePage('chats/receipt', 'alpha', 2), 'upgrade_backfill');
      const states = await readPageSizeStates(engine, 'alpha', ['chats/receipt']);
      expect(states).toEqual([expect.objectContaining({ slug: 'chats/receipt', embedding: 'held', reason: 'upgrade_backfill', source_id: 'alpha' })]);
      const text = sizeStateLines(states.reduce<ReturnType<typeof addSizeState> | undefined>((t, s) => addSizeState(t, s), undefined)).join('\n');
      expect(text).not.toContain('reindex --held');
      expect(text).toContain('`gbrain embed --held --dry-run --source alpha` previews the cost');
    }, 60_000);

    test('#6847: the per-page ledger prices a free local recipe at $0, so a local model never hits its cap', async () => {
      expect(ledgerPricePerMTok('ollama:nomic-embed-text:768')).toEqual({ rate: 0, priced: true });
      await engine.setConfig(PAGE_EMBED_CAP_KEY, '0');
      const id = await largePage('chats/local', 'default', 3);
      const page = { id, compiled_truth: BODY, timeline: '' };
      const stale = [0, 1, 2].map(chunk_index => ({ chunk_index, chunk_text: 'acme-example '.repeat(200) }));
      const decision = await planPageEmbedding(engine, page, stale, { signature: 'ollama:nomic-embed-text:768' });
      expect(decision.kind).toBe('grant');
      if (decision.kind !== 'grant') return;
      expect(decision.grant.chunkIndexes.size).toBe(3);
      expect(decision.grant.reservedUsd).toBe(0);
      await decision.grant.settle({ ok: true });
      const [row] = await engine.executeRaw<{ spent_usd: number; state: string }>('SELECT spent_usd, state FROM page_embedding_budget WHERE page_id = $1', [id]);
      expect({ spent: Number(row!.spent_usd), state: row!.state }).toEqual({ spent: 0, state: 'open' });
      await engine.unsetConfig(PAGE_EMBED_CAP_KEY);
    }, 60_000);

    test('the printed N is a ceiling: derivedCapUsd of the higher of the run-meter and ledger estimates, $0.01 on a free provider', () => {
      const paid = { model: 'openai:text-embedding-3-small', signature: 'openai:text-embedding-3-small:1536', free: false, charsPerToken: 4 };
      const small = approvalAmount(4000, paid);
      expect(small.max_usd).toBe(0.25);
      const big = approvalAmount(400_000_000, paid);
      expect(big.max_usd).toBe(derivedCapUsd(big.est_usd));
      expect(big.max_usd).toBeGreaterThanOrEqual(big.est_usd * 1.5);
      expect(approvalAmount(400_000_000, { ...paid, model: 'ollama:nomic-embed-text', signature: 'ollama:nomic-embed-text:768', free: true })).toEqual({ est_usd: 0, max_usd: FREE_APPROVAL_USD });
    });

    test('doctor partial_embedding is its own entry and still warns while the content scans are over budget', async () => {
      expect(DOCTOR_CHECK_REGISTRY.filter(e => e.emits.includes('partial_embedding')).map(e => e.emits)).toEqual([['partial_embedding']]);
      await holdPageEmbedding(engine, await largePage('chats/doctor-a', 'default', 3), 'upgrade_backfill');
      await cap(await largePage('chats/doctor-b', 'alpha', 2));
      await engine.setConfig('doctor.entry_budget_ms', '300');
      const slow = new Proxy(engine, {
        get(target, key) {
          if (key === 'executeRaw') {
            return async (sql: string, params?: unknown[], opts?: unknown) => {
              // The held count's size check reads only TOAST size headers; held-budget-count-list.test.ts's 0-TOAST-block work count is the direct guard that partial_embedding never reads bodies.
              if (/octet_length\(p\.compiled_truth\)/.test(sql) && !/page_embedding_budget/.test(sql)) await new Promise(r => setTimeout(r, 1500));
              return target.executeRaw(sql, params, opts as never);
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as BrainEngine;
      try {
        const checks = await buildChecks(slow, ['--json', '--scope=brain', '--only', 'partial_embedding']);
        const check = checks.find(c => c.name === 'partial_embedding')!;
        expect(check.status).toBe('warn');
        expect(check.details?.health).toBeUndefined();
        expect(check.message).toContain('2 large page(s) have chunks waiting for embedding approval (1 held: upgrade_backfill; 1 at their per-page cap)');
        const fix = check.fix as { argv: string[]; preview_argv: string[]; verify: { argv: string[] }; consent: string[]; next?: string };
        expect(fix.argv.slice(0, 6)).toEqual(['gbrain', 'embed', '--held', '--source', 'default', '--max-usd']);
        expect(Number(fix.argv[6])).toBeGreaterThan(0);
        expect(fix.argv.join(' ')).not.toContain('<N>');
        expect(fix.preview_argv.slice(0, 7)).toEqual(['gbrain', 'embed', '--held', '--dry-run', '--source', 'default', '--json']);
        expect(fix.verify.argv.slice(0, 7)).toEqual(fix.preview_argv.slice(0, 7));
        expect(fix.consent).toEqual(['paid', 'egress']);
        const bySource = check.details!.by_source as Array<{ source_id: string; fix: { command: string; next: string } }>;
        expect(bySource.map(s => s.source_id)).toEqual(['default', 'alpha']);
        expect(bySource[1]!.fix.command).toMatch(/^gbrain embed --held --source alpha --max-usd \d+\.\d\d/);
        expect(bySource[1]!.fix.next).toBe('ask_user');
      } finally {
        await engine.unsetConfig('doctor.entry_budget_ms');
      }
    }, 60_000);

    test('doctor partial_embedding is ok when every held page is fully embedded', async () => {
      await holdPageEmbedding(engine, await largePage('chats/complete', 'default', 2, [0, 1]), 'upgrade_backfill');
      expect(await budgetLimitedFinding(engine, null)).toBeNull();
    }, 60_000);

    test('the embed-backfill job reports budget_limited for its source and still succeeds', async () => {
      await holdPageEmbedding(engine, await largePage('chats/job', 'default', 3), 'upgrade_backfill');
      await holdPageEmbedding(engine, await largePage('chats/other', 'alpha', 2), 'upgrade_backfill');
      const controller = new AbortController();
      const job = { id: 1, name: 'embed-backfill', data: { sourceId: 'default' }, attempts_made: 0, signal: controller.signal, deadlineAtMs: null,
        shutdownSignal: controller.signal, updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] } as unknown as MinionJobContext;
      const handler = makeEmbedBackfillHandler(engine, { runStale: async () => ({ embedded: 0, chunksProcessed: 0, pagesProcessed: 0, invalidated: 0, lastCursor: null, done: true, aborted: false }) });
      const result = await handler(job);
      expect(result.status).toBe('success');
      expect(result.budget_limited).toMatchObject({ held: 1, capped: 0, held_reasons: { upgrade_backfill: 1 }, pending_chunks: 3 });
      expect(result.budget_limited!.by_source.map(s => s.source_id)).toEqual(['default']);
      expect(result.budget_limited!.by_source[0]!.fix.command).toMatch(/^gbrain embed --held --source default --max-usd \d+\.\d\d/);
      expect(await budgetLimitedField(engine, 'alpha', null)).toMatchObject({ budget_limited: { held: 1 } });
    }, 60_000);

    test('#7193: an incomplete embed-backfill counts the held pages\' chunks in "N chunks remain" and names them', async () => {
      await holdPageEmbedding(engine, await largePage('chats/held-remaining', 'default', 3), 'upgrade_backfill');
      await holdPageEmbedding(engine, await largePage('chats/held-elsewhere', 'alpha', 2), 'upgrade_backfill');
      const controller = new AbortController();
      const job = { id: 1, name: 'embed-backfill', data: { sourceId: 'default' }, attempts_made: 0, signal: controller.signal, deadlineAtMs: null,
        shutdownSignal: controller.signal, updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {}, isActive: async () => true, readInbox: async () => [] } as unknown as MinionJobContext;
      const handler = makeEmbedBackfillHandler(engine, { runStale: async () => ({ embedded: 0, chunksProcessed: 0, pagesProcessed: 0, invalidated: 0, lastCursor: null, done: true, aborted: false,
        remaining: 2, blocked: 1, complete: false }) });
      await expect(handler(job)).rejects.toThrow('embed-backfill: incomplete; 5 chunks remain (3 of them on 1 large page(s) held for approval or at their spend cap; gbrain embed --held --dry-run --source default lists them) and 1 projections are blocked.');
    }, 60_000);
  });
}
