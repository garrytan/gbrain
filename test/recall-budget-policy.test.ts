import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { NewFact } from '../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { awaitPendingLastRetrievedWrites } from '../src/core/last-retrieved.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { estimateTokens } from '../src/core/search/token-budget.ts';
import type { SearchResult } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { ERROR_SCHEMA, RESPONSE_SCHEMAS } from '../src/core/verbs.ts';
import { validateAgainstSchema } from '../src/core/verbs/conformance.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

beforeEach(async () => {
  await awaitPendingLastRetrievedWrites();
  await resetPgliteState(engine);
  await engine.setConfig('search.track_retrieval', 'false');
});

afterAll(async () => {
  await awaitPendingLastRetrievedWrites();
  await engine.disconnect();
  resetGateway();
});

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine, config: {}, logger: { info() {}, warn() {}, error() {} },
    dryRun: false, remote: false, sourceId: 'default', ...overrides,
  } as OperationContext;
}

async function recall(params: Record<string, unknown>, overrides: Partial<OperationContext> = {}): Promise<any> {
  return operationsByName.recall.handler(ctx(overrides), params);
}

async function fact(text: string, extra: Partial<NewFact> = {}, sourceId = 'default') {
  return engine.insertFact({ fact: text, source: 'synthetic-budget-test', visibility: 'world', ...extra }, { source_id: sourceId });
}

async function page(slug: string, title: string, text: string, sourceId = 'default', frontmatter = {}) {
  await engine.putPage(slug, { type: 'note', title, compiled_truth: text, frontmatter }, { sourceId });
  await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text }], { sourceId });
}

async function seedStarvation() {
  await page('notes/telescope', 'Zebra telescope', 'The zebra telescope calibration code is QX-17. Store it in the blue case.');
  for (let i = 0; i < 4; i++) {
    await fact(`Garden observation ${i}: `.padEnd(144, 'x'), { valid_from: new Date(`2026-09-01T00:00:0${i}Z`) });
  }
}

function withoutPacking(result: any) {
  const { budget_packing, ...legacy } = result;
  return legacy;
}

function assertAccounting(result: any) {
  expect(validateAgainstSchema(result, RESPONSE_SCHEMAS.recall)).toEqual([]);
  const packing = result.budget_packing;
  expect(packing).toBeDefined();
  const factsUsed = result.facts.reduce((n: number, f: any) => n + estimateTokens(f.fact), 0);
  const resultsUsed = (result.results ?? []).reduce((n: number, r: any) => n + estimateTokens(r.title) + estimateTokens(r.chunk), 0);
  expect(packing.facts.kept).toBe(result.facts.length);
  expect(packing.results.kept).toBe((result.results ?? []).length);
  expect(packing.facts.used).toBe(factsUsed);
  expect(packing.results.used).toBe(resultsUsed);
  for (const arm of [packing.facts, packing.results]) expect(arm.candidates).toBe(arm.kept + arm.dropped);
  if (result.budget_used !== undefined) {
    expect(result.budget_used).toBe(factsUsed + resultsUsed);
    expect(result.dropped_count).toBe(packing.facts.dropped + packing.results.dropped);
  }
}

test.each(['warn', 'reject'])('explicit recall source narrows both arms within grants under %s validation', async mode => {
  await engine.setConfig('mcp.strict_params', mode);
  for (const source of ['default', 'peer', 'denied']) {
    if (source !== 'default') await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [source]);
    await page('notes/telescope', 'Telescope', `Telescope evidence from ${source}.`, source);
    await fact(`Telescope evidence from ${source}.`, {}, source);
  }
  const options = { remote: true, sourceId: 'default', auth: { allowedSources: ['default', 'peer'] }, config: {} } as never;
  for (const source of [undefined, 'default', 'peer']) {
    const result = await dispatchToolCall(engine, 'recall', { query: 'telescope', budget_policy: 'query_first',
      budget_tokens: 1000, ...(source ? { source_id: source } : {}) }, options);
    expect(result.isError).not.toBe(true);
    expect(result._meta?.warnings).toBeUndefined();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    const expected = (source ? [source] : ['default', 'peer']).map(id => `Telescope evidence from ${id}.`).sort();
    expect(body.facts.map((row: any) => row.fact).sort()).toEqual(expected);
    expect(body.results.map((row: any) => row.chunk).sort()).toEqual(expected);
  }
  for (const source of ['denied', 'missing']) {
    const result = await dispatchToolCall(engine, 'recall', { source_id: source }, options);
    expect(result.isError).toBe(true);
    const error = JSON.parse((result.content[0] as { text: string }).text);
    expect(error).toMatchObject({ error: 'scope_denied', detail: 'permission_denied', protocol_version: 1 });
    expect(validateAgainstSchema(error, ERROR_SCHEMA)).toEqual([]);
  }
  await engine.executeRaw('UPDATE sources SET archived=TRUE WHERE id=$1', ['peer']);
  const archived = await dispatchToolCall(engine, 'recall', { source_id: 'peer' }, options);
  expect(archived.isError).toBe(true);
  const error = JSON.parse((archived.content[0] as { text: string }).text);
  expect(error).toMatchObject({ error: 'not_found', detail: 'unknown_source', protocol_version: 1 });
  expect(validateAgainstSchema(error, ERROR_SCHEMA)).toEqual([]);
});

