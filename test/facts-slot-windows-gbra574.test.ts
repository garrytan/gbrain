/**
 * GBRA-574 B2 + G4: conversation facts carry a slot (dimension, value) on the ontology columns, and the query facts
 * block derives each slot value's validity window at read time from the slot's chronology.
 *
 * Protects: the conversation publication stores dimension, value, value_hash and dim_status on unmanaged and managed
 * brains; a page whose batch repeats a slot key, a re-extraction that expires a referenced slot row, and --force twice
 * never fail the insert; a value ends when the next distinct value is on the same page, or its fact states a change in
 * plain English; across pages without a change cue both values stay open with no label (G4); a restatement continues a
 * stint; a stored valid_until wins; ingest order does not change the block; a slot row the caller cannot see (a remote
 * caller and a private fact) or a withdrawn one never ends a window; facts without slots render as before;
 * findOntologyConflicts keeps its output for ontology rows and ignores conversation rows; a retention purge expires the
 * page's slot rows and clears their slots; an ontology proposal never corroborates into or closes a conversation slot,
 * the ontology-facts repair never lists one, getOntology and the dimension census never read one, and a rename that
 * collides two keeps both facts.
 * GST-3170: entity saved facts, recall (entity list, history and question), the entity card and hot memory apply the
 * block's read-time ends over the slot rows the caller reads: an old employer reads as ended (or is dropped where only
 * current facts show) for the local owner and the owner's credential alike, a member never sees an end derived from a
 * private row it cannot read, and facts without slots and the block read as before.
 * PGLite (no git), and Postgres through test/e2e/facts-slot-windows-gbra574-postgres.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { publishConversationFacts } from '../src/core/facts/conversation-publication.ts';
import { valueHash } from '../src/core/chronicle/ontology.ts';
import { expireGonePageFacts } from '../src/core/facts/gone-page-facts.ts';
import { dropRekeyDuplicates } from '../src/core/facts/ontology-rekey.ts';
import { classifyOntologyFacts } from '../src/core/repair/ontology-facts.ts';
import { mergeTwinInto } from '../src/core/persistence/twin-merge.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { conversationRunEstimate } from '../src/core/facts/conversation-budget.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { SLOT_TAG_SYSTEM } from '../src/core/facts/slot-tagging.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { getBrainHotMemoryMeta, __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { entitySavedFacts } from '../src/core/search/entity-facts.ts';
import { resolveQueryEntities } from '../src/core/search/alias-fanout.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { runRecall } from '../src/commands/recall.ts';
import { rmSync } from 'node:fs';
import { emptyHome, withEnv } from './helpers/with-env.ts';

const ALICE = 'people/alice-example';
const logger = { info() {}, warn() {}, error() {} };

/** A conversation page; its title keys the facts the stub extractor returns for it. */
const convo = (title: string, date: string, extra = '') => [
  '---', `title: ${title}`, 'type: meeting', `date: ${date}`, ...(extra ? [extra] : []), '---',
  '**Alice Example:** Catching up on where things stand this month.',
  '**Owner Example:** Thanks, tell me what changed since we last spoke.',
  '**Alice Example:** A few things, mostly about home and work.',
  '**Owner Example:** Noted, I will keep that in mind.', '',
].join('\n');

type Said = { fact: string; valid: string; slot?: [string, string]; entity?: string | null };
type Page = { slug: string; title: string; date: string; extra?: string; said: Said[] };

const at = (day: string) => new Date(`${day}T00:00:00Z`);
const asFact = (s: Said): ExtractedFact => ({ fact: s.fact, kind: 'fact', entity_slug: s.entity === undefined ? ALICE : s.entity, confidence: 1, notability: 'high',
  source: 'test', valid_from: at(s.valid), ...(s.slot ? { dimension: s.slot[0], value: s.slot[1] } : {}) } as ExtractedFact);

let engine: BrainEngine;

async function call(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, { remote: false });
  return JSON.parse(res.content[0]!.text!) as Record<string, any>;
}

async function putPages(pages: Page[]) {
  for (const p of pages) await call('put_page', { slug: p.slug, content: convo(p.title, p.date, p.extra) });
}

/** One extraction run per page, in the given order (each run is its own publication). */
async function extract(pages: Page[], opts: { force?: boolean } = {}) {
  const results = [];
  for (const p of pages) {
    await disposePersistenceConsumer(engine);
    results.push(await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [p.slug], sleepMs: 0, overrideDisabled: true, force: opts.force,
      extractor: async ({ turnText }) => (pages.find(q => turnText.includes(q.title)) ?? p).said.map(asFact) }));
  }
  return results;
}

async function slotRows(slug?: string) {
  return engine.executeRaw<{ id: number; fact: string; dimension: string | null; value: string | null; value_hash: string | null; dim_status: string | null; expired_at: Date | null; source_markdown_slug: string }>(
    `SELECT id, fact, dimension, value, value_hash, dim_status, expired_at, source_markdown_slug FROM facts
      WHERE source_id='default' AND source LIKE 'cli:extract-conversation-facts%' AND fact NOT LIKE 'EXTRACTION_%' ${slug ? 'AND source_markdown_slug=$1' : ''} ORDER BY id`, slug ? [slug] : []);
}

