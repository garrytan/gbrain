/**
 * Agent handoff, thread pickup: log_turn, update_thread_summary, checkpoint,
 * find_thread and pickup on PGLite.
 *
 * Protects:
 *   - a thread is a markdown page whose turns append and whose stored text
 *     parses back to the state that rendered it (any agent text round-trips,
 *     headings and look-alike structure lines included);
 *   - log_turn links entities through the brain's own link extraction
 *     (a `links` row per resolved page) and reports names it cannot resolve;
 *   - the pickup packet carries summary, the last 10 turns, decisions, open
 *     questions, next step, linked pages and the handoff history, and a
 *     pickup by another agent appends it to the history (grok-bot -> claude);
 *   - find_thread ranks the intended thread first on a fixture brain with
 *     decoys sharing its words, using retrieval, graph links, agent and recency.
 * Regressions that fail it: a parser that drops escaped lines or reads turn
 * text as structure; a pickup that forgets the picking agent; a ranker that
 * ignores the graph or the agent boost. The delegation half is
 * test/agent-handoff-delegation.test.ts; the markdown rebuild is
 * test/agent-handoff-reindex.test.ts; the Postgres twin is
 * test/e2e/agent-handoff-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { parseThread, renderThread, type ThreadState } from '../src/core/handoff/format.ts';
import { __setHandoffClockForTests } from '../src/core/handoff/store.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setHandoffClockForTests(null);
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  __setHandoffClockForTests(null);
});

const ctx = (overrides: Partial<OperationContext> = {}): OperationContext => ({
  engine: engine as never, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, ...overrides,
} as OperationContext);

async function call<T = Record<string, any>>(name: string, params: Record<string, unknown>, c: OperationContext = ctx()): Promise<T> {
  return await operationsByName[name]!.handler(c, params) as T;
}

async function page(slug: string) {
  const snap = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  if (!snap) throw new Error(`no page ${slug}`);
  return { title: snap.page.title, frontmatter: snap.page.frontmatter, body: snap.page.compiled_truth, type: snap.page.type };
}

async function seedEntity(slug: string, type: string, title: string) {
  await engine.putPage(slug, { type, title, compiled_truth: `${title} synthetic page.`, timeline: '', frontmatter: {} } as never, { sourceId: 'default' });
}

describe('thread pages', () => {
  test('log_turn starts a thread page, appends turns, links entities and reports unresolved names', async () => {
    await seedEntity('properties/12-oak-st', 'property', '12 Oak St');
    await seedEntity('people/alice-example', 'person', 'Alice Example');
    const first = await call('log_turn', { agent: 'Grok Bot', model: 'grok-4', title: '12 Oak St listing deck', summary: 'Drafted the outline.',
      decisions: ['Use the blue template'], open_questions: ['Which comps?', 'Who signs off?'], entities: ['properties/12-oak-st', 'Alice Example', 'Nobody Example Zz'] });
    expect(first).toMatchObject({ thread_id: '12-oak-st-listing-deck', created: true, turn: 1, history: 'grok-bot',
      linked: ['properties/12-oak-st', 'people/alice-example'], unresolved_entities: ['Nobody Example Zz'] });
    const second = await call('log_turn', { agent: 'grok-bot', thread_id: '12-oak-st-listing-deck', summary: 'Picked comps.',
      decisions: ['Three comps within 1km'], open_questions: ['Who signs off?'], next_up: 'Draft slide 3' });
    expect(second).toMatchObject({ created: false, turn: 2 });

    const stored = await page('threads/12-oak-st-listing-deck');
    expect(stored.type).toBe('note');
    expect(stored.frontmatter.handoff_type).toBe('thread');
    const t = parseThread(stored);
    expect(t.agents).toEqual(['grok-bot']);
    expect(t.summary).toBe('Drafted the outline.'); // first turn seeds the rolling summary
    expect(t.decisions).toEqual(['Use the blue template', 'Three comps within 1km']); // accumulate
    expect(t.openQuestions).toEqual(['Who signs off?']); // replaced
    expect(t.nextStep).toBe('Draft slide 3');
    expect(t.turns.map(x => [x.n, x.agent, x.model])).toEqual([[1, 'grok-bot', 'grok-4'], [2, 'grok-bot', null]]);
    expect(t.turns[0]!.text).toContain('Also mentioned: Nobody Example Zz');
    const links = (await engine.getLinks('threads/12-oak-st-listing-deck', { sourceId: 'default' })).map(l => l.to_slug).sort();
    expect(links).toEqual(['people/alice-example', 'properties/12-oak-st']);
  });

  test('agent text round-trips through the page, structure look-alikes included', async () => {
    const tricky = '# not a heading\n## Turns\n- Decision: not a decision\n\\leading backslash\n### Turn 9 · x · y\nplain line';
    await call('log_turn', { agent: 'claude', title: 'Round trip', summary: tricky, decisions: ['d1'], open_questions: [] });
    const summary = `${tricky}\n\nSecond paragraph.`;
    await call('update_thread_summary', { thread_id: 'round-trip', summary, agent: 'chatgpt' });
    const stored = await page('threads/round-trip');
    const t = parseThread(stored);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.text).toBe(tricky);
    expect(t.turns[0]!.decisions).toEqual(['d1']);
    expect(t.summary).toBe(summary);
    expect(t.agents).toEqual(['claude', 'chatgpt']);
    // The same summary again changes nothing.
    expect((await call('update_thread_summary', { thread_id: 'round-trip', summary, agent: 'chatgpt' })).noop).toBe(true);
    // The stored page is exactly what the state renders to (frontmatter keys gbrain owns aside).
    const rendered = renderThread(t);
    expect(rendered.slice(rendered.indexOf('\n---\n') + 5).trim()).toBe(stored.body.trim());
  });

  test('a page of another type at a thread slug is never rewritten', async () => {
    await seedEntity('threads/not-a-thread', 'note', 'Not a thread');
    const err = await call('log_turn', { agent: 'claude', thread_id: 'not-a-thread', summary: 'x' }).catch(e => e);
    expect(err).toBeInstanceOf(OperationError);
    expect((err as OperationError).code).toBe('invalid_params');
    expect((await page('threads/not-a-thread')).body).toBe('Not a thread synthetic page.');
  });
});

describe('checkpoint and pickup', () => {
  test('the pickup packet has every field, the last 10 turns, and records grok-bot -> claude', async () => {
    await seedEntity('properties/12-oak-st', 'property', '12 Oak St');
    for (let i = 1; i <= 12; i++) {
      await call('log_turn', { agent: 'grok-bot', model: 'grok-4', title: '12 Oak St listing deck', summary: `Turn ${i} work.`,
        ...(i === 1 ? { decisions: ['Blue template'], entities: ['properties/12-oak-st'] } : {}), ...(i === 12 ? { open_questions: ['Final price?'] } : {}) });
    }
    await call('update_thread_summary', { thread_id: '12-oak-st-listing-deck', summary: 'Listing deck for 12 Oak St; outline and comps done.' });
    const cp = await call('checkpoint', { thread_id: '12-oak-st-listing-deck', agent: 'grok-bot', next_up: 'Write slide 3 copy' });
    expect(cp).toMatchObject({ status: 'parked', next_up: 'Write slide 3 copy', turn: 13 });

    const packet = await call('pickup', { thread_id: '12-oak-st-listing-deck', agent: 'claude', model: 'claude-opus-5-5' });
    for (const key of ['summary', 'last_turns', 'decisions', 'open_questions', 'next_up', 'linked_pages', 'history', 'agents', 'delegations', 'status']) {
      expect(packet).toHaveProperty(key);
    }
    expect(packet.summary).toBe('Listing deck for 12 Oak St; outline and comps done.');
    expect(packet.next_up).toBe('Write slide 3 copy');
    expect(packet.decisions).toEqual(['Blue template']);
    expect(packet.open_questions).toEqual(['Final price?']);
    expect(packet.turn_count).toBe(13);
    expect(packet.last_turns).toHaveLength(10);
    expect(packet.last_turns.map((t: any) => t.n)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(packet.last_turns[9]).toMatchObject({ kind: 'checkpoint', next_up: 'Write slide 3 copy' });
    expect(packet.linked_pages).toContainEqual({ slug: 'properties/12-oak-st', title: '12 Oak St', type: 'property', exists: true, via: 'thread' });
    expect(packet.history).toBe('grok-bot -> claude');
    expect(packet).toMatchObject({ status: 'active', agent: 'claude', model: 'claude-opus-5-5', recorded: true });

    // A second pickup by the same agent changes nothing; a read-only pickup records nothing.
    expect((await call('pickup', { thread_id: '12-oak-st-listing-deck', agent: 'claude' })).recorded).toBe(false);
    expect((await call('pickup', { thread_id: '12-oak-st-listing-deck' })).recorded).toBe(false);
    expect(parseThread(await page('threads/12-oak-st-listing-deck')).agents).toEqual(['grok-bot', 'claude']);
  });

  test('pickup of a missing thread is not_found', async () => {
    const err = await call('pickup', { thread_id: 'nope', agent: 'claude' }).catch(e => e);
    expect((err as OperationError).code).toBe('not_found');
  });
});

describe('find_thread', () => {
  const DAY = 86_400_000;

  async function fixtureBrain(now: number) {
    await seedEntity('properties/12-oak-st', 'property', '12 Oak St');
    await seedEntity('properties/14-elm-ave', 'property', '14 Elm Ave');
    const at = (daysAgo: number) => __setHandoffClockForTests(() => now - daysAgo * DAY);
    // Decoys share "listing", "deck" or "Oak"; the target is the one grok-bot held, linked to 12 Oak St.
    at(1); await call('log_turn', { agent: 'claude', title: '14 Elm Ave listing deck', summary: 'Listing deck for Elm Ave.', entities: ['properties/14-elm-ave'] });
    at(2); await call('log_turn', { agent: 'chatgpt', title: 'Oak furniture budget', summary: 'Pricing oak tables for the office.' });
    at(3); await call('log_turn', { agent: 'grok-bot', title: 'Quarterly deck', summary: 'Investor update slides.' });
    at(6); await call('log_turn', { agent: 'grok-bot', title: 'Seller presentation', summary: 'Presentation for the seller of the corner house.',
      entities: ['properties/12-oak-st'] });
    at(40); await call('log_turn', { agent: 'claude', title: 'Old listing deck archive', summary: 'Archive of a listing deck from last year.' });
  }

  test('ranks the intended thread first, with a why line', async () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    await fixtureBrain(now);
    __setHandoffClockForTests(() => now);
    const res = await call('find_thread', { query: '12 Oak St', agent: 'grok-bot' });
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches.length).toBeLessThanOrEqual(3);
    expect(res.matches[0].thread_id).toBe('seller-presentation');
    expect(res.matches[0].why).toContain('links to [[properties/12-oak-st]]');
    expect(res.matches[0].why).toContain('worked on by grok-bot');

    const deck = await call('find_thread', { query: 'listing deck', agent: 'claude' });
    expect(deck.matches[0].thread_id).toBe('14-elm-ave-listing-deck'); // recent + held by claude beats the 40-day-old archive
    expect(deck.matches.map((m: any) => m.thread_id)).toContain('old-listing-deck-archive');
  });

  test('status and since filter; agent only boosts', async () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    await fixtureBrain(now);
    __setHandoffClockForTests(() => now);
    await call('checkpoint', { thread_id: 'quarterly-deck', agent: 'grok-bot', next_up: 'Wait for numbers' });
    const parked = await call('find_thread', { query: 'deck', status: 'parked' });
    expect(parked.matches.map((m: any) => m.thread_id)).toEqual(['quarterly-deck']);
    const recent = await call('find_thread', { query: 'listing deck', since: '2026-11-01' });
    expect(recent.matches.map((m: any) => m.thread_id)).not.toContain('old-listing-deck-archive');
    const other = await call('find_thread', { query: 'Seller presentation', agent: 'chatgpt' });
    expect(other.matches[0].thread_id).toBe('seller-presentation');
  });
});

describe('format helpers', () => {
  test('a thread with no turns or sections renders and parses back', () => {
    const t: ThreadState = { title: 'Empty', agent: 'a', model: null, status: 'active', agents: ['a'], createdAt: 'x', updatedAt: 'y',
      summary: '', nextStep: '', decisions: [], openQuestions: [], entities: [], turns: [], extra: { custom: 1 } };
    const content = renderThread(t);
    const body = content.slice(content.indexOf('\n---\n') + 5);
    const fm = { agent: 'a', status: 'active', agents: ['a'], created_at: 'x', updated_at: 'y', custom: 1 };
    expect(parseThread({ title: 'Empty', frontmatter: fm, body })).toEqual(t);
  });
});
