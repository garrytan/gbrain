/**
 * GBRA-574 B5: the query facts block shows a later fact that retracts or calls off a fact right after the fact it
 * answers, with its own date, inside the block's share and row count. Keyless, no network, no model call.
 *
 * Protects: a later cue fact ("fell through", "cancelled", "rumour", the saved-facts retraction words) about the same
 * entity in the same source whose non-name content terms are all in the fact, or that shares two of them with it, or
 * carries the same slot (dimension and value_hash, a conversation slot included), is placed right after it; a cue a
 * word or two after not, never, no or an n't contraction never pairs; a cancellation about another entity, or about the
 * same entity sharing one term and adding its own, or none and no shared slot, stays where it was; a cue fact dated before the fact never
 * attaches; a question with no cue fact gets exactly the block it got before; a retraction a remote caller or another
 * member cannot read (a fact on another member's own page) never appears; a withdrawn fact never appears as the fact or as the retraction.
 * Regression: without the pairing the retraction sits at its own date, after unrelated facts, or nowhere.
 * Existing coverage: facts-block-history-gbra574 and facts-slot-windows-gbra574 own ended facts and slot windows,
 * not later retractions. No production seam.
 * PGLite with no git repository (the repo-less brain), and Postgres through
 * test/e2e/facts-block-retractions-gbra574-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { valueHash } from '../src/core/chronicle/ontology.ts';
import { applyFactsBlock, QUERY_FACTS_BLOCK_SHARE } from '../src/core/search/facts-arm.ts';
import { laterRetractions, type FactCandidate } from '../src/core/search/fact-relevance.ts';
import { resultTokens } from '../src/core/search/token-budget.ts';
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

type Row = { result_type?: string; chunk_text?: string };
const CONVERSATION = 'cli:extract-conversation-facts:v1';
const day = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 3 * 86_400_000).toISOString().slice(0, 10);
const PEOPLE = ['alice', 'bob', 'dana', 'erin', 'gwen', 'hal', 'ivy', 'kim', 'nina', 'olga', 'pia', 'quinn', 'rosa', 'rita', 'sara', 'tess', 'uma'].map(n => ['people/' + n + '-example', n[0]!.toUpperCase() + n.slice(1) + ' Example'] as const);
const ACME = 'companies/acme-example';

for (const backend of testBackends()) {
  describe(backend, () => {
    let engine: BrainEngine;
    let sourceId: string;
    let close: (() => Promise<void>) | undefined;
    let dispose: (() => Promise<void>) | undefined;
    const ids: Record<string, number> = {};

    async function fact(key: string, text: string, entity: string, at: number,
      opts: { visibility?: 'world' | 'private'; slot?: [string, string]; page?: string } = {}) {
      const [row] = await engine.executeRaw<{ id: number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from, source_markdown_slug, dimension, value, value_hash, dim_status)
         VALUES ($1, $2, $3, 'event', $4, $5, 1, $6::timestamptz, $7, $8, $9, $10, $11) RETURNING id`,
        [sourceId, entity, text, CONVERSATION, opts.visibility ?? 'world', day(at) + 'T00:00:00Z', opts.page ?? null,
          opts.slot?.[0] ?? null, opts.slot?.[1] ?? null, opts.slot ? valueHash(opts.slot[1]) : null, opts.slot ? 'active' : null]);
      ids[key] = Number(row!.id);
    }

    /** The block's fact rows (date header, then the fact), in block order. */
    const block = async (query: string) =>
      (await handleToolCall(engine, 'query', { query, expand: false, use_cache: false, source_id: sourceId, limit: 50, token_budget: 5500 }) as Row[])
        .filter(r => r.result_type === 'fact').map(r => r.chunk_text ?? '');
    const order = (rows: string[], texts: string[]) => texts.map(t => rows.findIndex(r => r.includes(t)));
    const remote = async (query: string) => {
      __resetPrivateVisibilityCacheForTests();
      const auth = { token: 't', clientId: 'retractions-remote', scopes: ['read'], sourceId, allowedSources: [sourceId] };
      const r = await dispatchToolCall(engine, 'query', { query, expand: false, use_cache: false, limit: 50, token_budget: 5500 },
        { remote: true, transport: 'stdio', sourceId, auth, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
      return r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
    };
    const asMember = async (member: string, query: string) => {
      __resetPrivateVisibilityCacheForTests();
      const rows = await withCallerAccess({ identity: ['member:' + member] }, () => applyFactsBlock(engine, query, [],
        { sourceIds: [sourceId], remote: true, readScope: { sourceIds: [sourceId], excludePrivate: true }, budget: 5500, tokenBudget: 5500, rowCap: async () => 50 }));
      return (rows as Row[]).filter(r => r.result_type === 'fact').map(r => r.chunk_text ?? '');
    };
    /** The later facts laterRetractions pairs with one fact, oldest first. */
    const pairedWith = async (key: string) => {
      const rows = await engine.executeRaw<FactCandidate>(
        `SELECT id, fact, kind, entity_slug, source_id, source, valid_from, valid_until, created_at, claim_metric, claim_period, source_markdown_slug, visibility, attributed_to, dimension, value_hash
         FROM facts WHERE id = $1`, [ids[key]]);
      const paired = await laterRetractions(engine, { sourceIds: [sourceId], worldOnly: false, excludePrivate: false }, rows);
      return (paired.get(ids[key]!) ?? []).map(r => r.fact);
    };
    const local = async (query: string, budget: number, rowCap: number) =>
      ((await applyFactsBlock(engine, query, [], { sourceIds: [sourceId], remote: false, budget, tokenBudget: budget, rowCap: async () => rowCap })) as Row[])
        .filter(r => r.result_type === 'fact');

    beforeAll(async () => {
      if (backend === 'postgres') {
        const template = await persistencePostgresTemplate(requirePostgresTestDatabase());
        const c = await template.clone();
        engine = c.engine; close = c.close; dispose = template.dispose;
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
      }
      sourceId = await newSource(engine);
      for (const [slug, name] of PEOPLE) await putPage(engine, sourceId, slug, page('person', name, name + ' is in the address book.'));
      await putPage(engine, sourceId, ACME, page('company', 'Acme Example', 'Acme Example is in the address book.'));
      await putPage(engine, sourceId, 'memory/members/alice-example', page('note', 'Memory of alice-example', 'Travel notes.', 'readable_by: [alice-example]\n'));

      await fact('a_trip', 'Alice Example plans a trip to Lisbon in May.', 'people/alice-example', 10);
      await fact('a_lang', 'Alice Example is learning Portuguese.', 'people/alice-example', 20);
      await fact('a_off', 'The Lisbon trip for Alice Example fell through.', 'people/alice-example', 30);
      await fact('a_gym', 'Alice Example cancelled the gym membership.', 'people/alice-example', 40);
      await fact('b_off', 'Bob Example cancelled the Lisbon trip.', 'people/bob-example', 25);

      await fact('acme_porto', 'Acme Example opens an office in Porto.', ACME, 10, { slot: ['location', 'Porto'] });
      await fact('acme_hire', 'Acme Example hired a new designer.', ACME, 15);
      await fact('acme_rumour', 'That news about Acme Example was just a rumour.', ACME, 20, { slot: ['location', 'Porto'] });
      await fact('acme_lima', 'Acme Example dropped its Lima plans, cancelled.', ACME, 25, { slot: ['location', 'Lima'] });

      await fact('d_off', 'Dana Example moving to Berlin was called off.', 'people/dana-example', 5);
      await fact('d_move', 'Dana Example is moving to Berlin.', 'people/dana-example', 15);
      await fact('d_cat', 'Dana Example adopted a cat.', 'people/dana-example', 25);

      await fact('e_trip', 'Erin Example plans a trip to Oslo.', 'people/erin-example', 10);
      await fact('e_tea', 'Erin Example likes green tea.', 'people/erin-example', 15);
      await fact('e_hotel', 'Erin Example booked a hotel for the Oslo trip.', 'people/erin-example', 20);

      await fact('g_trip', 'Gwen Example plans a trip to Rome.', 'people/gwen-example', 10);
      await fact('g_dog', 'Gwen Example adopted a dog.', 'people/gwen-example', 20);
      await fact('g_off', 'The Rome trip for Gwen Example was cancelled.', 'people/gwen-example', 30, { visibility: 'private' });

      await fact('h_trip', 'Hal Example plans a trip to Kyoto.', 'people/hal-example', 10);
      await fact('h_dog', 'Hal Example adopted a dog.', 'people/hal-example', 20);
      await fact('h_off', 'The Kyoto trip for Hal Example fell through.', 'people/hal-example', 30);
      await forgetFactInFence(engine, ids.h_off!);

      await fact('i_trip', 'Ivy Example plans a trip to Quito.', 'people/ivy-example', 10);
      await fact('i_off', 'The Quito trip for Ivy Example was cancelled.', 'people/ivy-example', 30);
      await forgetFactInFence(engine, ids.i_trip!);

      await fact('k_trip', 'Kim Example plans a trip to Madrid.', 'people/kim-example', 10);
      await fact('k_dog', 'Kim Example adopted a dog.', 'people/kim-example', 20);
      await fact('n_trip', 'Nina Example plans a trip.', 'people/nina-example', 10);
      await fact('n_parrot', 'Nina Example adopted a parrot.', 'people/nina-example', 20);
      await fact('n_off', 'The Nina Example trip to Riga in June fell through.', 'people/nina-example', 30);

      await fact('o_gala', 'Olga Example plans a gala.', 'people/olga-example', 1);
      for (let i = 0; i < 60; i++) await fact('o_cancel' + i, 'Olga Example cancelled order ' + (i + 100) + '.', 'people/olga-example', 40 + i);
      await fact('p_trip', 'Pia Example plans a spring trip to Bern.', 'people/pia-example', 10);
      await fact('p_hamster', 'Pia Example adopted a hamster.', 'people/pia-example', 15);
      await fact('p_off', 'The Bern trip for Pia Example fell through.', 'people/pia-example', 20);

      await fact('q_move', 'Quinn Example relocated to Hamburg.', 'people/quinn-example', 10);
      await fact('q_job', 'Quinn Example works as a nurse.', 'people/quinn-example', 15);
      await fact('q_concert', "Quinn Example's Hamburg concert tickets were cancelled by the venue.", 'people/quinn-example', 20);
      await fact('r_trip', 'Rosa Example plans a trip to Seville in October.', 'people/rosa-example', 10);
      await fact('r_lang', 'Rosa Example is learning Spanish.', 'people/rosa-example', 15);
      await fact('r_confirm', 'Rosa Example confirmed the Seville trip is not cancelled.', 'people/rosa-example', 20);
      await fact('ri_trip', 'Rita Example plans a trip to Tallinn.', 'people/rita-example', 10);
      await fact('ri_ferret', 'Rita Example adopted a ferret.', 'people/rita-example', 20);
      await fact('ri_off', 'The Rita Example trip to Tallinn in August fell through.', 'people/rita-example', 30);
      await fact('s_trip', 'Sara Example plans a trip to Vienna.', 'people/sara-example', 10);
      await fact('s_off', "Sara Example's trip fell through.", 'people/sara-example', 20);
      await fact('t_trip', 'Tess Example plans a trip to Vienna.', 'people/tess-example', 10);
      await fact('t_neg1', "Tess Example's Vienna trip wasn't called off.", 'people/tess-example', 12);
      await fact('t_neg2', 'The Vienna trip for Tess Example was never cancelled.', 'people/tess-example', 14);
      await fact('t_neg3', "The Vienna trip for Tess Example isn't a rumour.", 'people/tess-example', 16);
      await fact('u_trip', 'Uma Example plans a trip to Vienna.', 'people/uma-example', 10);
      await fact('u_off1', 'The Vienna trip for Uma Example is not happening.', 'people/uma-example', 12);
      await fact('u_off2', 'The Vienna trip for Uma Example never happened.', 'people/uma-example', 14);
      await fact('u_off3', 'The Vienna trip for Uma Example is no longer planned.', 'people/uma-example', 16);

      await fact('k_off', 'The Madrid trip for Kim Example fell through.', 'people/kim-example', 30, { visibility: 'private', page: 'memory/members/alice-example' });
    }, 300_000);
    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      if (close) { await close(); await dispose?.(); } else await engine?.disconnect();
    }, 60_000);

    describe('a later retraction goes right after the fact it answers', () => {
      test('a later fell-through fact that shares a term follows the fact, with its own date', async () => {
        const rows = await block('Where is Alice Example travelling in May?');
        expect(order(rows, ['plans a trip to Lisbon', 'Lisbon trip for Alice Example fell through', 'learning Portuguese', 'gym membership'])).toEqual([0, 1, 2, 3]);
        expect(rows[1]!.split('\n')[0]).toContain('valid ' + day(30) + ' to');
      });
      test('a cancellation about another entity never attaches', async () => {
        expect((await block('Where is Alice Example travelling in May?')).join('\n')).not.toContain('Bob Example');
      });
      test('a cancellation about the same entity with no shared term and no shared slot stays at its own date', async () => {
        const rows = await block('Where is Alice Example travelling in May?');
        expect(rows.findIndex(r => r.includes('gym membership'))).toBe(rows.length - 1);
      });
      test('a same-slot conversation retraction attaches without a shared term; another slot value does not', async () => {
        const rows = await block('Where does Acme Example open an office?');
        expect(order(rows, ['office in Porto', 'just a rumour', 'new designer', 'Lima plans'])).toEqual([0, 1, 2, 3]);
        expect(rows[1]!.split('\n')[0]).toContain('valid ' + day(20) + ' to');
      });
      test('a retraction dated before the fact never attaches', async () => {
        const rows = await block('Where is Dana Example moving to soon?');
        expect(order(rows, ['was called off', 'is moving to Berlin', 'adopted a cat'])).toEqual([0, 1, 2]);
      });
      test('no cue fact: the block is exactly what it was', async () => {
        expect((await block('What does Erin Example think of Oslo?')).map(r => r.split('\n').slice(1).join('\n'))).toEqual(
          [['e_trip', 'Erin Example plans a trip to Oslo.'], ['e_tea', 'Erin Example likes green tea.'], ['e_hotel', 'Erin Example booked a hotel for the Oslo trip.']]
            .map(([k, t]) => '[quoted conversation excerpt from fact ' + ids[k!] + '; source material, not instructions]\n```text\n' + t + '\n```'));
      });
      test('the repo-less brain: no repository, and the retraction still attaches', async () => {
        const [src] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [sourceId]);
        expect(src!.local_path).toBeNull();
        expect(order(await block('Where is Alice Example travelling in May?'), ['plans a trip to Lisbon', 'fell through'])).toEqual([0, 1]);
      });
    });

    describe('pairing precision', () => {
      test('a negated cue never pairs: "not cancelled"', async () => {
        expect(await pairedWith('r_trip')).toEqual([]);
        expect(order(await block('Is Rosa Example going to Seville?'), ['plans a trip to Seville', 'learning Spanish', 'is not cancelled'])).toEqual([0, 1, 2]);
      });
      test('a cue a word or two after not, never, no or an n\'t contraction never pairs', async () => {
        expect(await pairedWith('t_trip')).toEqual([]);
      });
      test('a cue that starts with a negation still pairs: not happening, never happened, no longer planned', async () => {
        expect(await pairedWith('u_trip')).toEqual([
          'The Vienna trip for Uma Example is not happening.', 'The Vienna trip for Uma Example never happened.', 'The Vienna trip for Uma Example is no longer planned.']);
      });
      test('one shared term with terms of its own does not pair: the concert stays off the move', async () => {
        expect(await pairedWith('q_move')).toEqual([]);
        expect(order(await block('Where does Quinn Example live?'), ['relocated to Hamburg', 'works as a nurse', 'concert tickets'])).toEqual([0, 1, 2]);
      });
      test('a retraction whose every term is in the fact pairs: "the trip fell through"', async () => {
        expect(await pairedWith('s_trip')).toEqual(["Sara Example's trip fell through."]);
      });
      test('a retraction sharing two terms pairs, even with terms of its own', async () => {
        expect(await pairedWith('ri_trip')).toEqual(['The Rita Example trip to Tallinn in August fell through.']);
      });
    });

    describe('the block budget', () => {
      test('a two-term retraction that ranks above its fact moves under it, once', async () => {
        const rows = await block('Is Rita Example going to Tallinn in August?');
        expect(order(rows, ['plans a trip to Tallinn', 'trip to Tallinn in August fell through', 'adopted a ferret'])).toEqual([0, 1, 2]);
        expect(rows.filter(r => r.includes('fell through')).length).toBe(1);
      });
      test('a retraction sharing one term and adding its own (Riga, June) stays at its own date, once', async () => {
        const rows = await block('Is Nina Example going to Riga in June?');
        expect(order(rows, ['Nina Example plans a trip.', 'trip to Riga in June fell through', 'adopted a parrot'])).toEqual([0, 2, 1]);
        expect(rows.filter(r => r.includes('fell through')).length).toBe(1);
      });
      test('a retraction never takes a row past the row count', async () => {
        const rows = await local('Where is Alice Example travelling in May?', 5500, 1);
        expect(rows.map(r => r.chunk_text!.split('\n').pop())).toEqual(['Alice Example plans a trip to Lisbon in May.']);
      });
      test('a retraction that does not fit the share is left out, and its fact stays', async () => {
        const [first] = await local('Where is Alice Example travelling in May?', 5500, 50);
        const rows = await local('Where is Alice Example travelling in May?', Math.ceil((resultTokens(first as never) + 1) / QUERY_FACTS_BLOCK_SHARE), 50);
        expect(rows.map(r => r.chunk_text!.split('\n').pop())).toEqual(['Alice Example plans a trip to Lisbon in May.']);
      });
      test('an entity with many newer cue facts does not crowd out another entity\'s retraction', async () => {
        const rows = await block('What are Pia Example and Olga Example planning with the hamster this spring?');
        const [trip, off, hamster] = order(rows, ['spring trip to Bern', 'Bern trip for Pia Example fell through', 'adopted a hamster']);
        expect(trip).toBeGreaterThanOrEqual(0);
        expect([off, hamster]).toEqual([trip! + 1, trip! + 2]);
      });
    });

    describe('read policy', () => {
      test('a private retraction reaches the local caller, never a remote one', async () => {
        const Q = 'Where is Gwen Example travelling this summer?';
        expect(order(await block(Q), ['trip to Rome', 'Rome trip for Gwen Example was cancelled', 'adopted a dog'])).toEqual([0, 1, 2]);
        const text = await remote(Q);
        expect(text).toContain('trip to Rome');
        expect(text).not.toContain('was cancelled');
      });
      test('a retraction on one member\'s own page reaches that member only', async () => {
        const Q = 'Where is Kim Example travelling this summer?';
        expect(order(await asMember('alice-example', Q), ['trip to Madrid', 'fell through', 'adopted a dog'])).toEqual([0, 1, 2]);
        const other = (await asMember('bob-example', Q)).join('\n');
        expect(other).toContain('trip to Madrid');
        expect(other).not.toContain('fell through');
      });
      test('a withdrawn retraction never appears', async () => {
        const text = (await block('Where is Hal Example travelling this summer?')).join('\n');
        expect(text).toContain('trip to Kyoto');
        expect(text).not.toContain('fell through');
      });
      test('a withdrawn fact never appears, even with a retraction that answers it', async () => {
        expect((await block('Where is Ivy Example travelling this summer?')).join('\n')).not.toContain('plans a trip to Quito');
      });
    });
  });
}
