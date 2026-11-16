/**
 * GBRA-574 wave A: dated facts reach the reader of a time-indexed question. PGLite, keyless, no network.
 *
 * Fixture shape mirrors what extract-conversation-facts writes for a chat history: one conversation page per
 * session (frontmatter date = when it was said, about 400 tokens each), one fact row per extracted claim, source
 * cli:extract-conversation-facts:..., source_markdown_slug = the session page, valid_from = the event date the
 * extractor stated, else the session date. Retrieval is query with limit 50 and token_budget 5,500: the facts
 * block on (default), no date headers on page blocks (default).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { collectFactCandidates, scoreFactCandidates } from '../src/core/search/fact-relevance.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';

type Row = { result_type?: string; chunk_text?: string; slug?: string };
const SRC = 'cli:extract-conversation-facts:v1';
const ENTITY = 'people/alice-example';
let engine: PGLiteEngine;
let sourceId: string;

const day = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 3 * 86_400_000).toISOString().slice(0, 10);
const session = (i: number) => 'conversations/chat-' + String(i).padStart(3, '0');
const FILLER = (i: number) => Array.from({ length: 22 }, (_, k) => 'Agenda item ' + (k + 1) + ' of meeting ' + i
  + ' covered budget forecasts, vendor timelines, quarterly hiring plans and the office move checklist.').join(' ');

async function fact(text: string, sessionIdx: number, validFrom = day(sessionIdx), entity = ENTITY) {
  await engine.executeRaw(
    "INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from, source_markdown_slug) VALUES ($1, $2, $3, 'event', $4, 'world', 1, $5::timestamptz, $6)",
    [sourceId, entity, text, SRC, validFrom + 'T00:00:00Z', session(sessionIdx)]);
}

const ask = async (query: string) =>
  await handleToolCall(engine, 'query', { query, expand: false, use_cache: false, source_id: sourceId, limit: 50, token_budget: 5500 }) as Row[];
const context = (rows: Row[]) => rows.map(r => r.chunk_text ?? '').join('\n---\n');

const CITIES: Array<[string, number, string]> = [
  ['Lisbon', 5, 'Alice Example just signed a lease on a flat in Lisbon.'],
  ['Porto', 30, 'Alice Example relocated to Porto for the new studio.'],
  ['Bergen', 70, 'Alice Example packed up again; her new place is in Bergen.'],
  ['Oslo', 110, 'Alice Example lives in Oslo after another move.'],
];
const S8Q = 'In order from earliest, where has Alice Example lived?';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  await putPage(engine, sourceId, ENTITY, page('person', 'Alice Example', 'Alice Example is a designer.'));
  const said: Record<number, string> = Object.fromEntries(CITIES.map(([, i, s]) => [i, s]));
  said[10] = 'Bob Example works at Beta Corp as a designer.';
  said[60] = 'I just found out Bob Example left Beta Corp back in February and joined Gamma Labs.';
  for (let i = 1; i <= 120; i++) {
    const body = said[i] ?? (i >= 40 ? 'We caught up with Alice Example about the design review for release ' + i + '.' : 'Weekly planning, session ' + i + '.');
    await putPage(engine, sourceId, session(i), page('conversation', 'Chat ' + i, '**User:** ' + body + ' ' + FILLER(i) + '\n\n**Assistant:** Noted.', 'date: ' + day(i) + '\n'));
  }
  for (const [city, i] of CITIES) await fact('Alice Example lives in ' + city + '.', i);
  for (let i = 111; i <= 120; i++) await fact('Alice Example still lives in Oslo.', i);
  for (let i = 40; i <= 120; i += 2) await fact('Alice Example led the design review for release ' + i + '.', i);
  await putPage(engine, sourceId, 'people/bob-example', page('person', 'Bob Example', 'Bob Example is an engineer.'));
  await fact('Bob Example works at Beta Corp.', 10, day(10), 'people/bob-example');
  await fact('Bob Example left Beta Corp and joined Gamma Labs.', 60, '2025-02-15', 'people/bob-example');
  await fact('Dana Example had been promoted in 2025.', 80, day(80), 'people/dana-example');
  for (const [slug, name] of [['people/sam-roger', 'Sam Roger'], ['people/sam-rogers', 'Sam Rogers']]) await putPage(engine, sourceId, slug, page('person', name, name + ' is a client.'));
  await fact('Sam Roger lives in Porto.', 20, day(20), 'people/sam-roger');
  await fact('Sam Rogers lives in Lisbon.', 21, day(21), 'people/sam-rogers');
  await fact('Carol Example moved to Madrid.', 7, '2020-01-01', 'people/carol-example');
  await fact('Carol Example moved to Madrid.', 9, '2019-01-01', 'people/carol-example');
  await fact("Kim O'Brien plays the cello.", 23, day(23), 'people/kim-obrien');
  await fact("Lee O'Neil plays the violin.", 24, day(24), 'people/lee-oneil');
}, 300_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

describe('S8 history: every dated value of the slot reaches the reader', () => {
  test('S8a extractor rows (all active): every city reaches the reader in a dated row', async () => {
    const rows = await ask(S8Q);
    const dated = rows.filter(r => /\[observed \d{4}-\d\d-\d\d|valid \d{4}-\d\d-\d\d/.test(r.chunk_text ?? '')).map(r => r.chunk_text).join('\n');
    for (const [c] of CITIES) expect(dated).toContain(c);
  });
  // Ended values reach the reader only with B1 (history in the facts block, the next PR); it removes `.failing`.
  test.failing('S8b after consolidate stamps valid_until on the older values: all four cities are in the context', async () => {
    const close = (city: string, until: number) => engine.executeRaw(
      'UPDATE facts SET valid_until = $2::timestamptz WHERE source_id = $1 AND fact = $3', [sourceId, day(until) + 'T00:00:00Z', 'Alice Example lives in ' + city + '.']);
    await close('Lisbon', 30);
    await close('Porto', 70);
    await close('Bergen', 110);
    const ctx = context(await ask(S8Q));
    for (const [c] of CITIES) expect(ctx).toContain(c);
  });
});

describe('A2 copies of one claim take one row; a differing value keeps its own', () => {
  test('ten restatements collapse to one row dated as first stated; the value one word apart stays', async () => {
    const facts = (await ask(S8Q)).filter(r => r.result_type === 'fact').map(r => r.chunk_text ?? '');
    const still = facts.filter(t => t.includes('Alice Example still lives in Oslo.'));
    expect(still).toHaveLength(1);
    expect(still[0]!.split('\n')[0]).toBe('[observed ' + day(111) + '; valid ' + day(111) + ' to unknown]');
    expect(still[0]).toContain('Alice Example still lives in Oslo. (stated 10 times, last ' + day(120) + ')');
    expect(facts.filter(t => /(^|\n)Alice Example lives in Oslo\.(\n|$)/.test(t))).toHaveLength(1);
  });
  test('copies are ordered by when they were said, not by their event date', async () => {
    const facts = (await ask('Where did Carol Example move to?')).filter(r => r.result_type === 'fact').map(r => r.chunk_text ?? '');
    const moved = facts.filter(t => t.includes('Carol Example moved to Madrid.'));
    expect(moved).toHaveLength(1);
    expect(moved[0]!.split('\n')[0]).toBe('[observed ' + day(7) + '; valid 2020-01-01 to unknown]');
    expect(moved[0]).toContain('Carol Example moved to Madrid. (stated 2 times, last ' + day(9) + ')');
  });
});

describe('S7 keyless admission', () => {
  test('an as-known phrasing still admits the employer facts (date token and auxiliaries do not dilute the term share)', async () => {
    const rows = await ask('As of 2025-04-01, what had I been told about where Bob Example works?');
    expect(rows.filter(r => r.result_type === 'fact' && /Gamma Labs/.test(r.chunk_text ?? '')).length).toBe(1);
  });
  test('precision: a fact that shares only a year and auxiliaries with the question is not admitted', async () => {
    const rows = await ask('What had been decided in 2025 about the vendor contract?');
    expect(rows.filter(r => r.result_type === 'fact' && /Dana Example/.test(r.chunk_text ?? ''))).toEqual([]);
  });
});

describe('A4 near names: an exact word outranks a stem-only match', () => {
  const Q = 'Where did Sam Roger live in 2025?';
  test('the named person\'s fact scores above the plural-shaped name', async () => {
    const pool = await collectFactCandidates(engine, Q, { sourceIds: [sourceId], worldOnly: true, excludePrivate: false }, null, { depth: { keyword: 50, cosine: 50, entity: 40 } });
    const order = scoreFactCandidates(Q, pool.candidates, pool.terms, pool.stems).map(s => s.candidate.fact).filter(f => f.startsWith('Sam Roger'));
    expect(order).toEqual(['Sam Roger lives in Porto.', 'Sam Rogers lives in Lisbon.']);
  });
  test('a one-letter name fragment is no match: a question about O\'Brien does not admit an O\'Neil fact', async () => {
    const facts = (await ask("What does Kim O'Brien play?")).filter(r => r.result_type === 'fact').map(r => r.chunk_text ?? '');
    expect(facts.some(t => t.includes("Kim O'Brien plays the cello."))).toBe(true);
    expect(facts.filter(t => t.includes("O'Neil"))).toEqual([]);
  });
  test('the facts block puts it first', async () => {
    const facts = (await ask(Q)).filter(r => r.result_type === 'fact').map(r => r.chunk_text ?? '').filter(t => t.includes('Sam Roger'));
    expect(facts[0]).toContain('Sam Roger lives in Porto.');
  });
});

describe('S7 as-known: the context says when each value was learned', () => {
  test('the late-learned change carries the date it was said (session 60), not only its event date', async () => {
    const rows = await ask('As of 2025-04-01, where did Bob Example work?');
    const gamma = rows.find(r => r.result_type === 'fact' && r.chunk_text?.includes('Gamma Labs'));
    expect(gamma).toBeDefined();
    expect(gamma!.chunk_text).toContain('observed ' + day(60));
  });
});
