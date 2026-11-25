/**
 * Nightly learning PR 1: the learning ledger (learning_items), the learning_derive cycle phase and the learned read op.
 *
 * 1. Protects: one cycle on a repo-less brain records a pointer for each new thing it learned (an extractor's fact, a
 *    Facts fence row the owner typed, a keyless claim conflict, a promise owed to the owner, a page enrich filled) and
 *    learned renders each from its live target; a second cycle records nothing twice; a 500-pair claim-conflict backlog
 *    stays one count; forget, purge and a relabel each hide their item and the ledger never holds the item's text;
 *    remote callers read at their own scope (a world-scope token loses a private fact, the owner's token reads what a
 *    local call reads); another source's items stay out of a source-scoped caller; showing stamps shown_at; a missing
 *    table and an engine without raw SQL refuse cleanly; the per-night stats count only change items that were kept or
 *    shown and not undone.
 * 2. Fails when: derive copies text into the ledger, records an item twice, turns the backlog into items, or reads a
 *    fence row as learned; learned shows a withdrawn, purged or relabelled target, or widens or narrows a caller's read.
 * 3. Real seams: PGLite (and Postgres when DATABASE_URL is set) with no git repository, runCycle, tokens minted by the
 *    token service and verified as serve --http does, dispatched through MCP dispatch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runCycle } from '../src/core/cycle.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests, OWNER_MEMBER_KEY } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runPhaseLearningDerive, LEARNING_WATERMARK_KEY } from '../src/core/learning/derive.ts';
import { countsTowardBar, formatLearnedStats, learnedStats, nightOf } from '../src/core/learning/stats.ts';
import { formatResult } from '../src/cli/main.ts';
import { openAsPreview } from '../src/cli/as-preview.ts';
import { formatLearned, type LearnedView } from '../src/core/learning/read.ts';
import { QUARANTINE_KEY } from '../src/core/quarantine.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

const SRC = 'source-a';
const OWNER = 'alice-example';
const ENTITY = 'people/bob-example';
const COMPANY = 'companies/acme-example';

const fence = (rows: string[]) => ['## Facts', '', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|', ...rows, '<!--- gbrain:facts:end -->', ''].join('\n');
const page = (type: string, title: string, body: string, fm: string[] = []) => ['---', `type: ${type}`, `title: ${title}`, ...fm, '---', `# ${title}`, '', body].join('\n');

for (const backend of testBackends()) {
  describe(`learning ledger (${backend}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    const parse = (out: { isError?: boolean; content: Array<{ text: string }> }) => {
      const text = out.content.map(c => c.text).join('\n');
      if (out.isError) throw Object.assign(new Error(text), { body: text });
      return JSON.parse(out.content[0]!.text);
    };
    const local = async (op: string, params: Record<string, unknown> = {}) => parse(await dispatchToolCall(engine, op, params, { remote: false, sourceId: SRC }));
    const remote = async (who: string, params: Record<string, unknown>): Promise<LearnedView> => {
      __resetPrivateVisibilityCacheForTests();
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      return parse(await dispatchToolCall(engine, 'learned', params, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      }));
    };
    const derive = async () => (await runCycle(engine, { brainDir: null, phases: ['learning_derive'] })).phases.find(p => p.phase === 'learning_derive')!;
    const insertFact = async (fact: string, opts: { source?: string; visibility?: 'private' | 'world'; entity?: string | null; page?: string | null; ageDays?: number; claim?: [string, number] } = {}) => {
      const [row] = await engine.executeRaw<{ id: number | string }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, created_at, claim_metric, claim_value, claim_unit, claim_period, valid_from)
        VALUES ($1, $2, $3, 'fact', $4, $5, $6, now() - make_interval(days => $7), $8, $9, CASE WHEN $8::text IS NULL THEN NULL ELSE 'USD' END, CASE WHEN $8::text IS NULL THEN NULL ELSE 'monthly' END, now() - make_interval(days => $7)) RETURNING id`,
        [SRC, opts.entity === undefined ? ENTITY : opts.entity, fact, opts.visibility ?? 'private', opts.source ?? 'mcp:extract_facts', opts.page ?? null, opts.ageDays ?? 0, opts.claim?.[0] ?? null, opts.claim?.[1] ?? null]);
      return Number(row!.id);
    };
    const mentions = (view: LearnedView, canary: string) => view.items.some(i => i.text.includes(canary));
    const ledgerText = async () => JSON.stringify(await engine.executeRaw('SELECT to_jsonb(li) AS row FROM learning_items li'));

    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await importFromContent(engine, ENTITY, page('person', 'Bob Example', 'Bob is a founder.'), { sourceId: SRC });
      await importFromContent(engine, COMPANY, page('company', 'Acme Example', 'Acme sells widgets.'), { sourceId: SRC });
      for (const id of [OWNER, 'carol-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      const mint = async (name: string, member?: string) => {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
        else await readsUnscopedOnPurpose(engine, minted.id);
      };
      await mint('owner', OWNER);
      await mint('member', 'carol-example');
      await mint('unbound');
      await setOwner(engine, OWNER);
    }, 240_000);

    afterAll(async () => { await close?.(); }, 60_000);

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM learning_items');
      await engine.executeRaw('DELETE FROM facts WHERE source_id = $1', [SRC]);
      await engine.executeRaw('DELETE FROM open_loops WHERE source_id = $1', [SRC]);
      await engine.executeRaw("DELETE FROM decide_proposals WHERE sweep_id LIKE 'claim_conflicts:%'");
      await engine.executeRaw('DELETE FROM config WHERE key = $1', [LEARNING_WATERMARK_KEY]);
    });

    test('one cycle records what it learned, each kind rendered live from its target; a fence row is you_wrote and never counts', async () => {
      await importFromContent(engine, 'people/dana-example', page('person', 'Dana Example', `Dana runs a bakery.\n\n${fence(['| 1 | Dana bakes sourdough on Fridays | fact | 1.0 | private | medium | 2026-01-01 |  |  |  |'])}`), { sourceId: SRC });
      const extracted = await insertFact('Bob moved to Lisbon in 2026');
      await insertFact('Bob likes jazz (an imported fixture, not learned)', { source: 'fixture' });
      const [loop] = await engine.executeRaw<{ id: number | string }>(`INSERT INTO open_loops (source_id, dedup_key, loop_type, counterparty_slug, summary, detector)
        VALUES ($1, 'promise-1', 'commitment_owed_to_me', $2, 'Bob will send the signed contract by Friday', 'llm_extract') RETURNING id`, [SRC, ENTITY]);

      const extract = await runCycle(engine, { brainDir: null, sourceId: SRC, phases: ['extract_facts'] });
      expect(extract.phases.find(p => p.phase === 'extract_facts')!.details).toMatchObject({ factsInserted: 1 });
      const phase = await derive();
      expect(phase.status).toBe('ok');
      expect(phase.details.recorded).toMatchObject({ fact_added: 1, you_wrote: 1, promise_found: 1 });
      expect(typeof phase.details.run_id).toBe('string');
      const runIds = await engine.executeRaw<{ run_id: string }>('SELECT DISTINCT run_id::text AS run_id FROM learning_items');
      expect(runIds).toEqual([{ run_id: phase.details.run_id as string }]);

      const view = await local('learned', {}) as LearnedView;
      const byKind = Object.fromEntries(view.items.map(i => [i.kind, i]));
      expect(view.items.map(i => i.kind)).toEqual(['promise_found', 'fact_added', 'you_wrote']);
      expect(byKind.fact_added).toMatchObject({ family: 'change', text: 'Bob moved to Lisbon in 2026', subject: ENTITY });
      expect(byKind.fact_added.evidence[0]).toMatchObject({ fact_id: String(extracted), source_id: SRC, slug: ENTITY });
      expect(byKind.you_wrote).toMatchObject({ family: 'informational', text: 'Dana bakes sourdough on Fridays' });
      expect(byKind.promise_found).toMatchObject({ family: 'change', text: 'Bob will send the signed contract by Friday' });
      expect(byKind.promise_found.evidence[0].loop_id).toBe(String(Number(loop!.id)));
      expect(view.items.map(i => i.n)).toEqual([1, 2, 3]);
      expect(await ledgerText()).not.toContain('Lisbon');

      const text = formatLearned(view);
      expect(text).toContain('Promises people made to you');
      expect(text).toContain(`[item ${byKind.fact_added.id}]`);
      expect(text).toContain('You wrote');

      const stats = (await local('learned', { stats: true })).stats;
      expect(stats.nights).toHaveLength(1);
      expect(stats.nights[0]).toMatchObject({ change_items: 2, shown: 2, counted: 2, you_wrote: 1 });
    });

    test('two cycles in one window record one set of items', async () => {
      await insertFact('Bob joined the board of Acme Example');
      const first = await derive();
      const second = await derive();
      expect((first.details.recorded as Record<string, number>).fact_added).toBe(1);
      expect(Object.values(second.details.recorded as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(0);
      expect(await engine.executeRaw('SELECT count(*)::int AS n FROM learning_items')).toEqual([{ n: 1 }]);
      expect(second.details.run_id).not.toBe(first.details.run_id);
    });

    test('a keyless claim conflict in the window is one question item; a 500-pair backlog stays one count', async () => {
      await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, created_at, valid_from, claim_metric, claim_value, claim_unit, claim_period)
        SELECT $1, 'companies/backlog-' || g, 'Backlog MRR ' || g, 'fact', 'world', 'fixture', now() - interval '40 days', now() - interval '40 days', 'mrr', g, 'USD', 'monthly'
          FROM generate_series(1, 1000) g`, [SRC]);
      await engine.executeRaw(`INSERT INTO decide_proposals (source_id, sweep_id, pair_index, new_fact_id, old_fact_id, p_supersede, proposal_floor, created_at)
        SELECT $1, 'claim_conflicts:backlog', g, n.id, o.id, 0.9, 0.5, now() - interval '40 days'
          FROM generate_series(1, 500) g
          JOIN facts n ON n.source_id = $1 AND n.fact = 'Backlog MRR ' || (2 * g)
          JOIN facts o ON o.source_id = $1 AND o.fact = 'Backlog MRR ' || (2 * g - 1)`, [SRC]);
      await insertFact('Acme MRR is 40000', { entity: COMPANY, visibility: 'world', source: 'fixture', ageDays: 1, claim: ['mrr', 40000] });
      await insertFact('Acme MRR is 45000', { entity: COMPANY, visibility: 'world', source: 'fixture', claim: ['mrr', 45000] });
      await engine.setConfig('dream.claim_conflicts.mode', 'propose');
      try {
        const report = await runCycle(engine, { brainDir: null, phases: ['claim_conflicts', 'learning_derive'] });
        const phase = report.phases.find(p => p.phase === 'learning_derive')!;
        expect(report.phases.find(p => p.phase === 'claim_conflicts')!.status).not.toBe('fail');
        expect(phase.details).toMatchObject({ conflict_backlog: 500 });
        expect((phase.details.recorded as Record<string, number>).conflict_found).toBe(1);
      } finally {
        await engine.executeRaw("DELETE FROM config WHERE key = 'dream.claim_conflicts.mode'");
      }
      expect(await engine.executeRaw("SELECT count(*)::int AS n FROM learning_items WHERE kind = 'conflict_found'")).toEqual([{ n: 1 }]);
      const started = Date.now();
      const view = await local('learned', {}) as LearnedView;
      for (let i = 0; i < 3; i++) await local('learned', { since: '2000-01-01' });
      expect(Date.now() - started).toBeLessThan(5_000);
      const conflicts = view.items.filter(i => i.kind === 'conflict_found');
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({ family: 'question', text: 'Newer: Acme MRR is 45000\nOlder: Acme MRR is 40000' });
      expect(view.conflict_backlog).toEqual({ count: 500, command: ['gbrain', 'decide', 'proposals', 'list'] });
      expect(formatLearned(view)).toContain('500 older pair(s) of disagreeing facts are waiting');
      await engine.executeRaw("DELETE FROM facts WHERE source_id = $1 AND (fact LIKE 'Backlog MRR %' OR fact LIKE 'Acme MRR %')", [SRC]);
    });

    test('forget, purge and a relabel each hide the item, and the ledger never stores its text', async () => {
      const forgotten = await insertFact('Bob owns a red canoe canaryforget');
      await importFromContent(engine, 'people/erin-example', page('person', 'Erin Example', 'Erin is a stub.'), { sourceId: SRC });
      const before = await engine.readPageSnapshot('people/erin-example', { sourceId: SRC });
      await local('put_page', { slug: 'people/erin-example', expected_revision: before!.revision,
        content: page('person', 'Erin Example', 'Erin founded a lighthouse museum canarypurge in 2019.', [`enriched_at: ${new Date().toISOString()}`, 'enriched_by: cli:enrich']) });
      await importFromContent(engine, 'notes/harbor-example', page('note', 'Harbor', 'Harbor notes.'), { sourceId: SRC });
      const relabelled = await insertFact('The harbor ferry leaves at noon canaryrelabel', { visibility: 'world', entity: null, page: 'notes/harbor-example' });

      const recorded = (await derive()).details.recorded as Record<string, number>;
      expect(recorded).toMatchObject({ fact_added: 2, page_filled: 1 });
      const ids = new Set((await local('learned', { since: '2000-01-01' }) as LearnedView).items.map(i => i.text));
      expect(ids).toEqual(new Set(['Bob owns a red canoe canaryforget', 'The harbor ferry leaves at noon canaryrelabel', 'Filled in the thin page Erin Example']));
      expect(mentions(await remote('unbound', { since: '2000-01-01' }), 'canaryrelabel')).toBe(true);

      expect((await dispatchToolCall(engine, 'forget_fact', { id: forgotten }, { remote: false, sourceId: SRC })).isError).not.toBe(true);
      const erin = await engine.readPageSnapshot('people/erin-example', { sourceId: SRC });
      await local('delete_page', { slug: 'people/erin-example', purge: true, expected_revision: erin!.revision });
      await importFromContent(engine, 'notes/harbor-example', page('note', 'Harbor', 'Harbor notes.', ['visibility: private']), { sourceId: SRC });

      const after = (await local('learned', { since: '2000-01-01' }) as LearnedView).items.map(i => i.text);
      expect(after).toEqual(['The harbor ferry leaves at noon canaryrelabel']);
      expect(mentions(await remote('unbound', { since: '2000-01-01' }), 'canaryrelabel')).toBe(false);
      expect(mentions(await remote('owner', { since: '2000-01-01' }), 'canaryrelabel')).toBe(true);
      const stored = await ledgerText();
      for (const canary of ['canaryforget', 'canarypurge', 'canaryrelabel', 'lighthouse']) expect(stored).not.toContain(canary);

      expect((await derive()).details.pruned).toBe(1);
      expect(await engine.executeRaw("SELECT count(*)::int AS n FROM learning_items WHERE kind = 'page_filled'")).toEqual([{ n: 0 }]);
    });

    test('remote=true: a private fact is hidden from world-scope tokens and shown to the owner token, which reads what a local call reads', async () => {
      await insertFact('Bob is negotiating a raise canaryprivate', { visibility: 'private' });
      await insertFact('Bob speaks Portuguese canaryworld', { visibility: 'world' });
      await derive();
      const seen = (v: LearnedView) => ({ ids: v.items.map(i => i.id).sort(), private: mentions(v, 'canaryprivate'), world: mentions(v, 'canaryworld') });
      const localView = await local('learned', { since: '2000-01-01' }) as LearnedView;
      expect(localView.items.map(i => i.text).sort()).toEqual(['Bob is negotiating a raise canaryprivate', 'Bob speaks Portuguese canaryworld']);
      expect(seen(await remote('owner', { since: '2000-01-01' }))).toEqual(seen(localView));
      for (const who of ['unbound', 'member']) {
        const view = await remote(who, { since: '2000-01-01' });
        expect(view.items).toHaveLength(1);
        expect(seen(view)).toMatchObject({ private: false, world: true });
      }
      const memberStats = (await remote('member', { stats: true }) as unknown as { stats: { scope: string; nights: Array<{ change_items: number }> } }).stats;
      expect(memberStats.scope).toBe('readable');
      expect(memberStats.nights[0]!.change_items).toBe(1);
      const ownerStats = (await remote('owner', { stats: true }) as unknown as { stats: { scope: string; nights: Array<{ change_items: number }> } }).stats;
      expect(ownerStats).toMatchObject({ scope: 'ledger' });
      expect(ownerStats.nights[0]!.change_items).toBe(2);
    });

    test('another source\'s items stay out of a caller scoped to source-a, local or remote', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT (id) DO NOTHING");
      await engine.executeRaw("INSERT INTO facts (source_id, fact, kind, visibility, source) VALUES ('source-b', 'Bob collects stamps canaryother', 'fact', 'world', 'mcp:extract_facts')");
      await insertFact('Bob sails on weekends canaryhere', { visibility: 'world' });
      try {
        expect((await derive()).details.recorded).toMatchObject({ fact_added: 2 });
        const localView = await local('learned', { since: '2000-01-01' }) as LearnedView;
        expect({ here: mentions(localView, 'canaryhere'), other: mentions(localView, 'canaryother') }).toEqual({ here: true, other: false });
        for (const who of ['owner', 'unbound']) {
          const view = await remote(who, { since: '2000-01-01' });
          expect({ here: mentions(view, 'canaryhere'), other: mentions(view, 'canaryother') }).toEqual({ here: true, other: false });
        }
      } finally {
        await engine.executeRaw("DELETE FROM facts WHERE source_id = 'source-b'");
      }
    });

    test('showing stamps shown_at: the default view lists only what the caller has not seen; since lists everything again', async () => {
      await insertFact('Bob runs marathons');
      await derive();
      expect((await local('learned', {}) as LearnedView).count).toBe(1);
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM learning_items WHERE shown_at IS NOT NULL'))[0]!.n).toBe(1);
      expect((await local('learned', {}) as LearnedView).count).toBe(0);
      expect((await local('learned', { since: '2000-01-01' }) as LearnedView).count).toBe(1);
    });

    test('only a reader of the whole ledger stamps: a world-scope token and a local --as preview leave the owner\'s unseen view intact', async () => {
      await insertFact('Bob plays chess canarystamp', { visibility: 'world' });
      await derive();
      for (const who of ['unbound', 'member']) expect(mentions(await remote(who, {}), 'canarystamp')).toBe(true);
      const as = await openAsPreview(engine, 'carol-example', 'learned', true);
      const preview = await as.run(() => operationsByName.learned!.handler(as.context({ engine, remote: false, sourceId: SRC, config: {} as never, logger: console as never, dryRun: false }) as never, {})) as LearnedView;
      expect(mentions(preview, 'canarystamp')).toBe(true);
      expect(await engine.executeRaw('SELECT count(*)::int AS n FROM learning_items WHERE shown_at IS NOT NULL')).toEqual([{ n: 0 }]);
      expect(mentions(await local('learned', {}) as LearnedView, 'canarystamp')).toBe(true);
      expect(await engine.executeRaw('SELECT count(*)::int AS n FROM learning_items WHERE shown_at IS NOT NULL')).toEqual([{ n: 1 }]);
    });

    test('the user\'s own unbound stdio agent on a brain with no owner stamps: the second call shows nothing new', async () => {
      await insertFact('Bob sails boats canarypipe', { visibility: 'world' });
      await derive();
      await engine.unsetConfig(OWNER_MEMBER_KEY);
      try {
        const pipe = async () => {
          __resetPrivateVisibilityCacheForTests();
          return parse(await dispatchToolCall(engine, 'learned', {}, { remote: true, transport: 'stdio', sourceId: SRC })) as LearnedView;
        };
        expect(mentions(await pipe(), 'canarypipe')).toBe(true);
        expect(await engine.executeRaw('SELECT count(*)::int AS n FROM learning_items WHERE shown_at IS NOT NULL')).toEqual([{ n: 1 }]);
        expect((await pipe()).count).toBe(0);
      } finally {
        await setOwner(engine, OWNER);
        __resetPrivateVisibilityCacheForTests();
      }
    });

    test('learned hides a fact whose provenance page is quarantined, as every other fact read does', async () => {
      await importFromContent(engine, 'notes/quarantine-example', page('note', 'Quarantine', 'Quarantine notes.'), { sourceId: SRC });
      await insertFact('The vault code is kept in the shed canaryquarantine', { visibility: 'world', entity: null, page: 'notes/quarantine-example' });
      await derive();
      try {
        await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || jsonb_build_object($1::text, true) WHERE source_id = $2 AND slug = 'notes/quarantine-example'`, [QUARANTINE_KEY, SRC]);
        expect(mentions(await local('learned', { since: '2000-01-01' }) as LearnedView, 'canaryquarantine')).toBe(false);
      } finally {
        await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter - $1::text WHERE source_id = $2 AND slug = 'notes/quarantine-example'`, [QUARANTINE_KEY, SRC]);
      }
    });

    test('an impossible enriched_at date (Nov 31) skips only that page: promises still record and the phase stays ok', async () => {
      await importFromContent(engine, 'people/frank-example', page('person', 'Frank Example', 'Frank is a stub.'), { sourceId: SRC });
      await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"enriched_at": "2026-11-31T00:00:00Z", "enriched_by": "cli:enrich"}'::jsonb, updated_at = now() WHERE source_id = $1 AND slug = 'people/frank-example'`, [SRC]);
      await engine.executeRaw(`INSERT INTO open_loops (source_id, dedup_key, loop_type, counterparty_slug, summary, detector)
        VALUES ($1, 'promise-baddate', 'commitment_owed_to_me', $2, 'Bob will return the ladder', 'llm_extract')`, [SRC, ENTITY]);
      try {
        const phase = await derive();
        expect(phase.status).toBe('ok');
        expect(phase.details.recorded).toMatchObject({ promise_found: 1 });
      } finally {
        await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter - 'enriched_at' - 'enriched_by' WHERE source_id = $1 AND slug = 'people/frank-example'`, [SRC]);
      }
    });

    test('limit 20 prints and stamps 20: what is stamped is what is shown', async () => {
      for (let i = 1; i <= 20; i++) await insertFact(`Bob fact number ${i}`);
      await derive();
      const view = await local('learned', { limit: 20 }) as LearnedView;
      expect(view.count).toBe(20);
      const text = formatLearned(view);
      expect(text).toContain('(20 items)');
      for (const item of view.items) expect(text).toContain(`[item ${item.id}]`);
      expect(await engine.executeRaw('SELECT count(*)::int AS n FROM learning_items WHERE shown_at IS NOT NULL')).toEqual([{ n: 20 }]);
    });

    test('a claim-conflict proposal created in the window is itemized even when its newer fact is older; one created before stays a count', async () => {
      const oldA = await insertFact('Acme ARR is 1000', { entity: COMPANY, visibility: 'world', source: 'fixture', ageDays: 30, claim: ['arr', 1000] });
      const oldB = await insertFact('Acme ARR is 2000', { entity: COMPANY, visibility: 'world', source: 'fixture', ageDays: 20, claim: ['arr', 2000] });
      const oldC = await insertFact('Acme ARR is 3000', { entity: COMPANY, visibility: 'world', source: 'fixture', ageDays: 20, claim: ['arr', 3000] });
      await engine.executeRaw(`INSERT INTO decide_proposals (source_id, sweep_id, pair_index, new_fact_id, old_fact_id, p_supersede, proposal_floor, created_at)
        VALUES ($1, 'claim_conflicts:window', 1, $2, $3, 0.9, 0.5, now()), ($1, 'claim_conflicts:window', 2, $4, $3, 0.9, 0.5, now() - interval '20 days')`, [SRC, oldB, oldA, oldC]);
      const phase = await derive();
      expect((phase.details.recorded as Record<string, number>).conflict_found).toBe(1);
      expect(phase.details.conflict_backlog).toBe(1);
    });

    test('a kept item survives its target\'s removal; a pending one is pruned; the read view hides both', async () => {
      const kept = await insertFact('Bob keeps bees canarykept');
      const pending = await insertFact('Bob keeps goats canarypending');
      await derive();
      await engine.executeRaw("UPDATE learning_items SET state = 'kept', decided_at = now() WHERE target_table = 'facts' AND target_id = $1", [kept]);
      await engine.executeRaw('DELETE FROM facts WHERE id = ANY($1::bigint[])', [[kept, pending]]);
      expect((await derive()).details.pruned).toBe(1);
      expect(await engine.executeRaw<{ state: string }>('SELECT state FROM learning_items')).toEqual([{ state: 'kept' }]);
      expect((await local('learned', { since: '2000-01-01' }) as LearnedView).count).toBe(0);
    });

    test('a remote caller with no resolved source scope is refused', async () => {
      await expect(operationsByName.learned!.handler({ engine, remote: true, config: {} as never, logger: console as never, dryRun: false } as never, {}))
        .rejects.toMatchObject({ code: 'permission_denied' });
    });

    test('a dry run writes no rows, prunes nothing and leaves the watermark', async () => {
      await insertFact('Bob reads poetry');
      await engine.executeRaw(`INSERT INTO learning_items (run_id, source_id, kind, target_table, target_id) VALUES ('00000000-0000-4000-8000-000000000000', $1, 'fact_added', 'facts', 999999999)`, [SRC]);
      const phase = await runPhaseLearningDerive(engine, { runId: '00000000-0000-4000-8000-000000000001', dryRun: true });
      expect(phase).toMatchObject({ status: 'ok', details: { dry_run: true, pruned: 0 } });
      expect((phase.details.recorded as Record<string, number>).fact_added).toBe(1);
      expect(await engine.executeRaw<{ target_id: string | number }>('SELECT target_id FROM learning_items')).toHaveLength(1);
      expect(await engine.getConfig(LEARNING_WATERMARK_KEY)).toBeNull();
    });

    test('a pass truncated at the per-kind cap keeps the old watermark and the next pass records the rest', async () => {
      for (const n of [1, 2, 3]) await insertFact(`Bob visited city ${n}`);
      const run = (id: string) => runPhaseLearningDerive(engine, { runId: id, dryRun: false, maxPerKind: 2 });
      const first = await run('00000000-0000-4000-8000-000000000002');
      expect(first.details).toMatchObject({ recorded: { fact_added: 2 }, truncated: ['fact_added', 'you_wrote'] });
      expect(await engine.getConfig(LEARNING_WATERMARK_KEY)).toBeNull();
      const second = await run('00000000-0000-4000-8000-000000000003');
      expect(second.details).toMatchObject({ recorded: { fact_added: 1 }, truncated: [] });
      expect(await engine.getConfig(LEARNING_WATERMARK_KEY)).not.toBeNull();
    });

    test('a failed ledger write is a warn result, never a throw', async () => {
      await insertFact('Bob paints murals');
      const failing = new Proxy(engine, { get(target, key) {
        if (key === 'executeRaw') return (sql: string, params?: unknown[]) => /INSERT INTO learning_items/.test(sql) ? Promise.reject(new Error('disk full (test)')) : target.executeRaw(sql, params);
        const value = (target as unknown as Record<PropertyKey, unknown>)[key];
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const phase = await runPhaseLearningDerive(failing, { runId: '00000000-0000-4000-8000-000000000004', dryRun: false });
      expect(phase.status).toBe('warn');
      expect(phase.details.failed).toContainEqual({ kinds: ['fact_added', 'you_wrote'], error: 'disk full (test)' });
      expect(await engine.getConfig(LEARNING_WATERMARK_KEY)).toBeNull();
    });

    test('learned refuses an invalid since or limit with invalid_params', async () => {
      for (const params of [{ since: 'not-a-date' }, { limit: 0 }, { limit: 1.5 }]) await expect(local('learned', params)).rejects.toThrow(/invalid_param/);
    });

    test('a brain behind the migration: the phase skips with a reason and learned refuses with migrations_pending', async () => {
      await engine.executeRaw('ALTER TABLE learning_items RENAME TO learning_items_away');
      try {
        const phase = await derive();
        expect(phase).toMatchObject({ status: 'skipped', details: { reason: 'learning_table_missing' } });
        await expect(local('learned', {})).rejects.toThrow(/migrations_pending|learning ledger/);
      } finally {
        await engine.executeRaw('ALTER TABLE learning_items_away RENAME TO learning_items');
      }
    });
  });
}

describe('learning ledger without a SQL engine', () => {
  test('learned refuses with engine_capability_missing and the phase skips', async () => {
    const engine = { kind: 'rust', capabilities: new Set() } as unknown as BrainEngine;
    await expect(operationsByName.learned!.handler({ engine, remote: false, config: {} as never, logger: console as never, dryRun: false } as never, {}))
      .rejects.toMatchObject({ code: 'engine_capability_missing' });
    expect(await runPhaseLearningDerive(engine, { runId: '00000000-0000-4000-8000-000000000000', dryRun: false }))
      .toMatchObject({ status: 'skipped', details: { reason: 'engine_capability_missing' } });
  });
});

describe('learned stats: the night and the bar', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); }, 240_000);
  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  test('stats over more rows than the cap keep the newest nights and say they were truncated; the CLI prints the nights table', async () => {
    await engine.executeRaw('DELETE FROM learning_items');
    await engine.setConfig('brain.timezone', 'UTC');
    for (const [id, at] of [[1, '2026-11-18T12:00:00Z'], [2, '2026-11-19T12:00:00Z'], [3, '2026-11-20T12:00:00Z']] as const) {
      await engine.executeRaw(`INSERT INTO learning_items (run_id, source_id, kind, target_table, target_id, state, created_at)
        VALUES ('00000000-0000-4000-8000-000000000000', 'default', 'fact_added', 'facts', $1, 'kept', $2::timestamptz)`, [id, at]);
    }
    const stats = await learnedStats(engine, { engine, remote: false } as never, { sourceIds: null, since: new Date('2026-11-01T00:00:00Z'), rowCap: 2 });
    expect(stats.truncated).toBe(true);
    expect(stats.nights.map(n => n.night)).toEqual(['2026-11-19', '2026-11-20']);
    expect(formatLearnedStats(stats)).toMatch(/truncated/i);
    const full = await learnedStats(engine, { engine, remote: false } as never, { sourceIds: null, since: new Date('2026-11-01T00:00:00Z') });
    expect(full.truncated).toBe(false);
    const text = formatResult('learned', { stats: full }, {});
    expect(text).toContain('Nights since 2026-11-01');
    for (const night of ['2026-11-18', '2026-11-19', '2026-11-20']) expect(text).toContain(`  ${night}: 1 counted of 1 changes`);
    await engine.executeRaw('DELETE FROM learning_items');
  });

  test('a night is the local day ending 06:00 in the brain timezone', () => {
    expect(nightOf(new Date('2026-11-24T05:59:00Z'), 'UTC')).toBe('2026-11-23');
    expect(nightOf(new Date('2026-11-24T06:00:00Z'), 'UTC')).toBe('2026-11-24');
    expect(nightOf(new Date('2026-11-24T10:30:00Z'), 'America/New_York')).toBe('2026-11-23');
    expect(nightOf(new Date('2026-11-24T11:30:00Z'), 'America/New_York')).toBe('2026-11-24');
  });

  test('the bar counts change items kept, or shown and not undone within 7 days; never expired, unseen or you_wrote', () => {
    const shown = '2026-11-20T08:00:00.000Z';
    expect(countsTowardBar({ kind: 'fact_added', state: 'kept', shown_at: null, decided_at: null })).toBe(true);
    expect(countsTowardBar({ kind: 'fact_added', state: 'pending', shown_at: shown, decided_at: null })).toBe(true);
    expect(countsTowardBar({ kind: 'fact_added', state: 'pending', shown_at: null, decided_at: null })).toBe(false);
    expect(countsTowardBar({ kind: 'page_filled', state: 'undone', shown_at: shown, decided_at: '2026-11-21T08:00:00.000Z' })).toBe(false);
    expect(countsTowardBar({ kind: 'page_filled', state: 'undone', shown_at: shown, decided_at: '2026-11-28T08:00:01.000Z' })).toBe(true);
    expect(countsTowardBar({ kind: 'promise_found', state: 'expired', shown_at: shown, decided_at: null })).toBe(false);
    expect(countsTowardBar({ kind: 'you_wrote', state: 'kept', shown_at: shown, decided_at: null })).toBe(false);
    expect(countsTowardBar({ kind: 'conflict_found', state: 'answered', shown_at: shown, decided_at: null })).toBe(false);
  });

  test('stats group ledger rows by night in brain.timezone and report the share of nights at the bar', async () => {
    await engine.setConfig('brain.timezone', 'America/New_York');
    const rows: Array<[string, string, string, string | null]> = [];
    for (let i = 0; i < 5; i++) rows.push(['fact_added', 'pending', '2026-11-20T15:00:00Z', '2026-11-20T16:00:00Z']);
    rows.push(['fact_added', 'expired', '2026-11-20T15:00:00Z', '2026-11-20T16:00:00Z'], ['you_wrote', 'pending', '2026-11-20T15:00:00Z', null]);
    rows.push(['page_filled', 'kept', '2026-11-21T15:00:00Z', null], ['conflict_found', 'answered', '2026-11-21T15:00:00Z', '2026-11-21T16:00:00Z']);
    rows.push(['fact_added', 'pending', '2026-11-22T10:59:00Z', '2026-11-22T12:00:00Z']);
    let id = 1;
    for (const [kind, state, at, shownAt] of rows) {
      await engine.executeRaw(`INSERT INTO learning_items (run_id, source_id, kind, target_table, target_id, state, created_at, shown_at)
        VALUES ('00000000-0000-4000-8000-000000000000', 'default', $1, CASE WHEN $1 = 'page_filled' THEN 'page_versions' WHEN $1 = 'conflict_found' THEN 'decide_proposals' ELSE 'facts' END, $2, $3, $4::timestamptz, $5::timestamptz)`,
        [kind, id++, state, at, shownAt]);
    }
    const stats = await learnedStats(engine, { engine, remote: false } as never, { sourceIds: null, since: new Date('2026-11-01T00:00:00Z') });
    expect(stats.timezone).toBe('America/New_York');
    expect(stats.nights).toEqual([
      { night: '2026-11-20', change_items: 6, shown: 6, kept: 0, undone: 0, expired: 1, counted: 5, questions: 0, answered: 0, you_wrote: 1 },
      { night: '2026-11-21', change_items: 2, shown: 1, kept: 1, undone: 0, expired: 0, counted: 2, questions: 1, answered: 1, you_wrote: 0 },
    ]);
    expect(stats).toMatchObject({ nights_total: 2, nights_with_bar: 1, share_with_bar: 0.5, scope: 'ledger' });
  });
});
