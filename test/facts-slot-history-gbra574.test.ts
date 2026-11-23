/**
 * GBRA-574 F (part B): the slot-history arm of the query facts block. Keyless, no network, no model call.
 *
 * Protects: a question with a history cue that names one slot dimension (role, employer, location) about one named
 * entity gets every readable active slot value that entity has had in that dimension, oldest first, each with its date
 * and read-time window, inside the block's row count and token share; a current-value question, a question with no
 * dimension or with two gets no arm; the entity is the one page the question names (its fact keys through
 * factEntitySlugs) or, with no page, the one unbacked name key (a bare two-word slug with no live page) whose words the
 * question holds as a run, so two candidates match none; a page later written at people/<key> adopts the key's rows,
 * and a value under the page ends a stint under the key; the same key in two sources stays two people; a remote or
 * member-scoped caller never sees a value it cannot read (and an unreadable row never ends a readable window), nor the
 * history of a page it cannot read; withdrawn, superseded and expired rows never show; a failed history read keeps the
 * block, marks its rows and reports the degraded stage facts_history_unavailable; an engine capability refusal of a
 * read the block needs rejects with that typed refusal, never an empty or degraded block.
 * PGLite with no git repository (the repo-less brain), Postgres through
 * test/e2e/facts-slot-history-gbra574-postgres.test.ts, and the Rust arm with GBRAIN_TEST_RUST_ARM=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { valueHash } from '../src/core/chronicle/ontology.ts';
import { applyFactsBlock, QUERY_FACTS_BLOCK_SHARE } from '../src/core/search/facts-arm.ts';
import { matchUnbackedKey, slotHistoryDimension } from '../src/core/search/slot-history.ts';
import { resultTokens } from '../src/core/search/token-budget.ts';
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { createRustSource, openRustBrain, removeBrainDir, rustArmRequested } from './engine-parity/rust-arm.ts';

type Row = { result_type?: string; chunk_text?: string; fact_row?: { history_unavailable?: true } };
const CONVERSATION = 'cli:extract-conversation-facts:v1';
const ROLE_Q = 'In plain words, which job titles has Alice Example held over time?';
const head = (from: string, until = 'unknown') => '[observed unknown; valid ' + from + ' to ' + until + ']';
/** The slot history read (engine-sql/facts-recall.ts listSlotRows): H1 makes this member call fail. */
const HISTORY_READ = 'listSlotRows' as const;
const logger = { info() {}, warn() {}, error() {} };
/** The quoted-page read (engine-sql/facts-recall.ts listFactsFromQuotedPages) every facts block makes. */
const QUOTED_READ = 'listFactsFromQuotedPages' as const;

/** `base` with `member` rejecting `error`; every other member answers from `base`. */
const rejecting = (base: BrainEngine, member: string, error: () => Error) => new Proxy(base, { get(target, prop) {
  if (prop === member) return () => Promise.reject(error());
  const v = (target as unknown as Record<string, unknown>)[prop as string];
  return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
} }) as BrainEngine;
const refused = (member: string) => () => capabilityMissing('facts', member);

describe('slotHistoryDimension', () => {
  test('a history cue plus one dimension fires, with that dimension', () => {
    expect(slotHistoryDimension(ROLE_Q, '2026-11-17')).toBe('role');
    expect(slotHistoryDimension("List Alice Example's employers, oldest first.", '2026-11-17')).toBe('employer');
    expect(slotHistoryDimension('Which cities has Alice Example lived in, in order?', '2026-11-17')).toBe('location');
    expect(slotHistoryDimension('What companies has Alice Example worked at before?', '2026-11-17')).toBe('employer');
  });
  test('a current-value question, no dimension, or two dimensions never fires', () => {
    expect(slotHistoryDimension('Where does Alice Example live now?', '2026-11-17')).toBeNull();
    expect(slotHistoryDimension('In plain words, which job title does Alice Example hold at the moment?', '2026-11-17')).toBeNull();
    expect(slotHistoryDimension('What job titles does Alice Example hold now, after all those roles before?', '2026-11-17')).toBeNull();
    expect(slotHistoryDimension('What did Alice Example do before?', '2026-11-17')).toBeNull();
    expect(slotHistoryDimension("List Alice Example's job titles and employers over time.", '2026-11-17')).toBeNull();
    expect(slotHistoryDimension('Where does Alice Example work?', '2026-11-17')).toBeNull();
  });
});