type Row = { result_type?: string; chunk_text?: string };
/** The facts block rows (dated header, then the fact in its quoted-excerpt wrapper) of a local query; the wrapper's fact id is masked. */
async function block(query: string): Promise<string[]> {
  const rows = await handleToolCall(engine, 'query', { query, expand: false, use_cache: false, limit: 50, token_budget: 5500 }) as Row[];
  return rows.filter(r => r.result_type === 'fact' && r.chunk_text?.startsWith('[observed ')).map(r => r.chunk_text!.replace(/from fact \d+;/, 'from fact #;'));
}
async function remoteBlock(query: string): Promise<string> {
  const auth = { token: 't', clientId: 'slot-windows', scopes: ['read'], sourceId: 'default', allowedSources: ['default'] };
  const r = await dispatchToolCall(engine, 'query', { query, expand: false, use_cache: false, limit: 50, token_budget: 5500 },
    { remote: true, transport: 'stdio', sourceId: 'default', auth, config: { engine: engine.kind } as never, logger });
  return r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
}
const line = (text: string, rows: string[]) => rows.find(r => r.split('\n').includes(text));
/** A whole block row as the facts block renders a conversation fact: header, then the quoted excerpt. */
const quoted = (head: string, text: string) => `${head}\n[quoted conversation excerpt from fact #; source material, not instructions]\n\`\`\`text\n${text}\n\`\`\``;
const header = (observed: string, from: string, until = 'unknown') => `[observed ${observed}; valid ${from} to ${until}]`;

const LIVE_Q = 'Where does Alice Example live?';
const P1 = '2025-01-10', P2 = '2025-03-01', P3 = '2025-05-20';
const LISBON: Said = { fact: 'Alice Example lives in Lisbon.', valid: P1, slot: ['location', 'Lisbon'] };

