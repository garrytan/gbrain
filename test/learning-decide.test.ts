/**
 * Nightly learning PR 2: keep and undo on the learned note, expiry, and the session-start count line.
 *
 * 1. Protects: keep marks a change item kept and writes nothing else (no page, version or fact changes) and the stats
 *    count it; questions and the owner's own fence rows are refused by keep; undo reverses each change through the op
 *    that owns it and a re-read proves it (a fact is withdrawn, a promise's loop is dropped, a filled-in page is back to
 *    the version before enrich wrote it); undo refuses to overwrite an edit made after the enrich write; a local undo of
 *    a claim conflict rejects the newer fact while a remote caller gets the owner's command; a caller decides only what
 *    it can read, and a read-only token decides nothing; unseen items expire after seven days while shown ones stay;
 *    a conflict answered through gbrain decide is marked answered; a revert to an enriched version records no new
 *    filled-in page; the session-start pack carries one count line and no item text, not on a compaction and not when
 *    turned off; OpenClaw's lane adds the line once per run per session; a restricted caller's stats never say the
 *    ledger it cannot read is truncated; a group holding two pages of one source offers no confirm.
 * 2. Fails when: keep writes content, undo skips the owning op's checks or overwrites an edit, a caller decides an
 *    item it cannot read, the push line leaks item text, or expiry hides shown items.
 * 3. Real seams: PGLite (and Postgres when DATABASE_URL is set) with no git repository, runCycle, the serve's context
 *    pack handler, tokens minted by the token service and verified as serve --http does, dispatched through MCP dispatch.
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
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { LEARNING_WATERMARK_KEY } from '../src/core/learning/derive.ts';
import { learnedStats } from '../src/core/learning/stats.ts';
import { formatDecisions, parseItemIds, type Decision } from '../src/core/learning/decide.ts';
import { LEARNING_PUSH_KEY } from '../src/core/learning/push.ts';
import type { LearnedView } from '../src/core/learning/read.ts';
import { makeContextPackIpcHandler } from '../src/mcp/context-pack-handler.ts';
import { createOpenClawCoreLane } from '../src/core/context/openclaw-core.ts';
import { confirmable } from '../src/commands/dedupe.ts';
import type { DuplicateGroup } from '../src/core/entities/duplicates.ts';
import { operationsByName } from '../src/core/operations.ts';
import { operationScopesAllowed } from '../src/core/scope.ts';
import { ALL_SOURCES } from '../src/core/source-id.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

const SRC = 'source-a';
const OWNER = 'alice-example';
const ENTITY = 'people/bob-example';

const fence = (rows: string[]) => ['## Facts', '', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|', ...rows, '<!--- gbrain:facts:end -->', ''].join('\n');
const page = (type: string, title: string, body: string, fm: string[] = []) => ['---', `type: ${type}`, `title: ${title}`, ...fm, '---', `# ${title}`, '', body].join('\n');

describe('learned keep/undo units', () => {
  test('item ids parse from lists and all; anything else is refused', () => {
    expect(parseItemIds('12, 15 12')).toEqual([12, 15]);
    expect(parseItemIds([3, '4'])).toEqual([3, 4]);
    expect(parseItemIds(7)).toEqual([7]);
    expect(parseItemIds(' ALL ')).toBe('all');
    for (const bad of ['', '0', '-1', '1.5', 'abc', '12,x', null, undefined, {}]) expect(parseItemIds(bad)).toBeNull();
  });

  test('a cross-source group holding two pages of one source offers no confirm', () => {
    const member = (source_id: string, slug: string) => ({ source_id, slug }) as DuplicateGroup['members'][number];
    const group = (members: DuplicateGroup['members']): DuplicateGroup => ({ id: 'g', kind: 'cross_source', class: 'clean', members, evidence: [] });
    expect(confirmable(group([member('a', 'people/x'), member('b', 'people/x')]))).toBe(true);
    expect(confirmable(group([member('a', 'people/x'), member('a', 'people/x-2'), member('b', 'people/x')]))).toBe(false);
  });

  test("OpenClaw's lane adds the learned line once per run per session, compactions included", async () => {
    let run = 'run-1';
    const lane = createOpenClawCoreLane({ timeoutMs: 1000, later: () => {},
      fetcher: async () => ({ kind: 'fresh', identity: null, value: { text: '', pressure: null, learned: { text: 'LEARNED-LINE', run_id: run } } }) });
    const add = () => lane.additions({ sessionId: 's1', messages: [] });
    expect(await add()).toEqual(['LEARNED-LINE']);
    expect(await add()).toEqual([]);
    lane.compacted('s1');
    expect(await add()).toEqual([]);
    expect(await lane.additions({ sessionId: 's2', messages: [] })).toEqual(['LEARNED-LINE']);
    run = 'run-2';
    expect(await add()).toEqual(['LEARNED-LINE']);
  });

  test('the text form lists each item with its outcome and any command to run', () => {
    const text = formatDecisions({ action: 'undo', results: [
      { id: '4', kind: 'fact_added', status: 'undone' },
      { id: '5', kind: 'duplicate_to_confirm', status: 'owner_command', reason: 'dedupe answers run on the brain host', command: ['gbrain', 'dedupe', 'reject', 'g1'] },
    ] });
    expect(text).toBe('item 4 (fact_added): undone\nitem 5 (duplicate_to_confirm): run on the brain host - dedupe answers run on the brain host\n  gbrain dedupe reject g1\n');
    expect(formatDecisions({ action: 'undo', results: [{ id: '6', kind: 'fact_added', status: 'pending', reason: 'accepted', command: ['gbrain', 'write-request', 'r1'] }] }))
      .toBe('item 6 (fact_added): accepted, still being written - accepted\n  gbrain write-request r1\n');
  });
});

for (const backend of testBackends()) {
  describe(`learned keep and undo (${backend}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const text = (out: { content: Array<{ text: string }> }) => out.content.map(c => c.text).join('\n');
    const parse = (out: { isError?: boolean; content: Array<{ text: string }> }) => {
      if (out.isError) throw Object.assign(new Error(text(out)), { body: text(out) });
      return JSON.parse(out.content[0]!.text);
    };
    const local = async (op: string, params: Record<string, unknown> = {}) => parse(await dispatchToolCall(engine, op, params, { remote: false, sourceId: SRC }));
    const remoteRaw = async (who: string, op: string, params: Record<string, unknown>) => {
      __resetPrivateVisibilityCacheForTests();
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      return dispatchToolCall(engine, op, params, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}),
      });
    };
    const keep = async (ids: unknown): Promise<Decision[]> => (await local('learned_keep', { ids })).results;
    const undo = async (ids: unknown, reason?: string): Promise<Decision[]> => (await local('learned_undo', { ids, ...(reason ? { reason } : {}) })).results;
    const derive = async () => (await runCycle(engine, { brainDir: null, phases: ['learning_derive'] })).phases.find(p => p.phase === 'learning_derive')!;
    const items = async () => (await local('learned', { since: '2000-01-01', limit: 100 }) as LearnedView).items;
    const itemOf = async (kind: string) => (await items()).find(i => i.kind === kind)!;
    const state = async (id: string) => (await engine.executeRaw<{ state: string }>('SELECT state FROM learning_items WHERE id = $1', [id]))[0]?.state;
    const insertFact = async (fact: string, opts: { visibility?: 'private' | 'world'; claim?: [string, number]; entity?: string; ageDays?: number; source?: string } = {}) => {
      const [row] = await engine.executeRaw<{ id: number | string }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, created_at, valid_from, claim_metric, claim_value, claim_unit, claim_period)
        VALUES ($1, $2, $3, 'fact', $4, $5, now() - make_interval(days => $6), now() - make_interval(days => $6), $7, $8, CASE WHEN $7::text IS NULL THEN NULL ELSE 'USD' END, CASE WHEN $7::text IS NULL THEN NULL ELSE 'monthly' END) RETURNING id`,
        [SRC, opts.entity ?? ENTITY, fact, opts.visibility ?? 'private', opts.source ?? 'mcp:extract_facts', opts.ageDays ?? 0, opts.claim?.[0] ?? null, opts.claim?.[1] ?? null]);
      return Number(row!.id);
    };
    const enrich = async (slug: string, title: string, body: string) => {
      const before = await engine.readPageSnapshot(slug, { sourceId: SRC });
      const at = new Date().toISOString();
      await local('put_page', { slug, expected_revision: before!.revision, content: page('person', title, body, [`enriched_at: ${at}`, 'enriched_by: cli:enrich']) });
      return at;
    };
    const body = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: SRC }))!.page.compiled_truth;
    const counts = async () => (await engine.executeRaw<{ pages: number; versions: number; facts: string }>(`SELECT (SELECT count(*)::int FROM pages) AS pages,
      (SELECT count(*)::int FROM page_versions) AS versions, (SELECT string_agg(id || ':' || COALESCE(expired_at::text, '-'), ',' ORDER BY id) FROM facts) AS facts`))[0];

    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await importFromContent(engine, ENTITY, page('person', 'Bob Example', 'Bob is a founder.'), { sourceId: SRC });
      await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [OWNER]);
      const mint = async (name: string, scopes: string[], member?: string) => {
        const minted = await mintLegacyToken(engine, { name, scopes, takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
        else await readsUnscopedOnPurpose(engine, minted.id);
      };
      await mint('owner-writer', ['read', 'write'], OWNER);
      await mint('world-writer', ['read', 'write']);
      await setOwner(engine, OWNER);
    }, 240_000);

    afterAll(async () => { await close?.(); }, 60_000);

    beforeEach(async () => {
      await engine.executeRaw('DELETE FROM learning_items');
      await engine.executeRaw('DELETE FROM facts WHERE source_id = $1', [SRC]);
      await engine.executeRaw('DELETE FROM open_loops WHERE source_id = $1', [SRC]);
      await engine.executeRaw("DELETE FROM decide_proposals WHERE sweep_id LIKE 'claim_conflicts:%'");
      await engine.executeRaw('DELETE FROM config WHERE key = ANY($1::text[])', [[LEARNING_WATERMARK_KEY, LEARNING_PUSH_KEY]]);
      await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE source_id = $1 AND frontmatter->>'enriched_by' IS NOT NULL AND deleted_at IS NULL", [SRC]);
    });

    test('keep marks a change item kept and writes nothing else; questions and fence rows are refused', async () => {
      await importFromContent(engine, 'people/dana-example', page('person', 'Dana Example', `Dana runs a bakery.\n\n${fence(['| 1 | Dana bakes on Fridays | fact | 1.0 | private | medium | 2026-01-01 |  |  |  |'])}`), { sourceId: SRC });
      await insertFact('Bob moved to Lisbon');
      await insertFact('Bob plays chess');
      await runCycle(engine, { brainDir: null, sourceId: SRC, phases: ['extract_facts'] });
      await derive();
      const all = await items();
      const [lisbon, chess] = ['Bob moved to Lisbon', 'Bob plays chess'].map(t => all.find(i => i.text === t)!);
      const wrote = all.find(i => i.kind === 'you_wrote')!;
      const before = await counts();
      expect(await keep(`${lisbon.id},${wrote.id}`)).toEqual([
        { id: lisbon.id, kind: 'fact_added', status: 'kept' },
        { id: wrote.id, kind: 'you_wrote', status: 'refused', reason: 'your own Facts fence row: edit it on the page' },
      ]);
      expect(await counts()).toEqual(before);
      expect(await state(lisbon.id)).toBe('kept');
      expect(await keep(lisbon.id)).toEqual([{ id: lisbon.id, kind: 'fact_added', status: 'already', reason: 'kept' }]);
      expect((await keep('all')).map(d => [d.id, d.status])).toEqual([[chess.id, 'kept']]);
      expect(await keep('999999')).toEqual([{ id: '999999', status: 'not_found' }]);
      const stats = (await local('learned', { stats: true })).stats;
      expect(stats.nights[0]).toMatchObject({ kept: 2, counted: 2 });
    });

    test('keep on a promise and a filled-in page marks them kept and changes neither', async () => {
      await engine.executeRaw(`INSERT INTO open_loops (source_id, dedup_key, loop_type, counterparty_slug, summary, detector)
        VALUES ($1, 'promise-keep', 'commitment_owed_to_me', $2, 'Bob will call back', 'llm_extract')`, [SRC, ENTITY]);
      await importFromContent(engine, 'people/hal-example', page('person', 'Hal Example', 'Hal is a stub.'), { sourceId: SRC });
      await enrich('people/hal-example', 'Hal Example', 'Hal repairs bicycles.');
      await derive();
      const [promise, filled] = [await itemOf('promise_found'), await itemOf('page_filled')];
      const before = await counts();
      const loops = async () => engine.executeRaw<{ status: string }>("SELECT status FROM open_loops WHERE dedup_key = 'promise-keep'");
      expect(await keep(`${promise.id} ${filled.id}`)).toEqual([
        { id: promise.id, kind: 'promise_found', status: 'kept' },
        { id: filled.id, kind: 'page_filled', status: 'kept' },
      ]);
      expect(await counts()).toEqual(before);
      expect(await loops()).toEqual([{ status: 'open' }]);
      expect(await body('people/hal-example')).toContain('Hal repairs bicycles.');
    });

    test('a local caller reading every source undoes a fact in the source it was learned in', async () => {
      const id = await insertFact('Bob keeps bees');
      await derive();
      const item = await itemOf('fact_added');
      const out = parse(await dispatchToolCall(engine, 'learned_undo', { ids: item.id }, { remote: false, sourceId: ALL_SOURCES }));
      expect(out.results[0]).toMatchObject({ id: item.id, status: 'undone' });
      const [fact] = await engine.executeRaw<{ expired_at: string | null }>('SELECT expired_at FROM facts WHERE id = $1', [id]);
      expect(fact!.expired_at).not.toBeNull();
    });

    test('undo forgets a new fact: the fact is withdrawn, the item is undone, and it leaves the note', async () => {
      const id = await insertFact('Bob owns a red canoe');
      await derive();
      const item = await itemOf('fact_added');
      const [decision] = await undo(item.id, 'not his canoe');
      expect(decision).toMatchObject({ id: item.id, kind: 'fact_added', status: 'undone' });
      const [fact] = await engine.executeRaw<{ expired_at: string | null }>('SELECT expired_at FROM facts WHERE id = $1', [id]);
      expect(fact!.expired_at).not.toBeNull();
      expect(await state(item.id)).toBe('undone');
      expect((await items()).some(i => i.id === item.id)).toBe(false);
      expect(await undo(item.id)).toEqual([{ id: item.id, kind: 'fact_added', status: 'already', reason: 'undone' }]);
    });

    test('undo drops a promise: its open loop is closed as dropped', async () => {
      const [loop] = await engine.executeRaw<{ id: number | string }>(`INSERT INTO open_loops (source_id, dedup_key, loop_type, counterparty_slug, summary, detector)
        VALUES ($1, 'promise-undo', 'commitment_owed_to_me', $2, 'Bob will send the deck', 'llm_extract') RETURNING id`, [SRC, ENTITY]);
      await derive();
      const item = await itemOf('promise_found');
      expect((await undo(item.id))[0]).toMatchObject({ status: 'undone' });
      const [row] = await engine.executeRaw<{ status: string }>('SELECT status FROM open_loops WHERE id = $1', [loop!.id]);
      expect(row!.status).toBe('dropped');
      expect(await state(item.id)).toBe('undone');
    });

    test('undo puts a filled-in page back, and refuses once the page was edited after the enrich write', async () => {
      await importFromContent(engine, 'people/erin-example', page('person', 'Erin Example', 'Erin is a stub.'), { sourceId: SRC });
      await enrich('people/erin-example', 'Erin Example', 'Erin founded a lighthouse museum.');
      await importFromContent(engine, 'people/fay-example', page('person', 'Fay Example', 'Fay is a stub.'), { sourceId: SRC });
      await enrich('people/fay-example', 'Fay Example', 'Fay sails.');
      expect((await derive()).details.recorded).toMatchObject({ page_filled: 2 });
      const filled = (await items()).filter(i => i.kind === 'page_filled');
      const erin = filled.find(i => i.subject === 'people/erin-example')!;
      const fay = filled.find(i => i.subject === 'people/fay-example')!;

      expect((await undo(erin.id))[0]).toMatchObject({ status: 'undone' });
      expect(await body('people/erin-example')).toContain('Erin is a stub.');
      expect(await body('people/erin-example')).not.toContain('lighthouse');
      expect(await state(erin.id)).toBe('undone');

      const snap = await engine.readPageSnapshot('people/fay-example', { sourceId: SRC });
      await local('put_page', { slug: 'people/fay-example', expected_revision: snap!.revision, content: page('person', 'Fay Example', 'Fay sails. The owner added this line.') });
      const [refused] = await undo(fay.id);
      expect(refused).toMatchObject({ id: fay.id, status: 'refused' });
      expect(refused!.reason).toContain('the page changed after it was filled in');
      expect(refused!.commands).toEqual([['gbrain', 'history', 'people/fay-example'], ['gbrain', 'revert', 'people/fay-example', fay.evidence[0]!.version_id!]]);
      expect(await body('people/fay-example')).toContain('The owner added this line.');
      expect(await state(fay.id)).toBe('pending');
    });

    test('a revert to an enriched version records no new filled-in page', async () => {
      await importFromContent(engine, 'people/gus-example', page('person', 'Gus Example', 'Gus is a stub.'), { sourceId: SRC });
      await enrich('people/gus-example', 'Gus Example', 'Gus restores clocks.');
      const pageId = (await engine.readPageSnapshot('people/gus-example', { sourceId: SRC }))!.page.id;
      expect((await derive()).details.recorded).toMatchObject({ page_filled: 1 });
      const snap = await engine.readPageSnapshot('people/gus-example', { sourceId: SRC });
      await local('put_page', { slug: 'people/gus-example', expected_revision: snap!.revision, content: page('person', 'Gus Example', 'Gus restores clocks and watches.') });
      const [enrichedVersion] = await engine.executeRaw<{ id: number | string }>(`SELECT id FROM page_versions WHERE page_id = $1 AND frontmatter->>'enriched_by' = 'cli:enrich' ORDER BY id DESC LIMIT 1`, [pageId]);
      const edited = await engine.readPageSnapshot('people/gus-example', { sourceId: SRC });
      await local('revert_version', { slug: 'people/gus-example', version_id: Number(enrichedVersion!.id), expected_revision: edited!.revision });
      expect(await body('people/gus-example')).toContain('Gus restores clocks.');
      expect((await derive()).details.recorded).toMatchObject({ page_filled: 0 });
      expect(await engine.executeRaw("SELECT count(*)::int AS n FROM learning_items WHERE kind = 'page_filled'")).toEqual([{ n: 1 }]);
    });

    test('a fill edited before the nightly run, frontmatter kept, is still recorded', async () => {
      await importFromContent(engine, 'people/ivy-example', page('person', 'Ivy Example', 'Ivy is a stub.'), { sourceId: SRC });
      const at = await enrich('people/ivy-example', 'Ivy Example', 'Ivy builds kites.');
      const snap = await engine.readPageSnapshot('people/ivy-example', { sourceId: SRC });
      await local('put_page', { slug: 'people/ivy-example', expected_revision: snap!.revision,
        content: page('person', 'Ivy Example', 'Ivy builds kites and flies them.', [`enriched_at: ${at}`, 'enriched_by: cli:enrich']) });
      expect((await derive()).details.recorded).toMatchObject({ page_filled: 1 });
    });

    test('a claim conflict: a remote caller gets the owner command, a local undo rejects the newer fact, and an answer through decide marks it answered', async () => {
      const conflict = async (metric: string) => {
        await insertFact(`Acme ${metric} is 40000`, { entity: 'companies/acme-example', visibility: 'world', source: 'fixture', ageDays: 1, claim: [metric, 40000] });
        await insertFact(`Acme ${metric} is 45000`, { entity: 'companies/acme-example', visibility: 'world', source: 'fixture', claim: [metric, 45000] });
      };
      await conflict('mrr');
      await conflict('arr');
      await engine.setConfig('dream.claim_conflicts.mode', 'propose');
      try {
        await runCycle(engine, { brainDir: null, phases: ['claim_conflicts', 'learning_derive'] });
      } finally {
        await engine.executeRaw("DELETE FROM config WHERE key = 'dream.claim_conflicts.mode'");
      }
      const conflicts = (await items()).filter(i => i.kind === 'conflict_found');
      expect(conflicts).toHaveLength(2);
      const [first, second] = conflicts;
      const proposalOf = (i: typeof first) => i!.evidence[0]!.proposal_id!;

      const remote = parse(await remoteRaw('owner-writer', 'learned_undo', { ids: first!.id }));
      expect(remote.results).toEqual([{ id: first!.id, kind: 'conflict_found', status: 'owner_command', reason: 'proposal review runs on the brain host',
        command: ['gbrain', 'decide', 'proposals', 'reject', proposalOf(first)] }]);
      expect(await state(first!.id)).toBe('pending');
      expect(await keep(first!.id)).toEqual([{ id: first!.id, kind: 'conflict_found', status: 'refused', reason: 'a question: answer it (learned-undo, or the commands the note shows)' }]);
      expect(await state(first!.id)).toBe('pending');

      expect((await undo(first!.id))[0]).toMatchObject({ status: 'answered' });
      const status = async (id: string) => (await engine.executeRaw<{ status: string }>('SELECT status FROM decide_proposals WHERE id = $1', [id]))[0]!.status;
      expect(await status(proposalOf(first))).toBe('rejected');
      expect(await state(first!.id)).toBe('answered');

      await engine.executeRaw("UPDATE decide_proposals SET status = 'rejected' WHERE id = $1", [proposalOf(second)]);
      expect((await derive()).details).toMatchObject({ answered: 1 });
      expect(await state(second!.id)).toBe('answered');
    });

    test('undo refuses a Facts fence row and leaves it pending', async () => {
      await importFromContent(engine, 'people/jo-example', page('person', 'Jo Example', `Jo paints.\n\n${fence(['| 1 | Jo paints murals | fact | 1.0 | private | medium | 2026-01-01 |  |  |  |'])}`), { sourceId: SRC });
      await runCycle(engine, { brainDir: null, sourceId: SRC, phases: ['extract_facts'] });
      await derive();
      const wrote = await itemOf('you_wrote');
      const before = await counts();
      expect(await undo(wrote.id)).toEqual([{ id: wrote.id, kind: 'you_wrote', status: 'refused', reason: 'your own Facts fence row: edit it on the page' }]);
      expect(await counts()).toEqual(before);
      expect(await state(wrote.id)).toBe('pending');
    });

    test('every unseen kind expires after seven days (conflicts found by the default mode); undoing an expired conflict answers it', async () => {
      await importFromContent(engine, 'people/kim-example', page('person', 'Kim Example', `Kim sings.\n\n${fence(['| 1 | Kim sings opera | fact | 1.0 | private | medium | 2026-01-01 |  |  |  |'])}`), { sourceId: SRC });
      await runCycle(engine, { brainDir: null, sourceId: SRC, phases: ['extract_facts'] });
      await engine.executeRaw(`INSERT INTO open_loops (source_id, dedup_key, loop_type, counterparty_slug, summary, detector)
        VALUES ($1, 'promise-expire', 'commitment_owed_to_me', $2, 'Bob will share the plan', 'llm_extract')`, [SRC, ENTITY]);
      await importFromContent(engine, 'people/lee-example', page('person', 'Lee Example', 'Lee is a stub.'), { sourceId: SRC });
      await enrich('people/lee-example', 'Lee Example', 'Lee builds boats.');
      await insertFact('Acme churn is 4', { entity: 'companies/acme-example', visibility: 'world', source: 'fixture', ageDays: 1, claim: ['churn', 4] });
      await insertFact('Acme churn is 6', { entity: 'companies/acme-example', visibility: 'world', source: 'fixture', claim: ['churn', 6] });
      expect(await engine.getConfig('dream.claim_conflicts.mode')).toBeNull();
      await runCycle(engine, { brainDir: null, phases: ['claim_conflicts', 'learning_derive'] });
      const kinds = ['you_wrote', 'promise_found', 'page_filled', 'conflict_found'];
      const rows = await engine.executeRaw<{ id: number | string; kind: string }>('SELECT id, kind FROM learning_items WHERE shown_at IS NULL');
      const byKind = Object.fromEntries(rows.map(r => [r.kind, String(r.id)]));
      expect(Object.keys(byKind).sort()).toEqual([...kinds].sort());
      await engine.executeRaw("UPDATE learning_items SET created_at = now() - interval '8 days'");
      await derive();
      for (const k of kinds) expect([k, await state(byKind[k])]).toEqual([k, 'expired']);
      expect((await undo(byKind.conflict_found))[0]).toMatchObject({ kind: 'conflict_found', status: 'answered' });
      expect(await state(byKind.conflict_found)).toBe('answered');
    });

    test('a caller decides only items it can read, and both verbs need write scope', async () => {
      await insertFact('Bob has a private diagnosis', { visibility: 'private' });
      await insertFact('Bob speaks at the conference', { visibility: 'world' });
      await derive();
      const all = await items();
      const secret = all.find(i => i.text.includes('diagnosis'))!;
      const open = all.find(i => i.text.includes('conference'))!;

      for (const name of ['learned_keep', 'learned_undo']) {
        expect(operationScopesAllowed(['read'], operationsByName[name]!)).toBe(false);
        expect(operationScopesAllowed(['read', 'write'], operationsByName[name]!)).toBe(true);
      }

      const world = parse(await remoteRaw('world-writer', 'learned_keep', { ids: `${secret.id},${open.id}` }));
      expect(world.results).toEqual([{ id: secret.id, status: 'not_found' }, { id: open.id, kind: 'fact_added', status: 'kept' }]);
      expect(await state(secret.id)).toBe('pending');
      const owner = parse(await remoteRaw('owner-writer', 'learned_keep', { ids: secret.id }));
      expect(owner.results).toEqual([{ id: secret.id, kind: 'fact_added', status: 'kept' }]);
    });

    test('unseen items expire after seven days; a shown one stays pending and still counts', async () => {
      await insertFact('Bob likes tea');
      await insertFact('Bob likes coffee');
      await derive();
      const idOf = async (fact: string) => String((await engine.executeRaw<{ id: number | string }>(
        "SELECT li.id FROM learning_items li JOIN facts f ON f.id = li.target_id WHERE li.target_table = 'facts' AND f.fact = $1", [fact]))[0]!.id);
      const teaItem = { id: await idOf('Bob likes tea') };
      const coffeeItem = { id: await idOf('Bob likes coffee') };
      await engine.executeRaw('UPDATE learning_items SET shown_at = now() WHERE id = $1', [teaItem.id]);
      await engine.executeRaw("UPDATE learning_items SET created_at = now() - interval '8 days'");
      expect((await derive()).details).toMatchObject({ expired: 1 });
      expect(await state(teaItem.id)).toBe('pending');
      expect(await state(coffeeItem.id)).toBe('expired');
      expect((await derive()).details).toMatchObject({ expired: 0 });
    });

    test('session start carries one count line and no item text; not on a compaction, not once shown, not when turned off', async () => {
      await insertFact('Bob collects canarypushtext stamps');
      await insertFact('Bob runs marathons');
      await derive();
      const handler = makeContextPackIpcHandler(engine, SRC);
      const pack = async (trigger: string) => (await handler({ trigger, sessionId: `session-${trigger}` } as never))!.text;
      const line = '[gbrain] Nightly learning: the brain has 2 things to show the user. Say "I learned 2 things last night; want them?" and, if they say yes, call the learned tool.';
      const start = await pack('session-start:startup');
      expect(start.startsWith(line)).toBe(true);
      expect(start).not.toContain('canarypushtext');
      expect(await pack('session-start:compact')).not.toContain('Nightly learning');
      expect(await pack('user-prompt')).not.toContain('Nightly learning');
      await engine.setConfig(LEARNING_PUSH_KEY, 'false');
      expect(await pack('session-start:resume')).not.toContain('Nightly learning');
      await engine.executeRaw('DELETE FROM config WHERE key = $1', [LEARNING_PUSH_KEY]);
      await local('learned', {});
      expect(await pack('session-start:clear')).not.toContain('Nightly learning');
    });

    test("a restricted caller's stats never report the ledger it cannot read as truncated", async () => {
      await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from)
        SELECT $1, $2, 'private fact ' || g, 'fact', 'private', 'mcp:extract_facts', now() FROM generate_series(1, 4) g`, [SRC, ENTITY]);
      await insertFact('Bob is on the board', { visibility: 'world' });
      await derive();
      __resetPrivateVisibilityCacheForTests();
      const auth = await provider().verifyAccessToken(tokens['world-writer']!) as unknown as AuthInfo;
      const ctx = { engine, remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'], config: {} } as never;
      const restricted = await learnedStats(engine, ctx, { sourceIds: [SRC], rowCap: 2 });
      expect(restricted).toMatchObject({ scope: 'readable', truncated: false });
      expect(restricted.nights[0]).toMatchObject({ change_items: 1 });
      const full = await learnedStats(engine, { engine, remote: false, sourceId: SRC, config: {} } as never, { sourceIds: [SRC], rowCap: 2 });
      expect(full).toMatchObject({ scope: 'ledger', truncated: true });
    });
  });
}