for (const backend of testBackends()) {
  describe(backend, () => {
    let engine: BrainEngine;
    let sourceId: string;
    let otherSource: string;
    let close: (() => Promise<void>) | undefined;
    let dispose: (() => Promise<void>) | undefined;
    const ids: Record<string, number> = {};

    async function fact(key: string, text: string, entity: string, validFrom: string, slot: [string, string] | null,
      opts: { visibility?: 'world' | 'private'; page?: string; source?: string } = {}) {
      const [row] = await engine.executeRaw<{ id: number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from, source_markdown_slug, dimension, value, value_hash, dim_status)
         VALUES ($1, $2, $3, 'fact', $4, $5, 1, $6::timestamptz, $7, $8, $9, $10, $11) RETURNING id`,
        [opts.source ?? sourceId, entity, text, CONVERSATION, opts.visibility ?? 'world', validFrom + 'T00:00:00Z', opts.page ?? null,
          slot?.[0] ?? null, slot?.[1] ?? null, slot ? valueHash(slot[1]) : null, slot ? 'active' : null]);
      ids[key] = Number(row!.id);
    }

    const local = async (query: string, source = sourceId) =>
      (await handleToolCall(engine, 'query', { query, expand: false, use_cache: false, source_id: source, limit: 50, token_budget: 5500 }) as Row[])
        .filter(r => r.result_type === 'fact').map(r => r.chunk_text ?? '');
    const remote = async (query: string) => {
      __resetPrivateVisibilityCacheForTests();
      const auth = { token: 't', clientId: 'slot-history-remote', scopes: ['read'], sourceId, allowedSources: [sourceId] };
      const r = await dispatchToolCall(engine, 'query', { query, expand: false, use_cache: false, limit: 50, token_budget: 5500 },
        { remote: true, transport: 'stdio', sourceId, auth, config: { engine: engine.kind } as never, logger });
      return r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
    };
    const asMember = async (member: string, query: string) => {
      __resetPrivateVisibilityCacheForTests();
      const rows = await withCallerAccess({ identity: ['member:' + member] }, () => applyFactsBlock(engine, query, [],
        { sourceIds: [sourceId], remote: true, readScope: { sourceIds: [sourceId], excludePrivate: true }, budget: 5500, tokenBudget: 5500, rowCap: async () => 50 }));
      return (rows as Row[]).filter(r => r.result_type === 'fact').map(r => r.chunk_text ?? '');
    };
    const block = async (query: string, sourceIds: string[], budget = 5500, rowCap = 50, eng: BrainEngine = engine) =>
      ((await applyFactsBlock(eng, query, [], { sourceIds, remote: false, budget, tokenBudget: budget, rowCap: async () => rowCap })) as Row[])
        .filter(r => r.result_type === 'fact');
    const rowOf = (rows: string[], text: string) => rows.find(r => r.includes(text));
    const headOf = (rows: string[], text: string) => rowOf(rows, text)?.split('\n')[0];

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
      otherSource = await newSource(engine);
      await putPage(engine, sourceId, 'people/carol-example', page('person', 'Carol Example', 'Carol Example is in the address book.'));
      await putPage(engine, sourceId, 'people/erin-example', page('person', 'Erin Example', 'Erin Example is in the address book.', 'visibility: private\n'));
      await putPage(engine, sourceId, 'memory/members/alice-example', page('note', 'Memory of alice-example', 'Work notes.', 'readable_by: [alice-example]\n'));

      await fact('a_note', 'Alice Example keeps a plain words list of job titles held over time.', 'alice-example', '2020-01-01', null);
      await fact('a_intern', 'Alice Example started out as a junior intern.', 'alice-example', '2021-02-01', ['role', 'Intern']);
      await fact('a_acme', 'Alice Example joined Acme Example.', 'alice-example', '2021-02-01', ['employer', 'Acme Example']);
      await fact('a_analyst', 'Alice Example was promoted to analyst.', 'alice-example', '2022-03-01', ['role', 'Analyst']);
      await fact('a_manager', 'Alice Example became the team manager.', 'alice-example', '2024-05-01', ['role', 'Manager']);
      await fact('a_director', 'Alice Example became director.', 'alice-example', '2025-01-01', ['role', 'Director'], { visibility: 'private' });
      await fact('a_pilot', 'Alice Example flies as a pilot.', 'alice-example', '2023-01-01', ['role', 'Pilot'], { source: otherSource });
      await fact('aj_guard', 'Alice Example Jr started as a lifeguard.', 'alice-example-jr', '2022-06-01', ['role', 'Lifeguard']);

      await fact('c_cashier', 'Carol Example began as a cashier.', 'people/carol-example', '2020-01-01', ['role', 'Cashier']);
      await fact('c_lead', 'Carol Example moved up to store lead.', 'people/carol-example', '2022-01-01', ['role', 'Store Lead']);

      await fact('d_night', 'Dana Example worked the night desk.', 'dana-example', '2020-06-01', ['role', 'Night Clerk']);

      await fact('e_courier', 'Erin Example started as a courier.', 'people/erin-example', '2021-01-01', ['role', 'Courier']);

      await fact('g_engineer', 'Gwen Example joined as an engineer.', 'gwen-example', '2021-01-01', ['role', 'Engineer']);
      await fact('g_staff', 'Gwen Example became staff engineer.', 'gwen-example', '2023-01-01', ['role', 'Staff Engineer'],
        { visibility: 'private', page: 'memory/members/alice-example' });

      await fact('h_clerk', 'Hal Example works as a clerk.', 'hal-example', '2020-01-01', ['role', 'Clerk']);
      await fact('h_cook', 'Hal Example works as a cook.', 'hal-example', '2021-01-01', ['role', 'Cook']);
      await fact('h_baker', 'Hal Example works as a baker.', 'hal-example', '2022-01-01', ['role', 'Baker']);
      await fact('h_tailor', 'Hal Example works as a tailor.', 'hal-example', '2023-01-01', ['role', 'Tailor']);
      const forgot = await dispatchToolCall(engine, 'forget_fact', { id: ids.h_cook }, { remote: false, sourceId });
      expect(forgot.isError).toBeFalsy();
      await engine.executeRaw('UPDATE facts SET superseded_by = $2, expired_at = now() WHERE id = $1', [ids.h_baker, ids.h_clerk]);
      await engine.executeRaw('UPDATE facts SET expired_at = now() WHERE id = $1', [ids.h_tailor]);
    }, 300_000);
    afterAll(async () => { await close?.(); await dispose?.(); if (backend === 'pglite') await engine?.disconnect(); }, 60_000);

    describe('D1 unbacked-key matcher', () => {
      const scope = (sourceIds: string[]) => ({ sourceIds, worldOnly: false, excludePrivate: false });
      test('exactly one key whose words the question holds as a run', async () => {
        expect(await matchUnbackedKey(engine, ROLE_Q, scope([sourceId]))).toEqual({ source_id: sourceId, entity_slug: 'alice-example' });
        expect(await matchUnbackedKey(engine, "Alice Example Jr's job titles over time?", scope([sourceId]))).toEqual({ source_id: sourceId, entity_slug: 'alice-example-jr' });
      });
      test('two candidates, a single word, a page-backed slug or no key: none', async () => {
        expect(await matchUnbackedKey(engine, ROLE_Q, scope([sourceId, otherSource]))).toBeNull();
        expect(await matchUnbackedKey(engine, 'Job titles of Alice Example and Hal Example over time?', scope([sourceId]))).toBeNull();
        expect(await matchUnbackedKey(engine, 'Which job titles has Alice held over time?', scope([sourceId]))).toBeNull();
        expect(await matchUnbackedKey(engine, 'Which job titles has Carol Example held over time?', scope([sourceId]))).toBeNull();
        expect(await matchUnbackedKey(engine, 'Which job titles has Zed Example held over time?', scope([sourceId]))).toBeNull();
      });
    });

    describe('the arm in the facts block', () => {
      test('an unbacked key: every value of the dimension, oldest first, with its window', async () => {
        const rows = await local(ROLE_Q);
        const order = ['junior intern', 'promoted to analyst', 'team manager', 'became director'].map(t => rows.findIndex(r => r.includes(t)));
        expect(order.every(i => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(headOf(rows, 'junior intern')).toBe(head('2021-02-01', '2022-03-01'));
        expect(headOf(rows, 'promoted to analyst')).toBe(head('2022-03-01', '2024-05-01'));
        expect(headOf(rows, 'team manager')).toBe(head('2024-05-01', '2025-01-01'));
        expect(rows.join('\n')).not.toContain('Acme Example');
        expect(rows.join('\n')).not.toContain('pilot');
        expect(rows.join('\n')).not.toContain('lifeguard');
      });
      test('a current-value question gets no history', async () => {
        const text = (await local('In plain words, which job title does Alice Example hold at the moment?')).join('\n');
        expect(text).not.toContain('junior intern');
        expect(text).not.toContain('promoted to analyst');
      });
      test('the arm stays inside the block row count and token share', async () => {
        const budget = 1200;
        const rows = await block(ROLE_Q, [sourceId], budget, 2);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThanOrEqual(2);
        expect(rows.reduce((n, r) => n + resultTokens(r as never), 0)).toBeLessThanOrEqual(Math.floor(budget * QUERY_FACTS_BLOCK_SHARE));
      });
      test('a page-backed entity reads its own facts', async () => {
        const rows = await local('In plain words, which job titles has Carol Example held over time?');
        expect(headOf(rows, 'began as a cashier')).toBe(head('2020-01-01', '2022-01-01'));
        expect(headOf(rows, 'moved up to store lead')).toBe(head('2022-01-01'));
      });
      test('the same key in another source is another person', async () => {
        expect((await local(ROLE_Q)).join('\n')).not.toContain('pilot');
        const other = (await local(ROLE_Q, otherSource)).join('\n');
        expect(other).toContain('flies as a pilot');
        expect(other).not.toContain('junior intern');
        const both = (await block(ROLE_Q, [sourceId, otherSource])).map(r => r.chunk_text ?? '').join('\n');
        expect(both).not.toContain('pilot');
        expect(both).not.toContain('junior intern');
      });
      test('withdrawn, superseded and expired rows never show', async () => {
        const text = (await local('In plain words, which job titles has Hal Example held over time?')).join('\n');
        expect(text).toContain('works as a clerk');
        for (const gone of ['cook', 'baker', 'tailor']) expect(text).not.toContain(gone);
      });
      test('a page later written at people/<key> adopts the key, and its value ends the key stint', async () => {
        const Q = 'In plain words, which job titles has Dana Example held over time?';
        expect(headOf(await local(Q), 'night desk')).toBe(head('2020-06-01'));
        await putPage(engine, sourceId, 'people/dana-example', page('person', 'Dana Example', 'Dana Example is in the address book.'));
        await fact('d_head', 'Dana Example became the head of front office.', 'people/dana-example', '2023-06-01', ['role', 'Head of Front Office']);
        const rows = await local(Q);
        expect(headOf(rows, 'night desk')).toBe(head('2020-06-01', '2023-06-01'));
        expect(headOf(rows, 'head of front office')).toBe(head('2023-06-01'));
      });
    });

    describe('read policy', () => {
      test('a remote caller sees no private value, and a private row ends no window it sees', async () => {
        const text = await remote(ROLE_Q);
        expect(text).toContain(head('2021-02-01', '2022-03-01'));
        expect(text).toContain(head('2024-05-01'));
        expect(text).not.toContain('director');
        expect(text).not.toContain(head('2024-05-01', '2025-01-01'));
      });
      test('a remote caller gets no history of a page it cannot read', async () => {
        const Q = 'In plain words, which job titles has Erin Example held over time?';
        expect((await local(Q)).join('\n')).toContain('started as a courier');
        const text = await remote(Q);
        expect(text).not.toContain('courier');
        expect(text).not.toContain('people/erin-example');
      });
      test('a private page written later at a name key keeps the key rows from a remote caller', async () => {
        const Q = 'In plain words, which job titles has Hana Example held over time?';
        await fact('h_cook', 'Hana Example started as a line cook.', 'hana-example', '2021-01-01', ['role', 'Cook']);
        expect(await remote(Q)).toContain('line cook');
        await putPage(engine, sourceId, 'people/hana-example', page('person', 'Hana Example', 'Hana Example is in the address book.', 'visibility: private\n'));
        expect((await local(Q)).join('\n')).toContain('line cook');
        expect(await remote(Q)).not.toContain('line cook');
      });
      test('a private page written later at orgs/<key> keeps the key rows from a remote caller', async () => {
        const Q = 'In plain words, which job titles has Kai Example held over time?';
        await fact('k_cook', 'Kai Example started as a line cook.', 'kai-example', '2021-01-01', ['role', 'Cook']);
        expect(await remote(Q)).toContain('line cook');
        await putPage(engine, sourceId, 'orgs/kai-example', page('company', 'Kai Example', 'Kai Example is in the address book.', 'visibility: private\n'));
        expect((await local(Q)).join('\n')).toContain('line cook');
        expect(await remote(Q)).not.toContain('line cook');
      });
      test('a non-Latin name key matches its history question', async () => {
        await fact('i_cook', 'Иван Петров started as a line cook.', 'иван-петров', '2021-01-01', ['role', 'Cook']);
        await fact('i_chef', 'Иван Петров became head chef.', 'иван-петров', '2023-01-01', ['role', 'Head Chef']);
        const text = (await local('In plain words, which job titles has Иван Петров held over time?')).join('\n');
        expect(text).toContain('started as a line cook');
        expect(text).toContain('became head chef');
      });
      test('a member-scoped caller sees a value on its own page; another member sees neither it nor its end', async () => {
        const Q = 'In plain words, which job titles has Gwen Example held over time?';
        const alice = await asMember('alice-example', Q);
        expect(headOf(alice, 'joined as an engineer')).toBe(head('2021-01-01', '2023-01-01'));
        expect(rowOf(alice, 'became staff engineer')).toBeDefined();
        const bob = await asMember('bob-example', Q);
        expect(headOf(bob, 'joined as an engineer')).toBe(head('2021-01-01'));
        expect(bob.join('\n')).not.toContain('staff engineer');
      });
    });

    describe('H1 a failed history read', () => {
      const failing = (base: BrainEngine) => rejecting(base, HISTORY_READ, () => new Error('history read failed'));
      test('keeps the block and marks its rows', async () => {
        const rows = await block(ROLE_Q, [sourceId], 5500, 50, failing(engine));
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.map(r => r.chunk_text).join('\n')).not.toContain('junior intern');
        expect(rows.every(r => r.fact_row?.history_unavailable)).toBe(true);
        expect((await block(ROLE_Q, [sourceId])).some(r => r.fact_row?.history_unavailable)).toBe(false);
      });
      test('query reports the degraded stage facts_history_unavailable', async () => {
        const call = async () => {
          const r = await dispatchToolCall(engine, 'query', { query: ROLE_Q, expand: false, use_cache: false, source_id: sourceId, limit: 50, token_budget: 5500 },
            { remote: false, transport: 'stdio', sourceId, config: { engine: engine.kind } as never, logger });
          return JSON.stringify(r._meta ?? {});
        };
        expect(await call()).not.toContain('facts_history_unavailable');
        const original = engine[HISTORY_READ];
        engine[HISTORY_READ] = () => Promise.reject(new Error('history read failed'));
        try {
          expect(await call()).toContain('facts_history_unavailable');
        } finally { engine[HISTORY_READ] = original; }
      }, 60_000);
    });

    describe('an engine capability refusal stops the block', () => {
      test('a refused quoted-page read rejects with the typed refusal, never an empty block', async () => {
        await expect(block(ROLE_Q, [sourceId], 5500, 50, rejecting(engine, QUOTED_READ, refused(QUOTED_READ))))
          .rejects.toMatchObject({ code: 'engine_capability_missing' });
      });
      test('a refused history read rejects, never a block marked history_unavailable', async () => {
        await expect(block(ROLE_Q, [sourceId], 5500, 50, rejecting(engine, HISTORY_READ, refused(HISTORY_READ))))
          .rejects.toMatchObject({ code: 'engine_capability_missing' });
      });
    });
  });
}

/**
 * The Rust arm (GBRAIN_TEST_RUST_ARM=1, test/engine-parity/rust-arm.ts): the same block on a Rust brain, seeded through
 * the typed members (`insertFacts`, `putPage`) because the store refuses raw SQL. Before the quote and bare-name page
 * reads were typed members, both ran through `executeRaw`: the block returned no rows and every history read failed.
 */
describe.if(rustArmRequested())('rust', () => {
  let engine: BrainEngine;
  let dir = '';
  const SRC = 'src-a';
  const OTHER = 'src-b';
  const rustFact = (fact: string, entity: string, from: string, slot: [string, string] | null) => ({
    fact, entity_slug: entity, kind: 'fact', visibility: 'world', source: CONVERSATION, confidence: 1, valid_from: new Date(from + 'T00:00:00Z'),
    ...(slot ? { dimension: slot[0], value: slot[1], value_hash: valueHash(slot[1]), dim_status: 'active' } : {}),
  });
  const block = async (query: string, sourceIds: string[], eng: BrainEngine = engine) =>
    ((await applyFactsBlock(eng, query, [], { sourceIds, remote: false, budget: 5500, tokenBudget: 5500, rowCap: async () => 50 })) as Row[])
      .filter(r => r.result_type === 'fact');
  const texts = (rows: Row[]) => rows.map(r => r.chunk_text ?? '');
  const headOf = (rows: string[], text: string) => rows.find(r => r.includes(text))?.split('\n')[0];

  beforeAll(async () => {
    ({ engine, dir } = await openRustBrain());
    await createRustSource(engine, SRC, {});
    await createRustSource(engine, OTHER, {});
    await engine.putPage('people/carol-example', { type: 'person', title: 'Carol Example', compiled_truth: 'Carol Example is in the address book.' }, { sourceId: SRC });
    await engine.insertFacts([
      rustFact('Alice Example keeps a plain words list of job titles held over time.', 'alice-example', '2020-01-01', null),
      rustFact('Alice Example started out as a junior intern.', 'alice-example', '2021-02-01', ['role', 'Intern']),
      rustFact('Alice Example joined Acme Example.', 'alice-example', '2021-02-01', ['employer', 'Acme Example']),
      rustFact('Alice Example was promoted to analyst.', 'alice-example', '2022-03-01', ['role', 'Analyst']),
      rustFact('Alice Example became the team manager.', 'alice-example', '2024-05-01', ['role', 'Manager']),
      rustFact('Carol Example began as a cashier.', 'people/carol-example', '2020-01-01', ['role', 'Cashier']),
      rustFact('Carol Example moved up to store lead.', 'people/carol-example', '2022-01-01', ['role', 'Store Lead']),
    ] as never, { source_id: SRC });
    await engine.insertFacts([rustFact('Alice Example flies as a pilot.', 'alice-example', '2023-01-01', ['role', 'Pilot'])] as never, { source_id: OTHER });
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); if (dir) removeBrainDir(dir); });

  test('an unbacked key: every value of the dimension, oldest first, with its window', async () => {
    const rows = texts(await block(ROLE_Q, [SRC]));
    const order = ['junior intern', 'promoted to analyst', 'team manager'].map(t => rows.findIndex(r => r.includes(t)));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(headOf(rows, 'junior intern')).toBe(head('2021-02-01', '2022-03-01'));
    expect(headOf(rows, 'promoted to analyst')).toBe(head('2022-03-01', '2024-05-01'));
    expect(headOf(rows, 'team manager')).toBe(head('2024-05-01'));
    expect(rows.join('\n')).not.toContain('pilot');
  });
  // The store does not serve the `entity_ended` arm of listFactsForRelevance yet (it reads the withdrawal ledger;
  // store-members/facts-trust.ts), so a history question about a page-backed entity stops on that typed refusal. Before
  // facts-arm.ts rethrew refusals, this block returned no rows and no error. When the arm is served, this case takes
  // the PGLite expectation (began as a cashier 2020-01-01 to 2022-01-01, store lead from 2022-01-01).
  test('a page-backed entity stops on the typed refusal of the unserved entity_ended arm', async () => {
    await expect(block('In plain words, which job titles has Carol Example held over time?', [SRC]))
      .rejects.toMatchObject({ code: 'engine_capability_missing', detail: expect.stringContaining('member=listFactsForRelevance (the history arm') });
  });
  test('the same key in another source is another person', async () => {
    const other = texts(await block(ROLE_Q, [OTHER])).join('\n');
    expect(other).toContain('flies as a pilot');
    expect(other).not.toContain('junior intern');
  });
  test('a failed history read keeps the block and marks its rows', async () => {
    const rows = await block(ROLE_Q, [SRC], rejecting(engine, HISTORY_READ, () => new Error('history read failed')));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.fact_row?.history_unavailable)).toBe(true);
    expect((await block(ROLE_Q, [SRC])).some(r => r.fact_row?.history_unavailable)).toBe(false);
  });
  test('a refused quoted-page or history read rejects with the typed refusal', async () => {
    for (const member of [QUOTED_READ, HISTORY_READ]) {
      await expect(block(ROLE_Q, [SRC], rejecting(engine, member, refused(member)))).rejects.toMatchObject({ code: 'engine_capability_missing' });
    }
  });
});