test.each(['__all__', 'Bad Source', 7, []].map(value => [value]))('invalid recall selector %j has a v1 error through direct and MCP calls', async source_id => {
  let direct: any;
  try { await recall({ source_id }); } catch (error: any) { direct = error.toJSON(); }
  expect(direct).toMatchObject({ error: 'invalid_params', protocol_version: 1 });
  expect(direct.suggestion).toBeTruthy();
  expect(validateAgainstSchema(direct, ERROR_SCHEMA)).toEqual([]);
  const result = await dispatchToolCall(engine, 'recall', { source_id }, { remote: true, sourceId: 'default' });
  expect(result.isError).toBe(true);
  const error = JSON.parse(result.content[0].text);
  expect(error).toMatchObject({ error: 'invalid_params', protocol_version: 1 });
  expect(validateAgainstSchema(error, ERROR_SCHEMA)).toEqual([]);
});

test('an authorized missing source keeps its v1 not-found envelope for direct callers', async () => {
  let error: any;
  try { await recall({ source_id: 'missing-example' }); } catch (caught: any) { error = caught.toJSON(); }
  expect(error).toMatchObject({ error: 'not_found', detail: 'unknown_source', protocol_version: 1 });
  expect(error.suggestion).toBeTruthy();
  expect(validateAgainstSchema(error, ERROR_SCHEMA)).toEqual([]);
});

test.each([undefined, null])('an omitted selector %j preserves the legacy context-scope error', async source_id => {
  let error: any;
  try {
    await recall({ source_id }, { remote: true, sourceId: undefined,
      auth: { token: 'fixture', clientId: 'fixture', scopes: ['read'], allowedSources: [] } });
  } catch (caught: any) {
    error = JSON.parse(JSON.stringify(caught.toJSON()));
  }
  expect(error).toMatchObject({ error: 'permission_denied', message: 'No readable source is granted for this request.' });
  expect(error).not.toHaveProperty('protocol_version');
});

