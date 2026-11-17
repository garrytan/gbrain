/**
 * GBRA-574 B1, B3 and G1: what the query facts block carries for a question about the past. PGLite, keyless, no network.
 *
 * B1: on a history or past-date cue, the block also takes the named entity's ended facts (superseded, or closed by a
 * valid_until in the past), with their windows. Never a fact expired with no successor, never one the withdrawal
 * ledger matches, never a fact the caller cannot read. No cue, no ended facts.
 * B3: when the question names one date, a fact said after it is marked "told after <date>", and one whose saying date
 * is unknown says "learn date unknown".
 * G1: a fact in a pending supersede proposal carries recall's contested label, only when the caller can read the
 * other fact; a failed lookup marks the rows, and query reports it as degraded.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { applyFactsBlock, hasHistoryCue } from '../src/core/search/facts-arm.ts';
import { collectFactCandidates } from '../src/core/search/fact-relevance.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { newSource, page, putPage } from './helpers/pinned-questions-fixture.ts';
import { valueHash } from '../src/core/chronicle/ontology.ts';

type Row = { result_type?: string; chunk_text?: string; fact_row?: { contested_unavailable?: true } };
const SRC = 'cli:extract-conversation-facts:v1';
let engine: PGLiteEngine;
let sourceId: string;
const ids: Record<string, number> = {};

const day = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 3 * 86_400_000).toISOString().slice(0, 10);
const session = (i: number) => 'conversations/talk-' + String(i).padStart(3, '0');

async function fact(key: string, text: string, entity: string, sessionIdx: number | null, opts: { validFrom?: string; visibility?: 'world' | 'private' } = {}) {
  const [row] = await engine.executeRaw<{ id: number }>(
    "INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from, source_markdown_slug) VALUES ($1, $2, $3, 'event', $4, $5, 1, $6::timestamptz, $7) RETURNING id",
    [sourceId, entity, text, SRC, opts.visibility ?? 'world', (opts.validFrom ?? day(sessionIdx ?? 0)) + 'T00:00:00Z', sessionIdx === null ? null : session(sessionIdx)]);
  ids[key] = Number(row!.id);
}
const end = (key: string, until: number) => engine.executeRaw('UPDATE facts SET valid_until = $2::timestamptz WHERE id = $1', [ids[key], day(until) + 'T00:00:00Z']);
const supersede = (key: string, by: string, until: number) => engine.executeRaw(
  'UPDATE facts SET expired_at = now(), superseded_by = $2, valid_until = $3::timestamptz WHERE id = $1', [ids[key], ids[by], day(until) + 'T00:00:00Z']);

const ask = async (query: string) =>
  (await handleToolCall(engine, 'query', { query, expand: false, use_cache: false, source_id: sourceId, limit: 50, token_budget: 5500 }) as Row[])
    .filter(r => r.result_type === 'fact').map(r => r.chunk_text ?? '');
const askRemote = async (query: string) => {
  __resetPrivateVisibilityCacheForTests();
  const auth = { token: 't', clientId: 'history-remote', scopes: ['read'], sourceId, allowedSources: [sourceId] };
  const r = await dispatchToolCall(engine, 'query', { query, expand: false, use_cache: false, limit: 50, token_budget: 5500 },
    { remote: true, transport: 'stdio', sourceId, auth, config: { engine: engine.kind } as never, logger: { info() {}, warn() {}, error() {} } });
  return r.content.map(c => (c as { text?: string }).text ?? '').join('\n');
};

const ERIN = 'people/erin-example';
const HISTORY_Q = 'Where has Erin Example lived before?';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  sourceId = await newSource(engine);
  for (const [slug, name] of [[ERIN, 'Erin Example'], ['people/bob-example', 'Bob Example'], ['companies/fern-example', 'Fern Example']] as const) {
    await putPage(engine, sourceId, slug, page(slug.startsWith('people/') ? 'person' : 'company', name, name + ' is in the address book.'));
  }
  for (let i = 1; i <= 80; i++) await putPage(engine, sourceId, session(i), page('conversation', 'Talk ' + i, '**User:** Weekly planning, session ' + i + '.\n\n**Assistant:** Noted.', 'date: ' + day(i) + '\n'));

  await fact('lima', 'Erin Example lives in Lima.', ERIN, 5);
  await fact('quito', 'Erin Example lives in Quito.', ERIN, 30);
  await fact('arequipa', 'Erin Example lives in Arequipa.', ERIN, 40);
  await fact('cusco', 'Erin Example lives in Cusco.', ERIN, 50);
  await fact('montevideo', 'Erin Example lives in Montevideo.', ERIN, 55, { visibility: 'private' });
  await fact('bogota', 'Erin Example lives in Bogota.', ERIN, 70);
  await end('lima', 30);
  await supersede('quito', 'bogota', 70);
  await end('montevideo', 60);
  await forgetFactInFence(engine, ids.cusco!);
  await supersede('arequipa', 'bogota', 70);
  await engine.executeRaw("INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ($1, 'world', $2, gbrain_fact_fingerprint('Erin Example lives in Arequipa.'))", [sourceId, ERIN]);

  await fact('beta', 'Bob Example works at Beta Corp.', 'people/bob-example', 10);
  await fact('gamma', 'Bob Example left Beta Corp and joined Gamma Labs.', 'people/bob-example', 60, { validFrom: '2025-02-15' });
  await fact('mentor', 'Bob Example works as a mentor for two interns.', 'people/bob-example', null, { validFrom: '2025-01-20' });

  await fact('denver', 'The Fern Example office is in Denver.', 'companies/fern-example', 20);
  await fact('austin', 'The Fern Example office is in Austin.', 'companies/fern-example', 25);
  await fact('reno', 'The Fern Example office is in Reno.', 'companies/fern-example', 26, { visibility: 'private' });
  const propose = (n: string, o: string) => engine.executeRaw(
    'INSERT INTO decide_proposals (source_id, sweep_id, pair_index, new_fact_id, old_fact_id, p_supersede, proposal_floor) VALUES ($1, $2, 0, $3, $4, 1, 1)', [sourceId, 'conflict:test-' + n + '-' + o, ids[n], ids[o]]);
  await propose('austin', 'denver');
  await propose('reno', 'austin');
}, 300_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

describe('B1 ended facts reach a history question', () => {
  test('history words and past dates are cues; a present or future question is not', () => {
    expect(hasHistoryCue(HISTORY_Q, '2026-11-17')).toBe(true);
    expect(hasHistoryCue('As of 2025-04-01, where did Bob Example work?', '2026-11-17')).toBe(true);
    expect(hasHistoryCue('Where does Erin Example live?', '2026-11-17')).toBe(false);
    expect(hasHistoryCue('Where will Erin Example live in 2030?', '2026-11-17')).toBe(false);
  });
  test('ended and superseded values arrive with their windows, oldest first', async () => {
    const rows = await ask(HISTORY_Q);
    const order = ['Lima', 'Quito', 'Bogota'].map(c => rows.findIndex(t => t.includes('Erin Example lives in ' + c + '.')));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(rows[order[0]!]!.split('\n')[0]).toBe('[observed ' + day(5) + '; valid ' + day(5) + ' to ' + day(30) + ']');
    expect(rows[order[2]!]!.split('\n')[0]).toBe('[observed ' + day(70) + '; valid ' + day(70) + ' to unknown]');
  });
  test('a forgotten fact and a withdrawn superseded fact never arrive', async () => {
    const text = (await ask(HISTORY_Q)).join('\n');
    expect(text).not.toContain('Cusco');
    expect(text).not.toContain('Arequipa');
  });
  test('a private ended fact reaches the local caller only', async () => {
    expect((await ask(HISTORY_Q)).join('\n')).toContain('Montevideo');
    const remote = await askRemote(HISTORY_Q);
    expect(remote).toContain('Lima');
    expect(remote).not.toContain('Montevideo');
    expect(remote).not.toContain('Arequipa');
  });
  test('no history cue: no ended fact', async () => {
    const text = (await ask('Where does Erin Example live?')).join('\n');
    expect(text).toContain('Bogota');
    expect(text).not.toContain('Lima');
    expect(text).not.toContain('Quito');
  });
});

describe('B3 a question that names a date', () => {
  const Q = 'As of 2025-04-01, where did Bob Example work?';
  test('a fact said after that date is marked told after it; one said before is not', async () => {
    const rows = await ask(Q);
    expect(rows.find(t => t.includes('Gamma Labs'))!.split('\n')[0]).toBe('[observed ' + day(60) + '; valid 2025-02-15 to unknown; told after 2025-04-01]');
    expect(rows.find(t => t.includes('Beta Corp.'))!.split('\n')[0]).toBe('[observed ' + day(10) + '; valid ' + day(10) + ' to unknown]');
  });
  test('a fact with no saying date says learn date unknown', async () => {
    const rows = await ask(Q);
    expect(rows.find(t => t.includes('mentor'))!.split('\n')[0]).toBe('[observed unknown; valid 2025-01-20 to unknown; learn date unknown]');
  });
  test('no date in the question: no mark', async () => {
    const text = (await ask('Where does Bob Example work?')).join('\n');
    expect(text).not.toContain('told after');
    expect(text).not.toContain('learn date unknown');
  });
});

describe('G1 contested facts in the block', () => {
  const Q = 'Where is the Fern Example office?';
  test('both facts of a pending proposal carry the label, naming the other fact', async () => {
    const rows = await ask(Q);
    expect(rows.find(t => t.includes('Denver'))).toContain('(contested by #' + ids.austin + ')');
    expect(rows.find(t => t.includes('Austin'))).toContain('(contested by #' + ids.denver + ')');
  });
  test('a remote caller never learns of a contested partner it cannot read', async () => {
    const remote = await askRemote(Q);
    expect(remote).toContain('(contested by #' + ids.denver + ')');
    expect(remote).not.toContain('#' + ids.reno);
    expect(remote).not.toContain('Reno');
  });
  test('a failed lookup leaves the rows unlabeled and marks them', async () => {
    const failing = new Proxy(engine, { get(target, prop) {
      if (prop === 'executeRaw') return (sql: string, params?: unknown[]) => sql.includes('unnest($1::bigint[]) AS x(id)') ? Promise.reject(new Error('lookup failed')) : target.executeRaw(sql, params);
      const v = (target as unknown as Record<string, unknown>)[prop as string];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } }) as BrainEngine;
    const rows = await applyFactsBlock(failing, Q, [], { sourceIds: [sourceId], remote: false, budget: 5500, tokenBudget: 5500, rowCap: async () => 50 }) as Row[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => (r.chunk_text ?? '').includes('contested'))).toBe(false);
    expect(rows.every(r => r.fact_row?.contested_unavailable)).toBe(true);
  });
});

describe('B1 review fixes', () => {
  test('a superseded fact whose page was purged never comes back', async () => {
    const GINA = 'people/gina-example';
    await putPage(engine, sourceId, GINA, page('person', 'Gina Example', 'Gina Example is in the address book.'));
    for (const i of [81, 82]) await putPage(engine, sourceId, session(i), page('conversation', 'Talk ' + i, '**User:** Weekly planning, session ' + i + '.\n\n**Assistant:** Noted.', 'date: ' + day(i) + '\n'));
    await fact('oslo', 'Gina Example lives in Oslo.', GINA, 81);
    await fact('bergen', 'Gina Example lives in Bergen.', GINA, null, { validFrom: day(81) });
    await engine.executeRaw("UPDATE facts SET source = 'sync:import', context = $2 WHERE id = $1", [ids.bergen, session(81) + ' — weekly notes']);
    await fact('tromso', 'Gina Example lives in Tromso.', GINA, 82);
    await supersede('oslo', 'tromso', 82);
    await supersede('bergen', 'tromso', 82);
    const Q = 'Where has Gina Example lived before?';
    const before = (await ask(Q)).join('\n');
    expect(before).toContain('Oslo');
    expect(before).toContain('Bergen');
    await engine.softDeletePage(session(81), { sourceId });
    await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE source_id = $1 AND slug = $2", [sourceId, session(81)]);
    expect((await engine.purgeDeletedPages(72)).slugs).toContain(session(81));
    const after = (await ask(Q)).join('\n');
    expect(after).toContain('Tromso');
    expect(after).not.toContain('Oslo');
    expect(after).not.toContain('Bergen');
  });
  test('a superseded conversation fact that kept its slot never comes back after its page is purged (GBRA-574 B2)', async () => {
    const IVY = 'people/ivy-example';
    await putPage(engine, sourceId, IVY, page('person', 'Ivy Example', 'Ivy Example is in the address book.'));
    for (const i of [91, 92]) await putPage(engine, sourceId, session(i), page('conversation', 'Talk ' + i, '**User:** Weekly planning, session ' + i + '.\n\n**Assistant:** Noted.', 'date: ' + day(i) + '\n'));
    await fact('lima', 'Ivy Example lives in Lima.', IVY, 91);
    await engine.executeRaw("UPDATE facts SET dimension = 'location', value = 'Lima', value_hash = $2, dim_status = 'active' WHERE id = $1", [ids.lima, valueHash('Lima')]);
    await fact('quito', 'Ivy Example lives in Quito.', IVY, 92);
    await supersede('lima', 'quito', 92);
    const Q = 'Where has Ivy Example lived before?';
    expect((await ask(Q)).join('\n')).toContain('Lima');
    await engine.softDeletePage(session(91), { sourceId });
    await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE source_id = $1 AND slug = $2", [sourceId, session(91)]);
    expect((await engine.purgeDeletedPages(72)).slugs).toContain(session(91));
    const after = (await ask(Q)).join('\n');
    expect(after).toContain('Quito');
    expect(after).not.toContain('Lima');
  });
  test('an entity with more ended facts than the pool depth keeps its most recent ones', async () => {
    const HANK = 'people/hank-example';
    await putPage(engine, sourceId, HANK, page('person', 'Hank Example', 'Hank Example is in the address book.'));
    for (let i = 1; i <= 5; i++) {
      await fact('hank' + i, 'Hank Example lives in Town' + i + '.', HANK, null, { validFrom: day(i) });
      await end('hank' + i, i + 1);
    }
    await fact('hank6', 'Hank Example lives in Town6.', HANK, null, { validFrom: day(6) });
    const { candidates } = await collectFactCandidates(engine, 'Where has Hank Example lived before?', { sourceIds: [sourceId], worldOnly: false, excludePrivate: false }, null,
      { depth: { keyword: 50, cosine: 50, entity: 3 }, history: true });
    const facts = candidates.map(c => c.fact);
    expect(facts).toContain('Hank Example lives in Town6.');
    expect(facts).toContain('Hank Example lives in Town5.');
    expect(facts).not.toContain('Hank Example lives in Town1.');
  });
});