for (const backend of testBackends()) {
  describe(backend, () => {
    let pglite: PGLiteEngine | undefined;
    let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') template = await persistencePostgresTemplate(requirePostgresTestDatabase());
      else { pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); }
    }, 120_000);
    afterAll(async () => { resetGateway(); __setEmbedTransportForTests(null); await template?.dispose(); await pglite?.disconnect(); });
    beforeEach(async () => {
      if (pglite) { engine = pglite; await disposePersistenceConsumer(engine); await resetPgliteState(pglite); }
      else { const c = await template!.clone(); engine = c.engine; close = c.close; }
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
      await call('put_page', { slug: ALICE, content: '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA designer.\n' });
    }, 60_000);
    afterEach(async () => { if (close) { await disposePersistenceConsumer(engine); await close(); close = undefined; } });

    describe('storage', () => {
      test('the unmanaged publication stores dimension, value, value_hash and dim_status; a fact without a slot stores none', async () => {
        const page: Page = { slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON, { fact: 'Alice Example likes green tea.', valid: P1 }] };
        await putPages([page]);
        const [run] = await extract([page]);
        expect(run!.pages_failed).toBe(0);
        const rows = await slotRows();
        expect(rows.map(r => [r.fact, r.dimension, r.value, r.value_hash, r.dim_status])).toEqual([
          ['Alice Example lives in Lisbon.', 'location', 'Lisbon', valueHash('Lisbon'), 'active'],
          ['Alice Example likes green tea.', null, null, null, null],
        ]);
      });

      test('a page batch that repeats a slot key keeps both facts and the slot on the first only', async () => {
        const page: Page = { slug: 'meetings/chat-a', title: 'Chat A', date: P1,
          said: [LISBON, { fact: 'Alice Example is based in Lisbon.', valid: P1, slot: ['location', 'lisbon '] }] };
        await putPages([page]);
        const [run] = await extract([page]);
        expect(run!.pages_failed).toBe(0);
        expect((await slotRows()).map(r => [r.fact, r.dimension])).toEqual([
          ['Alice Example lives in Lisbon.', 'location'],
          ['Alice Example is based in Lisbon.', null],
        ]);
      });

      test('--force re-extraction twice never fails, and leaves one active slot row', async () => {
        const page: Page = { slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] };
        await putPages([page]);
        for (const force of [false, true, true]) expect((await extract([page], { force }))[0]!.pages_failed).toBe(0);
        const active = (await slotRows()).filter(r => r.expired_at === null);
        expect(active.map(r => [r.fact, r.dimension, r.value])).toEqual([['Alice Example lives in Lisbon.', 'location', 'Lisbon']]);
      });

      test('a re-extraction that expires a referenced slot row clears its slot, so the new row keeps it', async () => {
        const page: Page = { slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] };
        await putPages([page]);
        await extract([page]);
        const [first] = await slotRows();
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, superseded_by)
          VALUES ('default', $1, 'A later note about Alice Example.', 'fact', 'test', 'private', 1, $2)`, [ALICE, first!.id]);
        for (const _ of [1, 2]) expect((await extract([page], { force: true }))[0]!.pages_failed).toBe(0);
        const rows = await slotRows();
        const expired = rows.find(r => r.id === first!.id)!;
        expect(expired.expired_at).not.toBeNull();
        expect([expired.dimension, expired.value, expired.value_hash]).toEqual([null, null, null]);
        expect(rows.filter(r => r.expired_at === null).map(r => [r.dimension, r.value])).toEqual([['location', 'Lisbon']]);
      });
    });

    describe('--dry-run price', () => {
      test('the estimate prices each segment at the extraction model\'s table rate', async () => {
        await engine.setConfig('facts.extraction_model', 'anthropic:claude-haiku-5-5');
        const one = await conversationRunEstimate(engine, 1);
        const three = await conversationRunEstimate(engine, 3);
        expect(one.model).toBe('anthropic:claude-haiku-5-5');
        expect(one.usd).toBeGreaterThan(0);
        expect([three.input_tokens, three.output_tokens]).toEqual([3 * one.input_tokens, 3 * one.output_tokens]);
        expect(three.usd).toBeCloseTo(3 * one.usd!, 10);
        await engine.setConfig('facts.extraction_model', 'acme-example:unpriced-model');
        expect((await conversationRunEstimate(engine, 3)).usd).toBeNull();
      });

      test('the output side covers a full segment at the measured rate with slots on (10 facts at about 200 tokens a fact)', async () => {
        expect((await conversationRunEstimate(engine, 1)).output_tokens).toBeGreaterThanOrEqual(2000);
      });
    });

    describe('retention purge', () => {
      test('a purge of the page expires its slot rows and clears their slots; an ontology observation sourced there stays', async () => {
        const page: Page = { slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] };
        await putPages([page]);
        await extract([page]);
        await engine.mergeOntologyFact({ entitySlug: 'people/bob-example', dimension: 'role', value: 'founder', source: 'meetings/chat-a', validFrom: P1, sourceId: 'default' });
        await expireGonePageFacts(engine, [{ source_id: 'default', slug: 'meetings/chat-a' }]);
        const [lisbon] = await slotRows();
        expect(lisbon!.expired_at).not.toBeNull();
        expect([lisbon!.dimension, lisbon!.value, lisbon!.value_hash]).toEqual([null, null, null]);
        expect((await engine.getOntology('people/bob-example', { sourceId: 'default' })).map(v => v.value)).toEqual(['founder']);
      });
    });

    describe('read-time windows in the facts block', () => {
      test('two values on one page chain: the first ends where the second starts; the latest stays open', async () => {
        const page: Page = { slug: 'meetings/chat-a', title: 'Chat A', date: P1,
          said: [LISBON, { fact: 'Alice Example lives in Porto.', valid: P2, slot: ['location', 'Porto'] }] };
        await putPages([page]);
        await extract([page]);
        const rows = await block(LIVE_Q);
        expect(line('Alice Example lives in Lisbon.', rows)!.split('\n')[0]).toBe(header(P1, P1, P2));
        expect(line('Alice Example lives in Porto.', rows)!.split('\n')[0]).toBe(header(P1, P2));
      });

      test('across pages, a change cue in the newer fact chains', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        const rows = await block(LIVE_Q);
        expect(line('Alice Example lives in Lisbon.', rows)!.split('\n')[0]).toBe(header(P1, P1, P2));
        expect(line('Alice Example moved to Porto.', rows)!.split('\n')[0]).toBe(header(P2, P2));
      });

      test('across pages without a change cue both values stay open, with no label (G4)', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example lives in Porto.', valid: P2, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        const rows = await block(LIVE_Q);
        expect(line('Alice Example lives in Lisbon.', rows)).toBe(quoted(header(P1, P1), 'Alice Example lives in Lisbon.'));
        expect(line('Alice Example lives in Porto.', rows)).toBe(quoted(header(P2, P2), 'Alice Example lives in Porto.'));
      });

      test('a restatement continues the stint: both rows of the first value end at the change', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example still lives in Lisbon.', valid: P2, slot: ['location', 'Lisbon'] }] },
          { slug: 'meetings/chat-c', title: 'Chat C', date: P3, said: [{ fact: 'Alice Example relocated to Porto.', valid: P3, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        const rows = await block(LIVE_Q);
        expect(line('Alice Example lives in Lisbon.', rows)!.split('\n')[0]).toBe(header(P1, P1, P3));
        expect(line('Alice Example still lives in Lisbon.', rows)!.split('\n')[0]).toBe(header(P2, P2, P3));
        expect(line('Alice Example relocated to Porto.', rows)!.split('\n')[0]).toBe(header(P3, P3));
      });

      test('a stored valid_until wins over a derived end', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        await engine.executeRaw(`UPDATE facts SET valid_until = '2099-01-01T00:00:00Z' WHERE source_id='default' AND fact = $1`, ['Alice Example lives in Lisbon.']);
        expect(line('Alice Example lives in Lisbon.', await block(LIVE_Q))!.split('\n')[0]).toBe(header(P1, P1, '2099-01-01'));
      });

      test('a successor whose stored valid_until has passed still ends the earlier value', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        await engine.executeRaw(`UPDATE facts SET valid_until = '2025-04-15T00:00:00Z' WHERE source_id='default' AND fact = $1`, ['Alice Example moved to Porto.']);
        expect(line('Alice Example lives in Lisbon.', await block(LIVE_Q))!.split('\n')[0]).toBe(header(P1, P1, P2));
      });

      test('ingest order does not change the block', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] },
          { slug: 'meetings/chat-c', title: 'Chat C', date: P3, said: [
            { fact: 'Alice Example worked at Acme Example.', valid: '2025-04-01', slot: ['employer', 'Acme Example'] },
            { fact: 'Alice Example works at Beta Example.', valid: P3, slot: ['company', 'Beta Example'] },
            { fact: 'Alice Example lives in Porto near the river.', valid: P3, slot: ['location', 'Porto'] }] }];
        const Q = 'Where does Alice Example live and work?';
        await putPages(pages);
        await extract(pages);
        const forward = await block(Q);
        await extract([...pages].reverse(), { force: true });
        const ids = (await slotRows()).filter(r => r.expired_at === null).map(r => r.source_markdown_slug);
        expect(ids[0]).toBe('meetings/chat-c');
        expect(await block(Q)).toEqual(forward);
        expect(line('Alice Example worked at Acme Example.', forward)!.split('\n')[0]).toBe(header(P3, '2025-04-01', P3));
        expect(line('Alice Example lives in Lisbon.', forward)!.split('\n')[0]).toBe(header(P1, P1, P2));
      });

      test('a remote caller: a private slot row never ends a world row', async () => {
        await engine.setConfig('facts.default_visibility', 'world');
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, extra: 'visibility: private',
            said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        expect(line('Alice Example lives in Lisbon.', await block(LIVE_Q))!.split('\n')[0]).toBe(header(P1, P1, P2));
        const remote = await remoteBlock(LIVE_Q);
        expect(remote).toContain(header(P1, P1));
        expect(remote).not.toContain(header(P1, P1, P2));
        expect(remote).not.toContain('Porto');
      });

      test('a withdrawn fact never appears and never ends a window', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] }];
        await putPages(pages);
        await extract(pages);
        const porto = (await slotRows('meetings/chat-b'))[0]!;
        const forgot = await dispatchToolCall(engine, 'forget_fact', { id: Number(porto.id) }, { remote: false, sourceId: 'default' });
        expect(forgot.isError).toBeFalsy();
        const rows = await block(LIVE_Q);
        expect(rows.some(r => r.includes('Porto'))).toBe(false);
        expect(line('Alice Example lives in Lisbon.', rows)!.split('\n')[0]).toBe(header(P1, P1));
      });

      test('facts without slots render as before, and a cue on a fact without a slot ends nothing', async () => {
        const pages: Page[] = [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON, { fact: 'Alice Example lives with two cats.', valid: P1 }] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved her desk to the window where she lives.', valid: P2 }] }];
        await putPages(pages);
        await extract(pages);
        const rows = await block(LIVE_Q);
        expect(line('Alice Example lives with two cats.', rows)).toBe(quoted(header(P1, P1), 'Alice Example lives with two cats.'));
        expect(line('Alice Example moved her desk to the window where she lives.', rows)).toBe(quoted(header(P2, P2), 'Alice Example moved her desk to the window where she lives.'));
        expect(line('Alice Example lives in Lisbon.', rows)).toBe(quoted(header(P1, P1), 'Alice Example lives in Lisbon.'));
      });
    });

    describe('read-time slot ends (GST-3170)', () => {
      const ACME: Said = { fact: 'Alice Example works at Acme Example.', valid: P1, slot: ['employer', 'Acme Example'] };
      const BETA: Said = { fact: 'Alice Example joined Beta Example.', valid: P2, slot: ['employer', 'Beta Example'] };
      const TEA: Said = { fact: 'Alice Example likes green tea.', valid: P1 };
      const GARDEN: Said = { fact: 'Alice Example keeps a rooftop garden.', valid: P2 };
      const change = (extra = ''): Page[] => [{ slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [ACME, TEA] },
        { slug: 'meetings/chat-b', title: 'Chat B', date: P2, extra, said: [BETA, GARDEN] }];
      type As = Parameters<typeof dispatchToolCall>[3];
      const LOCAL: As = { remote: false, sourceId: 'default' };
      type Shown = Record<string, string | null>;
      /** Each fact about Alice a reader shows (a quoted excerpt unwrapped), with its valid_until day (null: open). */
      const shown = (facts: Array<{ fact: string; valid_until?: string | null }> | undefined): Shown =>
        Object.fromEntries((facts ?? []).map(f => [/```text\n([^\n]*)\n```/.exec(f.fact)?.[1] ?? f.fact, f.valid_until ? String(f.valid_until).slice(0, 10) : null] as const)
          .filter(([fact]) => fact.startsWith('Alice Example')));
      async function op(as: As, name: string, params: Record<string, unknown>) {
        __resetPrivateVisibilityCacheForTests();
        const r = await dispatchToolCall(engine, name, params, { ...as, metaHook: (n, ctx) => getBrainHotMemoryMeta(n, ctx) });
        if (r.isError) throw new Error(name + ': ' + r.content.map(c => c.text).join(' '));
        return { json: JSON.parse(r.content[0]!.text!) as Record<string, any>, meta: r._meta as Record<string, any> | undefined };
      }
      /** What each reader shows the caller: recall's entity list and history, recall by question, the entity card, hot memory. */
      async function readers(as: As) {
        __resetHotMemoryCacheForTests();
        return {
          recall: shown((await op(as, 'recall', { entity: ALICE })).json.facts),
          history: shown((await op(as, 'recall', { entity: ALICE, include_expired: true })).json.facts),
          question: shown((await op(as, 'recall', { question: 'Where does Alice Example work?' })).json.facts),
          card: shown((await op(as, 'entity', { name: 'Alice Example' })).json.card?.recent_facts),
          hot: shown((await op(as, 'list_pages', { limit: 1 })).meta?.brain_hot_memory?.facts),
        };
      }
      /** search's saved_facts (the named entity's facts, then the word matches) as the caller gets them. */
      const searchSaved = async (as: As) => shown((await op(as, 'search', { query: 'Alice Example' })).meta?.retrieval?.saved_facts);
      /** Local `gbrain recall --json`. */
      async function cliRecall(args: string[]): Promise<Shown> {
        let out = '';
        const write = process.stdout.write.bind(process.stdout);
        process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
        try { await runRecall(engine, [...args, '--json', '--source', 'default']); } finally { process.stdout.write = write; }
        return shown(JSON.parse(out).facts);
      }
      const savedFacts = async () => shown(await entitySavedFacts(engine, (await resolveQueryEntities(engine, 'Alice Example', { sourceId: 'default', excludePrivate: false }))[0]!,
        { remote: false, excludePrivate: false }));
      beforeEach(async () => {
        await engine.executeRaw('INSERT INTO trust_policy_state (id, generation) VALUES (1, 0) ON CONFLICT (id) DO NOTHING');
      });
      /** Credentials as serve --http verifies them: the owner's, and another member's (world-only facts). */
      async function credentials(): Promise<Record<'owner' | 'member', As>> {
        const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
        const out = {} as Record<'owner' | 'member', As>;
        for (const [who, member] of [['owner', 'owner-example'], ['member', 'bob-example']] as const) {
          await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1) ON CONFLICT DO NOTHING', [member]);
          const minted = await mintLegacyToken(engine, { name: who + '-' + randomUUID().slice(0, 8), scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default'] });
          await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
          const auth = await provider.verifyAccessToken(minted.token) as unknown as AuthInfo;
          out[who] = { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] };
        }
        await setOwner(engine, 'owner-example');
        return out;
      }

      test('an employer change across pages: the old employer reads as ended, or is dropped where only current facts show', async () => {
        await putPages(change());
        await extract(change());
        const open = { [BETA.fact]: null, [TEA.fact]: null, [GARDEN.fact]: null };
        const { question, ...r } = await readers(LOCAL);
        expect({ ...r, question: { acme: ACME.fact in question, beta: question[BETA.fact] }, saved: await savedFacts(), search: await searchSaved(LOCAL),
          cli: await cliRecall([ALICE]), cliHistory: await cliRecall([ALICE, '--include-expired']) })
          .toEqual({ recall: open, history: { ...open, [ACME.fact]: P2 }, card: open, hot: open, question: { acme: false, beta: null }, saved: open, search: open,
            cli: r.recall, cliHistory: r.history });
      });

      test('R94: the owner\'s credential sees the local owner\'s ends; a member never sees an end from a private row it cannot read', async () => {
        await engine.setConfig('facts.default_visibility', 'world');
        await putPages(change('visibility: private'));
        await extract(change('visibility: private'));
        const as = await credentials();
        const local = await readers(LOCAL);
        expect(local.history).toEqual({ [ACME.fact]: P2, [BETA.fact]: null, [TEA.fact]: null, [GARDEN.fact]: null });
        expect(await readers(as.owner)).toEqual(local);
        const member = await readers(as.member);
        expect(member.recall).toEqual({ [ACME.fact]: null, [TEA.fact]: null });
        expect(member.history).toEqual({ [ACME.fact]: null, [TEA.fact]: null });
        expect(member.card).toEqual({ [ACME.fact]: null, [TEA.fact]: null });
        expect(member.hot).toEqual({ [ACME.fact]: null, [TEA.fact]: null });
        expect(await searchSaved(as.member)).toEqual({ [ACME.fact]: null, [TEA.fact]: null });
        expect(await searchSaved(as.owner)).toEqual(await searchSaved(LOCAL));
      });

      test('a flagged later employer row that hot memory withholds never ends the earlier one there', async () => {
        await engine.setConfig('trust.agent_activation', 'suppress');
        await putPages(change());
        await extract(change());
        const [beta] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2', ['default', BETA.fact]);
        await engine.executeRaw(`INSERT INTO write_gate_receipts (target_table, target_id, source_id, content_hash, tier, detector_version, verdict, reason_families)
          VALUES ('facts', $1, 'default', md5($1), 'agent_written', 1, 'flag', ARRAY['standing_instruction']::text[])`, [String(beta!.id)]);
        expect((await readers(LOCAL)).hot).toEqual({ [ACME.fact]: null, [TEA.fact]: null, [GARDEN.fact]: null });
      });

      test('R94: a private-marked fact without a slot reads for the owner exactly as before', async () => {
        await engine.setConfig('facts.default_visibility', 'world');
        await putPages(change('visibility: private'));
        await extract(change('visibility: private'));
        const as = await credentials();
        for (const who of [LOCAL, as.owner]) {
          const r = await readers(who);
          for (const reader of ['recall', 'history', 'hot'] as const) expect({ reader, garden: r[reader][GARDEN.fact] }).toEqual({ reader, garden: null });
        }
        expect((await readers(as.member)).recall[GARDEN.fact]).toBeUndefined();
      });

      test('an ended employer never shortens a limited read, and the card counts only current facts', async () => {
        const OLD: Said = { fact: 'Alice Example grew up near the coast.', valid: '2024-11-01' };
        const pages: Page[] = [{ slug: 'meetings/chat-0', title: 'Chat 0', date: OLD.valid, said: [OLD] }, ...change()];
        await putPages(pages);
        await extract(pages);
        const current = { [BETA.fact]: null, [GARDEN.fact]: null, [TEA.fact]: null, [OLD.fact]: null };
        expect({ cli: await cliRecall([ALICE, '--limit', '4']), op: shown((await op(LOCAL, 'recall', { entity: ALICE, limit: 4 })).json.facts),
          question: await Promise.all([1, 2, 3, 9].map(async limit => {
            const facts = Object.keys(shown((await op(LOCAL, 'recall', { question: 'Where does Alice Example work?', limit })).json.facts));
            return { n: facts.length, acme: facts.includes(ACME.fact) };
          })),
          count: (await op(LOCAL, 'entity', { name: 'Alice Example' })).json.card?.active_fact_count })
          .toEqual({ cli: current, op: current, question: [1, 2, 3, 4].map(n => ({ n, acme: false })), count: 4 });
      });

      test('local recall groups the entity\'s fact keys the way the recall op does', async () => {
        await putPages(change());
        await extract(change());
        await engine.executeRaw('UPDATE facts SET entity_slug = $1 WHERE source_id = $2 AND fact = $3', ['alice-example', 'default', BETA.fact]);
        const viaOp = shown((await op(LOCAL, 'recall', { entity: ALICE })).json.facts);
        expect(viaOp[ACME.fact]).toBeUndefined();
        expect(await cliRecall([ALICE])).toEqual(viaOp);
      });

      test('the paged --since-last-run read marks an ended employer without dropping it', async () => {
        await putPages(change());
        await extract(change());
        const home = emptyHome();
        try {
          expect(await withEnv({ GBRAIN_HOME: home }, () => cliRecall([ALICE, '--since-last-run'])))
            .toEqual({ [ACME.fact]: P2, [BETA.fact]: null, [TEA.fact]: null, [GARDEN.fact]: null });
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });

      test('facts without slots and the facts block read exactly as before', async () => {
        const CHESS: Said = { fact: 'Alice Example plays chess on Sundays.', valid: P1 }, GYM: Said = { fact: 'Alice Example left her old gym.', valid: P2 };
        const plain: Page[] = [{ slug: 'meetings/chat-c', title: 'Chat C', date: P1, said: [CHESS] }, { slug: 'meetings/chat-d', title: 'Chat D', date: P2, said: [GYM] }];
        await putPages(plain);
        await extract(plain);
        const r = await readers(LOCAL);
        const both = { [CHESS.fact]: null, [GYM.fact]: null };
        for (const reader of ['recall', 'history', 'card', 'hot'] as const) expect({ reader, shown: r[reader] }).toEqual({ reader, shown: both });
        expect(await savedFacts()).toEqual(both);
        await putPages(change());
        await extract(change());
        const rows = await block('Where does Alice Example work?');
        expect(line(ACME.fact, rows)).toBe(quoted(header(P1, P1, P2), ACME.fact));
        expect(line(BETA.fact, rows)).toBe(quoted(header(P2, P2), BETA.fact));
      });
    });

    describe('ontology paths ignore conversation slots', () => {
      const PAGE: Page = { slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] };
      const manualRows = () => engine.executeRaw<{ expired_at: Date | null; consolidated_into: number | null }>(
        `SELECT expired_at, consolidated_into FROM facts WHERE source_id='default' AND entity_slug=$1 AND source='manual'`, [ALICE]);
      const openSlot = async () => (await engine.executeRaw<{ valid_until: Date | null; superseded_by: number | null }>(
        `SELECT valid_until, superseded_by FROM facts WHERE source_id='default' AND source LIKE 'cli:extract-conversation-facts%' AND dimension IS NOT NULL AND expired_at IS NULL`))[0];

      test('a proposal with the same value keeps its own row across a forced re-extraction', async () => {
        await putPages([PAGE]); await extract([PAGE]);
        await engine.mergeOntologyFact({ entitySlug: ALICE, dimension: 'location', value: 'Lisbon', source: 'manual', validFrom: P2, sourceId: 'default' });
        await extract([PAGE], { force: true });
        expect((await manualRows()).map(r => [r.expired_at, r.consolidated_into])).toEqual([[null, null]]);
      });

      test('a proposal with a new value never closes the conversation fact', async () => {
        await putPages([PAGE]); await extract([PAGE]);
        await call('ontology_propose', { entity: ALICE, dimension: 'location', value: 'Porto', valid_from: P2 });
        expect(await openSlot()).toEqual({ valid_until: null, superseded_by: null });
      });

      test('the ontology-facts repair and its doctor count list no conversation slot', async () => {
        await putPages([PAGE]); await extract([PAGE]);
        expect((await slotRows()).filter(r => r.dimension)).toHaveLength(1);
        expect(await classifyOntologyFacts(engine, ['default'])).toEqual([]);
      });

      test('a newer conversation slot does not change the ontology read or the dimension census', async () => {
        await engine.mergeOntologyFact({ entitySlug: ALICE, dimension: 'location', value: 'Lisbon', source: 'manual', validFrom: P1, sourceId: 'default' });
        const before = await engine.discoverOntologyDimensions({ sourceId: 'default' });
        const porto: Page = { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example lives in Porto.', valid: P2, slot: ['location', 'Porto'] }] };
        await putPages([porto]); await extract([porto]);
        expect((await slotRows()).filter(r => r.dimension)).toHaveLength(1);
        expect((await engine.getOntology(ALICE, { sourceId: 'default' })).map(v => [v.dimension, v.value, v.source])).toEqual([['location', 'Lisbon', 'manual']]);
        expect(await engine.discoverOntologyDimensions({ sourceId: 'default' })).toEqual(before);
      });

      const convSlot = (entity: string, rowNum: number, value = 'Lisbon', page = 'meetings/chat-a', day = P1) => engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, source_markdown_slug, row_num, visibility, confidence, valid_from,
          dimension, value, value_hash, dim_status)
        VALUES ('default', $1, $2, 'fact', 'cli:extract-conversation-facts', $3, $4, 'private', 1, $5::timestamptz, 'location', $6, $7, 'active')`,
        [entity, `${entity} lives in ${value}.`, page, rowNum, `${day}T00:00:00Z`, value, valueHash(value)]);

      test('a proposal on the exact key a conversation slot holds is stored, and the conversation fact gives up its slot', async () => {
        await putPages([PAGE]); await extract([PAGE]);
        const merged = await engine.mergeOntologyFact({ entitySlug: ALICE, dimension: 'location', value: 'Lisbon', source: PAGE.slug, validFrom: P1, sourceId: 'default' });
        expect(merged.action).toBe('inserted');
        expect((await engine.getOntology(ALICE, { sourceId: 'default' })).map(v => [v.value, v.source])).toEqual([['Lisbon', PAGE.slug]]);
        expect((await slotRows()).map(r => [r.fact, r.dimension])).toEqual([['Alice Example lives in Lisbon.', null]]);
      });

      test('a re-key keeps the ontology observation over a colliding conversation slot', async () => {
        await convSlot('people/bob-example', 0);
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, source_markdown_slug, visibility, confidence, valid_from, dimension, value, value_hash, dim_status)
          VALUES ('default', 'people/bob-old-example', 'location: Lisbon', 'fact', 'manual', 'meetings/chat-a', 'private', 0.7, $1::timestamptz, 'location', 'Lisbon', $2, 'active')`, [`${P1}T00:00:00Z`, valueHash('Lisbon')]);
        await dropRekeyDuplicates(engine, 'default', { where: 'f.entity_slug = $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: ['people/bob-old-example', 'people/bob-example'] });
        const rows = await engine.executeRaw<{ source: string; dimension: string | null }>(`SELECT source, dimension FROM facts WHERE source_id='default' AND entity_slug LIKE 'people/bob%' ORDER BY source`);
        expect(rows).toEqual([{ source: 'cli:extract-conversation-facts', dimension: null }, { source: 'manual', dimension: 'location' }]);
      });

      test('a twin merge over two colliding conversation slots completes and keeps both facts', async () => {
        for (const slug of ['people/dan-example', 'people/dan-example-2']) await call('put_page', { slug, content: '---\ntitle: Dan Example\ntype: person\n---\n# Dan Example\n' });
        await convSlot('people/dan-example', 0); await convSlot('people/dan-example-2', 1);
        const id = async (slug: string) => Number((await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.id);
        const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
        const survivor = { page_id: await id('people/dan-example'), slug: 'people/dan-example' }, twin = { page_id: await id('people/dan-example-2'), slug: 'people/dan-example-2' };
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => mergeTwinInto(tx, { sourceId: 'default', incarnation, survivor, twin }), TEST_WRITE_ATTRIBUTION));
        const rows = await engine.executeRaw<{ entity_slug: string; dimension: string | null }>(`SELECT entity_slug, dimension FROM facts WHERE source_id='default' AND entity_slug LIKE 'people/dan%' ORDER BY row_num`);
        expect(rows).toEqual([{ entity_slug: 'people/dan-example', dimension: 'location' }, { entity_slug: 'people/dan-example', dimension: null }]);
      });

      test('a retention purge keeps the value of a fenced ontology observation filed on the page', async () => {
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, source_markdown_slug, row_num, visibility, confidence, valid_from, dimension, value, value_hash, dim_status)
          VALUES ('default', $1, 'location: Lisbon', 'fact', 'manual', $1, 0, 'private', 0.7, $2::timestamptz, 'location', 'Lisbon', $3, 'active')`, [ALICE, `${P1}T00:00:00Z`, valueHash('Lisbon')]);
        await expireGonePageFacts(engine, [{ source_id: 'default', slug: ALICE }]);
        const [row] = await engine.executeRaw<{ dimension: string | null; value: string | null }>("SELECT dimension, value FROM facts WHERE source_id='default' AND source='manual'");
        expect(row).toEqual({ dimension: 'location', value: 'Lisbon' });
      });

      test('a return to an earlier value keeps the restated value open', async () => {
        const pages: Page[] = [
          { slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] },
          { slug: 'meetings/chat-c', title: 'Chat C', date: P3, said: [] },
        ];
        await putPages(pages); await extract(pages.slice(0, 2));
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, source_markdown_slug, row_num, visibility, confidence, valid_from,
            dimension, value, value_hash, dim_status)
          VALUES ('default', $1, 'Alice Example lives in Lisbon.', 'fact', 'cli:extract-conversation-facts', 'meetings/chat-c', 0, 'private', 1, $2::timestamptz, 'location', 'Lisbon', $3, 'active')`,
          [ALICE, `${P3}T00:00:00Z`, valueHash('Lisbon')]);
        const lisbon = (await block(LIVE_Q)).find(r => r.includes('Alice Example lives in Lisbon.'));
        expect(lisbon?.split('\n')[0]).toBe(header(P1, P1));
      });

      test('a return to an earlier value said again in the same words is published, so the earlier value reopens', async () => {
        const pages: Page[] = [
          { slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] },
          { slug: 'meetings/chat-c', title: 'Chat C', date: P3, said: [{ ...LISBON, valid: P3 }] },
          { slug: 'meetings/chat-d', title: 'Chat D', date: P3, said: [{ ...LISBON, valid: P3 }] },
        ];
        await putPages(pages); await extract(pages);
        expect((await slotRows()).map(r => [r.source_markdown_slug, r.value])).toEqual([['meetings/chat-a', 'Lisbon'], ['meetings/chat-b', 'Porto'], ['meetings/chat-c', 'Lisbon']]);
        const lisbon = (await block(LIVE_Q)).find(r => r.includes('Alice Example lives in Lisbon.'));
        expect(lisbon?.split('\n')[0]).toBe(header(P1, P1));
      });

      test('a return to an earlier value with no event date is published and stays undated', async () => {
        const pages: Page[] = [
          { slug: 'meetings/chat-a', title: 'Chat A', date: P1, said: [LISBON] },
          { slug: 'meetings/chat-b', title: 'Chat B', date: P2, said: [{ fact: 'Alice Example moved to Porto.', valid: P2, slot: ['location', 'Porto'] }] },
          { slug: 'meetings/chat-c', title: 'Chat C', date: P3, said: [] },
        ];
        await putPages(pages); await extract(pages.slice(0, 2));
        const [first] = await engine.executeRaw<{ source: string }>(`SELECT source FROM facts WHERE source_markdown_slug='meetings/chat-a' AND dimension='location'`);
        const restated = { fact: LISBON.fact, kind: 'fact', entity_slug: ALICE, context: null, valid_from: null, valid_until: null, source: first!.source,
          source_session: null, confidence: 1, notability: 'high', embedding: null, embedding_model: null, visibility: 'private', dimension: 'location', value: 'Lisbon' };
        const published = await publishConversationFacts(engine, 'default', 'meetings/chat-c', [restated as never], { scope: 'window' });
        expect([published.facts_inserted, published.duplicates_skipped]).toEqual([1, 0]);
        const [row] = await engine.executeRaw<{ valid_from: Date | null }>(`SELECT valid_from FROM facts WHERE source_markdown_slug='meetings/chat-c' AND dimension='location'`);
        expect(row?.valid_from ?? null).toBeNull();
      });

      test('an ontology observation never ends a conversation window', async () => {
        await putPages([PAGE]); await extract([PAGE]);
        await engine.mergeOntologyFact({ entitySlug: ALICE, dimension: 'location', value: 'Porto', source: PAGE.slug, validFrom: P2, sourceId: 'default' });
        expect(line('Alice Example lives in Lisbon.', await block(LIVE_Q))).toBe(quoted(header(P1, P1), 'Alice Example lives in Lisbon.'));
      });

      test('a rename that collides two conversation slots keeps both facts and clears the losing slot', async () => {
        for (const entity of ['people/bob-old-example', 'people/bob-example']) {
          await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, source_markdown_slug, row_num, visibility, confidence, valid_from,
              dimension, value, value_hash, dim_status)
            VALUES ('default', $1, $2, 'fact', 'cli:extract-conversation-facts', 'meetings/chat-a', $5, 'private', 1, $3::timestamptz, 'location', 'Lisbon', $4, 'active')`,
            [entity, `${entity} lives in Lisbon.`, `${P1}T00:00:00Z`, valueHash('Lisbon'), entity.length]);
        }
        await dropRekeyDuplicates(engine, 'default', { where: 'f.entity_slug = $2', entity: '$3::text', sms: 'f.source_markdown_slug', params: ['people/bob-old-example', 'people/bob-example'] });
        const rows = await engine.executeRaw<{ entity_slug: string; dimension: string | null }>(
          `SELECT entity_slug, dimension FROM facts WHERE source_id='default' AND entity_slug LIKE 'people/bob%' ORDER BY entity_slug`);
        expect(rows).toEqual([{ entity_slug: 'people/bob-example', dimension: 'location' }, { entity_slug: 'people/bob-old-example', dimension: null }]);
      });
    });

    describe('findOntologyConflicts', () => {
      const conflicts = async () => (await engine.findOntologyConflicts({ sourceId: 'default' }))
        .map(c => ({ entity_slug: c.entity_slug, dimension: c.dimension, values: c.values.map(v => [v.value, v.source]).sort() }));

      test('keeps its output for ontology rows and ignores conversation rows', async () => {
        await engine.mergeOntologyFact({ entitySlug: 'people/bob-example', dimension: 'role', value: 'founder', source: 'meetings/a', validFrom: '2026-01-01', sourceId: 'default' });
        await engine.mergeOntologyFact({ entitySlug: 'people/bob-example', dimension: 'role', value: 'advisor', source: 'meetings/b', validFrom: '2025-06-01', sourceId: 'default' });
        const before = await conflicts();
        expect(before).toEqual([{ entity_slug: 'people/bob-example', dimension: 'role', values: [['advisor', 'meetings/b'], ['founder', 'meetings/a']] }]);
        for (const [value, slug, day] of [['Lisbon', 'meetings/chat-a', P1], ['Porto', 'meetings/chat-b', P2]] as const) {
          await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, source_markdown_slug, row_num, visibility, confidence, valid_from,
              dimension, value, value_hash, dim_status)
            VALUES ('default', $1, $2, 'fact', 'cli:extract-conversation-facts', $3, 0, 'private', 1, $4::timestamptz, 'location', $5, $6, 'active')`,
            ['people/carol-example', `Carol Example lives in ${value}.`, slug, `${day}T00:00:00Z`, value, valueHash(value)]);
        }
        expect(await conflicts()).toEqual(before);
      });
    });
  });
}

describe('managed brain', () => {
  const SLUG = 'meetings/chat-managed';
  const content = convo('Chat Managed', P1);
  async function putManaged(brain: ManagedBrain) {
    for (const [slug, body] of [[ALICE, '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA designer.\n'], [SLUG, content]] as const) {
      await submitPageMutation(brain.ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content: body } });
    }
    await disposePersistenceConsumer(brain.engine);
  }
  const run = (brain: ManagedBrain, force = false) => runExtractConversationFactsCore(brain.engine, { sourceId: 'default', slugs: [SLUG], sleepMs: 0, overrideDisabled: true, force,
    extractor: async () => [asFact(LISBON), asFact({ fact: 'Alice Example is based in Lisbon.', valid: P1, slot: ['location', 'Lisbon'] })] });

  for (const backend of testBackends()) {
    test(`${backend}: the receipted batch stores the slot; a repeated key and --force twice never fail`, async () => {
      await managedBrain(async (brain) => {
        await putManaged(brain);
        for (const force of [false, true, true]) {
          const result = await run(brain, force);
          expect(result.pages_failed).toBe(0);
          expect(result.pages_processed).toBe(1);
        }
        const rows = await brain.engine.executeRaw<{ fact: string; dimension: string | null; value: string | null; value_hash: string | null; dim_status: string | null }>(
          `SELECT fact, dimension, value, value_hash, dim_status FROM facts WHERE source_id='default' AND source_markdown_slug=$1
            AND source LIKE 'cli:extract-conversation-facts%' AND fact NOT LIKE 'EXTRACTION_%' AND expired_at IS NULL ORDER BY row_num`, [SLUG]);
        expect(rows.map(r => [r.fact, r.dimension, r.value, r.value_hash, r.dim_status])).toEqual([
          ['Alice Example lives in Lisbon.', 'location', 'Lisbon', valueHash('Lisbon'), 'active'],
          ['Alice Example is based in Lisbon.', null, null, null, null],
        ]);
      }, { databaseUrl: backend === 'postgres' ? requirePostgresTestDatabase() : undefined });
    }, 120_000);

    test(`${backend}: a slot from the tagging call rides the receipted batch`, async () => {
      const reply = (text: string) => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'test:stub', providerId: 'test',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } }) as ChatResult;
      __setChatTransportForTests(async opts => reply(opts.system === SLOT_TAG_SYSTEM
        ? '{"slots":[{"i":1,"dimension":"location","value":"Lisbon"}]}'
        : JSON.stringify({ facts: [{ fact: 'Alice Example lives in Lisbon.', kind: 'fact', entity: ALICE, confidence: 1, notability: 'high' }] })));
      try {
        await managedBrain(async (brain) => {
          await putManaged(brain);
          const result = await runExtractConversationFactsCore(brain.engine, { sourceId: 'default', slugs: [SLUG], sleepMs: 0, overrideDisabled: true });
          expect([result.pages_failed, result.pages_processed, result.slot_tagging_failed]).toEqual([0, 1, undefined]);
          const rows = await brain.engine.executeRaw<{ fact: string; dimension: string | null; value: string | null; value_hash: string | null; dim_status: string | null }>(
            `SELECT fact, dimension, value, value_hash, dim_status FROM facts WHERE source_id='default' AND source_markdown_slug=$1
              AND source LIKE 'cli:extract-conversation-facts%' AND fact NOT LIKE 'EXTRACTION_%' AND expired_at IS NULL`, [SLUG]);
          expect(rows.map(r => [r.fact, r.dimension, r.value, r.value_hash, r.dim_status])).toEqual([
            ['Alice Example lives in Lisbon.', 'location', 'Lisbon', valueHash('Lisbon'), 'active']]);
        }, { databaseUrl: backend === 'postgres' ? requirePostgresTestDatabase() : undefined });
      } finally { __setChatTransportForTests(null); resetGateway(); }
    }, 120_000);
  }
});