describe('recall opt-in query-first budget packing', () => {
  test('retains the matching note at 75 tokens while preserving omitted and explicit legacy output', async () => {
    await seedStarvation();
    const params = { query: 'zebra telescope', budget_tokens: 75 };
    const legacy = await recall(params);
    expect(legacy.results).toEqual([]);
    expect(legacy.total).toBe(2);
    expect(legacy.budget_used).toBe(72);
    expect(legacy.dropped_count).toBe(3);
    expect(legacy).not.toHaveProperty('budget_packing');
    const explicit = await recall({ ...params, budget_policy: 'facts_first' });
    expect(withoutPacking(explicit)).toEqual(legacy);
    expect(explicit.budget_packing).toMatchObject({ policy: 'facts_first', applied: true, reason: 'packed' });
    const candidate = await recall({ ...params, budget_policy: 'query_first' });
    expect(candidate.results.map((r: any) => r.slug)).toEqual(['notes/telescope']);
    expect(candidate.search_degraded).toBe('keyword_only_no_embedding_provider');
    expect(candidate.budget_packing).toMatchObject({ policy: 'query_first', applied: true, reason: 'packed', facts: { candidates: 4 }, results: { candidates: 1 } });
    expect(candidate.budget_used).toBeLessThanOrEqual(75);
    assertAccounting(explicit);
    assertAccounting(candidate);
  });

  test.each([undefined, '', '   '])('no query (%j) preserves exact legacy packing, even its sub-one quirk', async query => {
    await seedStarvation();
    const params = { query, budget_tokens: 0.5 };
    const legacy = await recall(params);
    expect(legacy.total).toBe(4);
    expect(legacy.budget_tokens).toBe(0);
    expect(legacy.budget_used).toBe(144);
    const candidate = await recall({ ...params, budget_policy: 'query_first' });
    expect(withoutPacking(candidate)).toEqual(legacy);
    expect(candidate).not.toHaveProperty('results');
    expect(candidate.budget_packing).toMatchObject({ policy: 'facts_first', applied: false, reason: 'no_query' });
    assertAccounting(candidate);
  });

  test.each([undefined, null, 0, -1, NaN, Infinity, -Infinity, '75', true])('inactive direct-handler budget %j keeps unbudgeted arrays', async budget_tokens => {
    await seedStarvation();
    const params = { query: 'zebra telescope', budget_tokens };
    const legacy = await recall(params);
    const candidate = await recall({ ...params, budget_policy: 'query_first' });
    expect(withoutPacking(candidate)).toEqual(legacy);
    expect(candidate).not.toHaveProperty('budget_tokens');
    expect(candidate.budget_packing).toMatchObject({ policy: 'facts_first', applied: false, reason: 'no_positive_finite_budget' });
    expect(candidate.facts).toHaveLength(4);
    expect(candidate.results).toHaveLength(1);
    assertAccounting(candidate);
  });

  test('eligible sub-one budget empties both arms only under query_first', async () => {
    await seedStarvation();
    const params = { query: 'zebra telescope', budget_tokens: 0.5 };
    const legacy = await recall(params);
    const explicit = await recall({ ...params, budget_policy: 'facts_first' });
    expect(withoutPacking(explicit)).toEqual(legacy);
    expect(explicit.budget_used).toBe(144);
    const candidate = await recall({ ...params, budget_policy: 'query_first' });
    expect(candidate).toMatchObject({ facts: [], results: [], total: 0, budget_tokens: 0, budget_used: 0, dropped_count: 5 });
    expect(candidate.budget_packing).toMatchObject({ policy: 'query_first', applied: true, reason: 'budget_below_one' });
    assertAccounting(candidate);
  });

  test.each([undefined, 'zebra telescope'])('facts-first reports its preserved sub-one overrun honestly: %j', async query => {
    await seedStarvation();
    const params = { query, budget_tokens: 0.5 };
    const legacy = await recall(params);
    const explicit = await recall({ ...params, budget_policy: 'facts_first' });
    expect(withoutPacking(explicit)).toEqual(legacy);
    expect(explicit.budget_used).toBe(144);
    expect(explicit.budget_packing).toMatchObject({ policy: 'facts_first', applied: false, reason: 'budget_below_one' });
    assertAccounting(explicit);
  });

  test('exact page boundary and fractional floor leave zero facts on an exhausted remainder', async () => {
    await seedStarvation();
    const unbudgeted = await recall({ query: 'zebra telescope' });
    const r = unbudgeted.results[0];
    const cost = estimateTokens(r.title) + estimateTokens(r.chunk);
    for (const budget_tokens of [cost, cost + 0.9]) {
      const candidate = await recall({ query: 'zebra telescope', budget_policy: 'query_first', budget_tokens });
      expect(candidate.facts).toEqual([]);
      expect(candidate.results).toEqual(unbudgeted.results);
      expect(candidate.budget_tokens).toBe(cost);
      expect(candidate.budget_used).toBe(cost);
      expect(candidate.dropped_count).toBe(4);
      assertAccounting(candidate);
    }
  });

  test('no page hits leaves the full budget for the same fact prefix', async () => {
    await seedStarvation();
    const params = { query: 'unmatched quasars', budget_tokens: 75 };
    const legacy = await recall(params);
    const candidate = await recall({ ...params, budget_policy: 'query_first' });
    expect(withoutPacking(candidate)).toEqual(legacy);
    expect(candidate.total).toBe(2);
    expect(candidate.budget_packing.results).toEqual({ candidates: 0, kept: 0, dropped: 0, used: 0 });
    assertAccounting(candidate);
  });

  test('empty arms report no candidates rather than a budget failure', async () => {
    const result = await recall({ query: 'unmatched quasars', budget_tokens: 75, budget_policy: 'query_first' });
    expect(result.budget_packing).toMatchObject({ policy: 'query_first', applied: true, reason: 'no_candidates' });
    expect(result).toMatchObject({ facts: [], results: [], budget_used: 0, dropped_count: 0 });
    assertAccounting(result);
  });

  test('oversized page head stops the page prefix, preserves its contents, and leaves facts the full budget', async () => {
    await fact('Fits.');
    const raw = [
      { page_id: 1, slug: 'notes/large', title: 'Large', chunk_text: 'x'.repeat(400), score: 2, source_id: 'default' },
      { page_id: 2, slug: 'notes/small', title: 'Small', chunk_text: 'Tiny', score: 1, source_id: 'default' },
    ] as SearchResult[];
    const search = spyOn(engine, 'searchKeyword').mockResolvedValue(raw);
    try {
      const result = await recall({ query: 'needle', budget_tokens: 10, budget_policy: 'query_first' });
      expect(result.results).toEqual([]);
      expect(result.facts.map((f: any) => f.fact)).toEqual(['Fits.']);
      expect(raw.map(r => [r.slug, r.chunk_text])).toEqual([['notes/large', 'x'.repeat(400)], ['notes/small', 'Tiny']]);
      expect(result.budget_packing.results).toEqual({ candidates: 2, kept: 0, dropped: 2, used: 0 });
      assertAccounting(result);
    } finally { search.mockRestore(); }
  });

  test('an oversized first fact cannot be skipped after pages; too-large first items explain an empty result', async () => {
    await fact('Tiny', { valid_from: new Date('2026-09-01') });
    await fact('x'.repeat(400), { valid_from: new Date('2026-09-02') });
    await page('notes/short', 'Needle', 'Needle');
    const result = await recall({ query: 'needle', budget_tokens: 10, budget_policy: 'query_first' });
    expect(result.results).toHaveLength(1);
    expect(result.facts).toEqual([]);
    assertAccounting(result);
    const empty = await recall({ query: 'needle', budget_tokens: 1, budget_policy: 'query_first' });
    expect(empty.budget_packing.reason).toBe('first_items_exceed_budget');
    expect(empty).toMatchObject({ facts: [], results: [], budget_used: 0, dropped_count: 3 });
    assertAccounting(empty);
  });

  test('retains multiple required pages in their original order without changing candidates or per-arm limits', async () => {
    await page('notes/canary-a', 'Canary rollout region', 'The canary rollout starts in region west.');
    await page('notes/canary-b', 'Canary rollout rollback', 'The canary rollout stops at three percent errors.');
    for (let i = 0; i < 4; i++) await fact(`Observation ${i}: `.padEnd(144, 'x'));
    const all = await recall({ query: 'canary rollout' });
    const result = await recall({ query: 'canary rollout', budget_tokens: 75, budget_policy: 'query_first' });
    expect(result.results).toEqual(all.results);
    expect(result.results).toHaveLength(2);
    assertAccounting(result);
    const limited = await recall({ query: 'canary rollout', limit: 1, budget_tokens: 75, budget_policy: 'query_first' });
    expect(limited.budget_packing.facts.candidates).toBe(1);
    expect(limited.budget_packing.results.candidates).toBe(1);
    expect(await recall({ query: 'canary rollout' })).toEqual(all);
  });

  test('fact-focused callers keep their route; forcing query_first can favor an irrelevant page over the filtered fact', async () => {
    await fact('Example prefers tea.', { entity_slug: 'people/example' });
    await fact('Unrelated fact.', { entity_slug: 'people/other-example' });
    await page('notes/tea-logistics', 'Tea logistics', 'Tea logistics discusses warehouse shelving. This note has no personal preference evidence.');
    const params = { query: 'tea logistics', entity: 'people/example', budget_tokens: 27 };
    const legacy = await recall(params);
    expect(legacy.facts.map((f: any) => f.fact)).toEqual(['Example prefers tea.']);
    const candidate = await recall({ ...params, budget_policy: 'query_first' });
    expect(candidate.facts).toEqual([]);
    expect(candidate.results).toHaveLength(1);
    expect(candidate.budget_packing.facts.candidates).toBe(1);
    expect(withoutPacking(await recall({ ...params, budget_policy: 'facts_first' }))).toEqual(legacy);
    assertAccounting(candidate);
  });

  test('expiry, supersession, since, session, and grep filters remain before candidate accounting', async () => {
    const active = await fact('needle active', { entity_slug: 'people/example', source_session: 'session-example', valid_from: new Date('2026-09-02') });
    await fact('needle old', { entity_slug: 'people/example', source_session: 'session-example', valid_from: new Date('2026-08-01') });
    await fact('needle other session', { entity_slug: 'people/example', source_session: 'other', valid_from: new Date('2026-09-02') });
    const expired = await fact('needle expired', { entity_slug: 'people/example', source_session: 'session-example', valid_from: new Date('2026-09-02') });
    const superseded = await fact('needle superseded', { entity_slug: 'people/example', source_session: 'session-example', valid_from: new Date('2026-09-02') });
    await engine.executeRaw('UPDATE facts SET expired_at = $1 WHERE id IN ($2, $3)', [new Date('2026-09-03'), expired.id, superseded.id]);
    await engine.executeRaw('UPDATE facts SET superseded_by = $1 WHERE id = $2', [active.id, superseded.id]);
    await page('notes/needle', 'Needle', 'Needle answer');
    const params = { query: 'needle', entity: 'people/example', since: '2026-09-01', session_id: 'session-example', grep: 'needle', budget_tokens: 1000, budget_policy: 'query_first' };
    const result = await recall(params);
    expect(result.facts.map((f: any) => f.fact)).toEqual(['needle active']);
    expect(result.budget_packing.facts.candidates).toBe(1);
    assertAccounting(result);
    for (const extra of [{ include_expired: true }, { supersessions: true }]) {
      const legacy = await recall({ ...params, ...extra, budget_policy: undefined });
      const candidate = await recall({ ...params, ...extra });
      expect(withoutPacking(candidate)).toEqual(legacy);
      assertAccounting(candidate);
    }
  });

  test('remote grants and private/safe-page filters apply before query-first packing across duplicate slugs', async () => {
    for (const source of ['peer', 'denied']) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [source]);
    await page('notes/compass', 'Compass public', 'Compass public answer.', 'peer');
    await page('notes/compass', 'Compass denied', 'Compass denied answer.', 'denied');
    await page('notes/private', 'Compass private', 'Compass private answer.', 'default', { visibility: 'private' });
    await engine.putPage('notes/unsafe', { type: 'note', title: 'Compass unsafe', compiled_truth: 'Compass unsafe answer.' });
    await fact('Public fact.', {}, 'peer');
    await fact('Private fact.', { visibility: 'private' }, 'peer');
    await fact('Denied fact.', {}, 'denied');
    const overrides = { remote: true, auth: { allowedSources: ['default', 'peer'] } } as Partial<OperationContext>;
    const params = { query: 'compass', budget_tokens: 75, budget_policy: 'query_first' };
    const result = await recall(params, overrides);
    expect(result.results.map((r: any) => r.title)).toEqual(['Compass public']);
    expect(result.facts.map((r: any) => r.fact)).toEqual(['Public fact.']);
    expect(result.budget_packing.facts.candidates).toBe(1);
    expect(result.budget_packing.results.candidates).toBe(1);
    assertAccounting(result);
  });
});

