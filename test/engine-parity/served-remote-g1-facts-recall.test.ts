/**
 * BrainEngine parity: the fact-pool reads a remote recall, search and query make, over the served wire: the recall entity
 * namesake check (listPoolEntityPairs), the slot-history arm of a query (listPoolUnbackedKeys, listReadablePageSlugs), the saved
 * facts correction match of a search (matchHeadStems) and the typed claim marks of a facts block (listTypedClaimFactsAtPages).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded or served) a remote caller (MCP stdio,
 *    dispatchToolCall with remote: true) gets the same answer, and the answer carries no fact it may not read: a private fact,
 *    and a fact held on an owner-private page, each with its own marker.
 *    - recall with an entity and a question reads the pool's entity pairs under the caller's read policy.
 *    - a query that asks which values of one slot an entity held names that entity from the pool's unbacked name keys (no page)
 *      (or its readable page), and lists every readable value, never a private one.
 *    - a search whose words match a saved fact and a later correction labels the older fact corrected.
 *  - Regression: on the served arm each member was refused for a remote caller (not on OWNER_IPC_REMOTE_TYPED_READS), so the
 *    remote recall, query or search failed with a typed engine_capability_missing refusal or lost the block.
 *  - Why existing coverage misses it: recall-members.test.ts and hidden-refusals.test.ts call the pool functions with a hand-built
 *    scope on the arm's own engine; no parity file ran the remote operation that sends them over the served wire.
 *  - Seam: none. Pages and facts are written with putPage and insertFacts; each case runs the real operation.
 */
import { expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { NoticeLedger } from '../../src/core/notice-ledger.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const stdio = () => ({ remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default', noticeLedger: new NoticeLedger() }) as never;
const SRC = 'default';
const CONVERSATION = 'cli:extract-conversation-facts:v1';
const day = (n: number) => new Date(Date.UTC(2026, 4, n));
const page = (title: string, frontmatter: Record<string, unknown> = {}) => ({ type: 'note' as const, title, compiled_truth: `${title}.`, timeline: '', frontmatter });

async function ask(engine: BrainEngine, op: string, params: Record<string, unknown>) {
  const out = await dispatchToolCall(engine, op, params, stdio());
  const text = out.content.map(c => c.text ?? '').join('\n');
  return { error: out.isError === true ? text.slice(0, 400) : false, text, blocks: out.content.map(c => c.text ?? '') };
}

parityTest('a remote query for the values of one slot lists the readable ones of an unbacked name key, never a private one', {
  methods: ['putPage', 'insertFacts', 'listPoolUnbackedKeys', 'listReadablePageSlugs'], timeout: 240_000,
}, async (engine: BrainEngine) => {
  await engine.putPage('notes/slotmarkprivatepage', page('Hidden holder', { visibility: 'private' }));
  const slot = (entity: string, fact: string, n: number, role: string, extra: Record<string, unknown> = {}) => ({
    fact, kind: 'fact', entity_slug: entity, visibility: 'world', source: CONVERSATION, source_session: 'slot-session', row_num: n,
    dimension: 'role', value: role, valid_from: day(n), ...extra,
  });
  await engine.insertFacts([
    slot('alice-example', 'Alice Example started out as a junior intern.', 1, 'Intern'),
    slot('alice-example', 'Alice Example was promoted to analyst.', 2, 'Analyst'),
    slot('alice-example', 'Alice Example became the team manager.', 3, 'Manager'),
    slot('alice-example', 'Alice Example became slotmarkprivatefact director.', 4, 'Director', { visibility: 'private' }),
        slot('slotmark-hiddenperson', 'Slotmark Hiddenperson worked a night shift.', 7, 'Night Clerk', { source_markdown_slug: 'notes/slotmarkprivatepage' }),
  ] as never, { source_id: SRC });
  const roles = async (question: string) => {
    const out = await ask(engine, 'query', { query: question, expand: false, use_cache: false, limit: 50, token_budget: 5500 });
    expect(out.error).toBe(false);
    return out.text;
  };
  const alice = await roles('In plain words, which job titles has Alice Example held over time?');
  const hidden = await roles('In plain words, which job titles has Slotmark Hiddenperson held over time?');
  expect(alice).toContain('junior intern');
  expect(alice).toContain('team manager');
  for (const text of [alice, hidden]) {
    expect(text).not.toContain('slotmarkprivatefact');
    expect(text).not.toContain('Night Clerk');
    expect(text).not.toContain('night shift');
  }
  const has = (text: string, needle: string) => text.includes(needle);
  return {
    alice: ['junior intern', 'promoted to analyst', 'team manager', 'director'].map(n => has(alice, n)),
    hidden: has(hidden, 'night'),
  };
});