describe('recall shared schema and MCP dispatch', () => {
  test('the generated MCP tool exposes the optional enum and forwards it to the real handler', async () => {
    await seedStarvation();
    const schema: any = buildToolDefs([operationsByName.recall])[0].inputSchema;
    expect(schema.properties.budget_policy).toMatchObject({ type: 'string', enum: ['facts_first', 'query_first'] });
    expect(schema.required ?? []).not.toContain('budget_policy');
    const response = await dispatchToolCall(engine, 'recall', { query: 'zebra telescope', budget_tokens: 75, budget_policy: 'query_first' }, { remote: true, sourceId: 'default' });
    expect(response.isError).toBeFalsy();
    const result = JSON.parse(response.content[0].text);
    expect(result.results.map((r: any) => r.slug)).toEqual(['notes/telescope']);
    expect(result.budget_packing.policy).toBe('query_first');
    assertAccounting(result);
  });

  test.each([null, ''])('optional policy %j normalizes to omission without new response fields', async budget_policy => {
    const options = { remote: true, sourceId: 'default' };
    const legacy = await dispatchToolCall(engine, 'recall', {}, options);
    const result = await dispatchToolCall(engine, 'recall', { budget_policy }, options);
    expect(JSON.parse(result.content[0].text)).toEqual(JSON.parse(legacy.content[0].text));
    expect(JSON.parse(result.content[0].text)).not.toHaveProperty('budget_packing');
  });

  test.each(['unknown', ' ', true, 1, []])('invalid policy %j is rejected by the existing validator', async budget_policy => {
    const response = await dispatchToolCall(engine, 'recall', { budget_policy }, { remote: true, sourceId: 'default' });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error).toBe('invalid_params');
  });

  test.each(['75', true, []])('invalid transported numeric budget %j remains invalid', async budget_tokens => {
    const response = await dispatchToolCall(engine, 'recall', { budget_tokens, budget_policy: 'query_first' }, { remote: true, sourceId: 'default' });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error).toBe('invalid_params');
  });
});