parityTest('a remote search matches the name heads of a saved fact by stem, so a correction about another name corrects nothing, and shows no private fact', {
  methods: ['insertFact', 'matchSavedFacts', 'matchHeadStems'], timeout: 240_000,
}, async (engine: BrainEngine) => {
  const remember = async (fact: string, n: number, visibility: 'world' | 'private' = 'world') =>
    engine.insertFact({ fact, source: 'mcp:remember', entity_slug: null, visibility, valid_from: day(n) }, { source_id: SRC });
  await remember('Widget revenue quarterly is 50000', 1);
  await remember('correction: revenue quarterly is 60000', 2);
  await remember('Widget revenue quarterly is 70000 savedmarkprivate', 3, 'private');
  const out = await ask(engine, 'search', { query: 'widgets revenue quarterly' });
  expect(out.error).toBe(false);
  expect(out.text).not.toContain('savedmarkprivate');
  const saved = out.blocks.find(b => b.startsWith('Saved facts')) ?? '';
  // The correction shares two query words with the older fact but not the name Widget (matched by stem), so it corrects nothing.
  expect(saved).toContain('Widget revenue quarterly is 50000');
  expect(saved).not.toContain('corrected_by');
  return { saved: saved.replace(/\s+/g, ' ').replace(/excerpt from fact \d+;/g, 'excerpt from fact N;') };
});

parityTest('a remote recall naming an entity checks the entity pairs of the readable pool only and shows no private fact', {
  methods: ['putPage', 'insertFacts', 'listPoolEntityPairs'], timeout: 240_000,
}, async (engine: BrainEngine) => {
  await engine.putPage('notes/recallmarkprivatepage', page('Hidden holder', { visibility: 'private' }));
  await engine.putPage('people/recall-open', page('Recall Open'));
  await engine.putPage('people/recall-hidden', page('Recall Hidden'));
  const row = (entity: string, fact: string, n: number, extra: Record<string, unknown> = {}) => ({
    fact, kind: 'fact', entity_slug: entity, visibility: 'world', source: CONVERSATION, source_session: 'recall-session', row_num: n,
    valid_from: day(n), ...extra,
  });
  await engine.insertFacts([
    row('people/recall-open', 'Recall Open signed the harbor lease.', 1),
    row('people/recall-hidden', 'Recall Hidden signed recallmarkprivatefact.', 2, { source_markdown_slug: 'notes/recallmarkprivatepage' }),
  ] as never, { source_id: SRC });
  const open = await ask(engine, 'recall', { entity: 'people/recall-open', question: 'who signed the harbor lease' });
  const hidden = await ask(engine, 'recall', { entity: 'people/recall-hidden', question: 'who signed' });
  expect(open.error).toBe(false);
  expect(hidden.error).toBe(false);
  expect(open.text).toContain('harbor lease');
  expect(`${open.text}\n${hidden.text}`).not.toContain('recallmarkprivatefact');
  return { open: open.text.includes('harbor lease'), hidden: hidden.text.includes('signed') };
});

parityTest('a remote query that matches a typed claim reads the claims held on its pages and names no private claim', {
  methods: ['insertFacts', 'listTypedClaimFactsAtPages', 'readAdmittedPageDateFields'], timeout: 240_000,
}, async (engine: BrainEngine) => {
  const ENTITY = 'people/claim-example';
  const body = 'Claimmark reported the harbor ledger revenue for 2025.';
  for (const [slug, type, title] of [[ENTITY, 'person', 'Claim Example'], ['meetings/claim-old', 'meeting', 'Harbor revenue review'], ['notes/claim-new', 'note', 'Harbor revenue update']] as const) {
    await seedPage(engine, { slug, input: { type, title, compiled_truth: slug === ENTITY ? 'Claim Example runs the harbor ledger.' : body, timeline: '' }, chunks: [chunk(0, slug === ENTITY ? 'Claim Example runs the harbor ledger.' : body)] });
  }
  const claim = (fact: string, page: string, value: number, when: string, extra: Record<string, unknown> = {}) => ({
    fact, entity_slug: ENTITY, source_markdown_slug: page, row_num: 1, kind: 'fact', visibility: 'world', source: 'fence',
    claim_metric: 'revenue', claim_value: value, claim_unit: 'usd', claim_period: '2025', valid_from: new Date(when), ...extra,
  });
  await engine.insertFacts([claim('Claim Example harbor ledger revenue was 10 in 2025.', 'meetings/claim-old', 10, '2025-06-01T00:00:00Z')] as never, { source_id: SRC });
  await engine.insertFacts([claim('Claim Example harbor ledger revenue restated figure was 20 in 2025.', 'notes/claim-new', 20, '2025-09-01T00:00:00Z')] as never, { source_id: SRC });
  await engine.insertFacts([claim('Claim Example harbor ledger revenue was 30 claimmarkprivate in 2025.', 'notes/claim-new', 30, '2025-10-01T00:00:00Z', { visibility: 'private', row_num: 2 })] as never, { source_id: SRC });
  const out = await ask(engine, 'query', { query: 'harbor ledger revenue restated figure', expand: false, use_cache: false, limit: 20, token_budget: 5500 });
  expect(out.error).toBe(false);
  expect(out.text).not.toContain('claimmarkprivate');
  const rows = JSON.parse(out.blocks.find(b => b.startsWith('[')) ?? '[]') as Array<{ slug?: string; result_type?: string; chunk_text?: string }>;
  // The member returns every typed claim held on the pages, the private one included; only a matched (readable) fact can stamp a page,
  // and the stamp is not on the remote wire, so nothing of the private claim leaves.
  const facts = rows.filter(r => r.result_type === 'fact').map(r => (r.chunk_text ?? '').replace(/\s+/g, ' ').replace(/excerpt from fact \d+;/g, 'excerpt from fact N;').slice(0, 200));
  expect(facts.some(f => f.includes('restated figure was 20'))).toBe(true);
  return { pages: rows.filter(r => r.slug).map(r => r.slug).sort(), facts };
});
