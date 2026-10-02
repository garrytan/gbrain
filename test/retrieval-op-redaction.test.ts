/**
 * ENG-4 / CEO-1 / ENG-5 / ENG-17 — every op's output-redaction policy, driven
 * through the real MCP dispatch path (`dispatchToolCall`, remote = true).
 *
 * Contract: an op classified 'retrieval' never hands a stored credential to a
 * caller (early returns included); an op classified 'no_stored_text' returns
 * no stored text at all; an exempt op names its reason. The seeded fixture
 * plants a random vendor token next to a plain marker word in every stored
 * text surface (titles, bodies, timeline, frontmatter, link context, facts,
 * takes, events, ontology values, ingest log, raw data). A retrieval op must
 * show the marker (anti-vacuity: it really returned stored text) but never
 * the token; a no_stored_text op must show neither.
 *
 * Regressions it catches: a new or edited read op that returns stored text
 * without the registration wrapper, a mis-classified op, a handler-level
 * redaction that skips the facts arm or the rendered text, and budgets or
 * delta cursors computed from text other than what is delivered.
 *
 * Every credential fixture is assembled at runtime from random parts (CEO-10).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { operations, operationsByName, type Operation, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { estimateTokens } from '../src/core/search/token-budget.ts';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function rand(n: number): string {
  let out = '';
  for (const b of randomBytes(n)) out += ALNUM[b % ALNUM.length];
  return out;
}
const vendorToken = () => ['gh', 'p_'].join('') + rand(36);
const openaiKey = () => ['sk', rand(40)].join('-');

const TOKEN = vendorToken();
const MARK = 'PLANTMARK';
const planted = (label: string) => `${MARK} ${label} ${TOKEN} end`;
const TODAY = new Date().toISOString().slice(0, 10);
const SRC = 'default';
const CONFIG = { engine: 'pglite' } as OperationContext['config'];

let engine: PGLiteEngine;

async function call(name: string, args: Record<string, unknown>, remote = true): Promise<{ text: string; isError: boolean }> {
  const res = await dispatchToolCall(engine, name, args, { remote, transport: 'stdio', sourceId: SRC, config: CONFIG });
  return { text: res.content.map(c => c.text).join('\n'), isError: res.isError === true };
}

function localCtx(): OperationContext {
  return {
    engine, config: CONFIG, remote: false, dryRun: false, sourceId: SRC, transport: 'stdio',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as OperationContext;
}

const isRetrieval = (op: Operation) =>
  op.outputRedaction === 'retrieval' || (typeof op.outputRedaction === 'object' && 'retrieval' in op.outputRedaction);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('schema_pack', 'gbrain-base');
  await engine.putPage('people/alice-example', {
    type: 'person', title: planted('person'), compiled_truth: planted('person body'),
    timeline: `- ${TODAY}: ${planted('timeline')}`, frontmatter: { summary: planted('summary') },
  }, { sourceId: SRC });
  await engine.putPage('notes/n1', {
    type: 'note', title: planted('note'), compiled_truth: `${planted('note body')}\nGITHUB_TOKEN=${rand(31)}7`,
    timeline: `- ${TODAY}: ${planted('note timeline')}`, frontmatter: {},
  }, { sourceId: SRC });
  await engine.putPage('misc/orphan', { type: 'note', title: planted('orphan'), compiled_truth: planted('orphan body'), frontmatter: {} }, { sourceId: SRC });
  await engine.executeRaw(`UPDATE pages SET type = '' WHERE slug = 'misc/orphan'`);
  await engine.putPage('stubs/s1', {
    type: 'person', title: planted('stub'), compiled_truth: planted('stub body'),
    frontmatter: { provenance: 'auto-extracted', status: 'unverified' },
  }, { sourceId: SRC });
  await engine.addTag('notes/n1', 'topic', { sourceId: SRC });
  await engine.addLink('notes/n1', 'people/alice-example', planted('link'), 'mentions', 'markdown', undefined, undefined, { fromSourceId: SRC, toSourceId: SRC });
  await engine.createVersion('notes/n1', { sourceId: SRC });
  await engine.putRawData('notes/n1', 'crm', { owner: planted('raw') }, { sourceId: SRC });
  await engine.logIngest({ source_id: SRC, source_type: 'test', source_ref: 'ref-1', pages_updated: ['notes/n1'], summary: planted('ingest') });
  await engine.insertFact({ fact: planted('fact'), entity_slug: 'people/alice-example', source: planted('fact source'), visibility: 'world', embedding: null, context: planted('fact context') } as never, { source_id: SRC });
  await engine.mergeOntologyFact({ entitySlug: 'people/alice-example', dimension: 'employer', value: planted('ontology'), confidence: 0.9, source: 'test:x', sourceId: SRC, visibility: 'world' } as never);
  await engine.upsertEventProjection({ depthSlug: 'people/alice-example', eventSlug: 'notes/n1', date: TODAY, summary: planted('event'), sourceId: SRC });
  const page = await engine.getPage('notes/n1', { sourceId: SRC });
  await engine.addTakesBatch([{ page_id: (page as { id: number }).id, row_num: 1, claim: planted('take'), kind: 'view', holder: 'world', weight: 0.8 }] as never);
  for (const slug of ['people/alice-example', 'notes/n1', 'misc/orphan', 'stubs/s1']) {
    const p = await engine.getPage(slug, { sourceId: SRC });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: p!.compiled_truth, chunk_source: 'compiled_truth', token_count: 8 }], { sourceId: SRC });
  }
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

describe('policy classification (ENG-4)', () => {
  test('every op declares a policy; exempt ops carry a reason; the plan-named ops are classified as stated', () => {
    for (const op of operations) {
      const p = op.outputRedaction;
      const valid = p === 'retrieval' || p === 'no_stored_text' ||
        (typeof p === 'object' && ('exempt' in p ? p.exempt.length >= 20 : Array.isArray(p.retrieval.localVerbatim)));
      expect(valid, op.name).toBe(true);
    }
    for (const name of ['get_page', 'fetch', 'get_chunks', 'get_raw_data']) {
      expect(typeof operationsByName[name]!.outputRedaction === 'object' && 'exempt' in (operationsByName[name]!.outputRedaction as object), name).toBe(true);
    }
    for (const name of ['takes_list', 'takes_search', 'search_by_image', 'volunteer_context', 'get_recent_transcripts', 'entity', 'search', 'query']) {
      expect(operationsByName[name]!.outputRedaction, name).toBe('retrieval');
    }
    for (const name of ['recall', 'context_pack', 'delta']) {
      expect(operationsByName[name]!.outputRedaction, name).toEqual({ retrieval: { localVerbatim: ['facts'] } });
    }
  });

  test('an op without a policy does not typecheck', () => {
    // @ts-expect-error outputRedaction is required on every Operation.
    const unclassified: Operation = { name: 'x', description: 'x', params: {}, handler: async () => null };
    expect(unclassified.name).toBe('x');
  });
});

// ─── Seeded sweep: every 'retrieval' and 'no_stored_text' op ───────────────
// `content: false` marks a retrieval op the fixture cannot make return stored
// text (its no-token assertion still runs). Every op not run here is a SKIP
// with its reason, so the table covers the two classes exactly.
type Row = { args: Record<string, unknown>; content?: false; remote?: false } | { skip: string };
const SWEEP: Record<string, Row> = {
  // retrieval — read
  entity: { args: { name: 'people/alice-example' } },
  synthesize: { skip: 'LLM-backed; keyless test env returns no composition. Wrapper coverage is the registration test below.' },
  list_pages: { args: { limit: 100 } },
  search: { args: { query: 'PLANTMARK note body', limit: 20 } },
  query: { args: { query: 'PLANTMARK note body', limit: 20 } },
  assemble_evidence: { args: { hits: [{ source_id: SRC, slug: 'notes/n1', chunk_id: 0 }], return_unit: 'page' } },
  search_by_image: { skip: 'needs image-embedding infra; cross-modal suites own it. Wrapper coverage is the registration test below.' },
  get_links: { args: { slug: 'notes/n1' } },
  get_backlinks: { args: { slug: 'people/alice-example' } },
  traverse_graph: { args: { slug: 'notes/n1', depth: 2 } },
  get_timeline: { args: { slug: 'people/alice-example' } },
  advisor: { skip: 'aggregate advisory over the installed skill stack; advisor suites own it' },
  get_ingest_log: { args: { limit: 50 } },
  find_orphans: { args: {} },
  get_calibration_profile: { args: {}, content: false },
  takes_list: { args: { limit: 50 } },
  takes_search: { args: { query: 'PLANTMARK', limit: 20 } },
  think: { skip: 'LLM-backed; keyless test env. Wrapper coverage is the registration test below.' },
  get_recent_salience: { args: { limit: 50 } },
  find_anomalies: { args: {}, content: false },
  get_recent_transcripts: { skip: 'local-only file walk; covered by test/transcripts-redaction.test.ts' },
  chronicle_day: { args: { date: TODAY } },
  chronicle_on_this_day: { args: { date: TODAY }, content: false },
  chronicle_since: { args: { date: TODAY } },
  chronicle_last_seen: { args: { entity: 'people/alice-example' }, content: false },
  ontology_get: { args: { entity: 'people/alice-example', include_quarantined: true } },
  ontology_conflicts: { args: {}, content: false },
  volunteer_chronicle: { args: { days: 30, limit: 50 } },
  volunteer_context: { args: { window: 'What do we know about people/alice-example?' }, content: false },
  extraction_pending: { args: { limit: 50 } },
  recall: { args: { query: 'PLANTMARK note body', entity: 'people/alice-example' } },
  context_pack: { args: { entities: 'people/alice-example', session_id: randomUUID() } },
  delta: { args: { since: '2000-01-01T00:00:00Z' } },
  find_contradictions: { args: {}, content: false },
  find_experts: { args: { topic: 'PLANTMARK', limit: 10 } },
  find_trajectory: { args: { entity_slug: 'people/alice-example' } },
  code_callers: { skip: 'code-index fixture pipeline; code-intel suites own it' },
  code_callees: { skip: 'code-index fixture pipeline; code-intel suites own it' },
  code_def: { skip: 'code-index fixture pipeline; code-intel suites own it' },
  code_refs: { skip: 'code-index fixture pipeline; code-intel suites own it' },
  code_blast: { skip: 'code-index fixture pipeline; code-intel suites own it' },
  code_flow: { skip: 'code-index fixture pipeline; code-intel suites own it' },
  open_loops: { args: {}, content: false },
  // retrieval — write/admin/agent (add_timeline_entry echoes the stored entry in its receipt)
  add_timeline_entry: { args: { slug: 'notes/n1', date: TODAY, summary: planted('new timeline'), request_id: randomUUID() } },
  ontology_propose: { skip: 'write op; returns the merged ontology row, covered by the wrapper registration test' },
  extract_entities: { skip: 'write op over the extraction pipeline; covered by the wrapper registration test' },
  quarantine_list: { args: {}, content: false },
  get_agent_job: { skip: 'agent-scope job poll needs a submitted agent job; covered by the wrapper registration test' },
  // no_stored_text — read
  search_modes: { args: {} },
  get_tags: { args: { slug: 'notes/n1' } },
  list_link_sources: { args: {} },
  get_brain_identity: { args: {} },
  list_skills: { skip: 'bundled skills catalog from the install tree (throws outside an installed skills dir)' },
  join_brain: { skip: 'shared-skills enrollment needs an explicit member grant; returns membership ids' },
  leave_brain: { skip: 'shared-skills membership op; returns membership ids' },
  resolve_slugs: { args: { partial: 'n1' } },
  takes_scorecard: { args: {} },
  takes_calibration: { args: {} },
  whoami: { args: {} },
  sources_list: { args: {} },
  sources_status: { args: { id: SRC } },
  sources_inspect: { skip: 'local-only inspection of a committed Git repository directory; returns repo metadata, owned by the sources suites' },
  request_tools: { args: { tools: ['get_page'] } },
  connectors_status: { args: {}, remote: false },
  ontology_dimensions: { args: {} },
  entity_identity_list: { args: {} },
  get_active_schema_pack: { args: {} },
  list_schema_packs: { args: {} },
  schema_stats: { args: {} },
  schema_lint: { args: {} },
  schema_graph: { args: {} },
  schema_explain_type: { args: { type: 'note' } },
  schema_review_orphans: { args: { limit: 50 } },
  // no_stored_text — write receipts (the planted content is the caller's own
  // input here; the receipt must not echo it)
  remember: { args: { fact: planted('remembered'), provenance: 'test:sweep', request_id: randomUUID() } },
  put_page: { args: { slug: 'notes/sweep-put', content: `---\ntitle: sweep\n---\n${planted('put body')}`, request_id: randomUUID() } },
  capture: { args: { content: planted('captured'), request_id: randomUUID() } },
  log_ingest: { args: { source_type: 'test', source_ref: 'sweep', pages_updated: ['notes/n1'], summary: planted('logged') } },
  add_tag: { args: { slug: 'notes/n1', tag: 'sweep-tag', request_id: randomUUID() } },
  remove_tag: { args: { slug: 'notes/n1', tag: 'sweep-tag', request_id: randomUUID() } },
  // no_stored_text — admin counters
  search_stats: { args: {} },
  cache_stats: { args: {} },
  get_stats: { args: {} },
  get_usage: { args: {} },
  get_job_stats: { args: {} },
};

const RECEIPT_SKIP = 'mutating write/admin receipt op (ids, status, counts); not run in the read sweep — its receipt shape is pinned by its own suite';

describe('seeded sweep through MCP dispatch (remote = true)', () => {
  test('the sweep table covers every retrieval and no_stored_text op exactly', () => {
    const classes = operations.filter(op => isRetrieval(op) || op.outputRedaction === 'no_stored_text').map(o => o.name).sort();
    const unlisted = classes.filter(n => !(n in SWEEP) && !(operationsByName[n]!.outputRedaction === 'no_stored_text' && operationsByName[n]!.scope !== 'read'));
    expect(unlisted).toEqual([]);
    expect(Object.keys(SWEEP).filter(n => !classes.includes(n))).toEqual([]);
  });

  for (const op of operations.filter(o => isRetrieval(o) || o.outputRedaction === 'no_stored_text')) {
    const row = SWEEP[op.name];
    if (!row) {
      test(`SKIP ${op.name} — ${RECEIPT_SKIP}`, () => {
        expect(op.scope).not.toBe('read');
      });
      continue;
    }
    if ('skip' in row) {
      test(`SKIP ${op.name} — ${row.skip}`, () => {
        expect(row.skip.length).toBeGreaterThan(20);
      });
      continue;
    }
    test(`${isRetrieval(op) ? 'RETRIEVAL' : 'NO_STORED_TEXT'} ${op.name}`, async () => {
      const { text, isError } = await call(op.name, row.args, row.remote ?? true);
      expect(isError, text.slice(0, 300)).toBe(false);
      expect(text.includes(TOKEN), `${op.name} returned the planted token`).toBe(false);
      if (!isRetrieval(op)) {
        if (op.scope === 'read') expect(text.includes(MARK), `${op.name} returned stored text`).toBe(false);
      } else if (row.content !== false) {
        expect(text.includes(MARK), `${op.name}: VACUOUS — no stored text came back`).toBe(true);
      }
    });
  }
});

// ─── Memory verbs (CEO-1, DX-15, ENG-5, ENG-9) ──────────────────────────────

describe('memory verbs redact query-arm text for everyone and facts for remote callers', () => {
  const pageToken = vendorToken();
  const assigned = `${rand(29)}4`;
  const factKey = openaiKey();

  beforeAll(async () => {
    await engine.putPage('notes/verb-page', {
      type: 'note', title: 'verb page', compiled_truth: `verbmark rollout notes ${pageToken}\nGITHUB_TOKEN=${assigned}`, frontmatter: {},
    }, { sourceId: SRC });
    const p = await engine.getPage('notes/verb-page', { sourceId: SRC });
    await installFixtureChunks(engine, 'notes/verb-page', [{ chunk_index: 0, chunk_text: p!.compiled_truth, chunk_source: 'compiled_truth', token_count: 12 }], { sourceId: SRC });
    await engine.insertFact({ fact: `verbfact key ${factKey}`, entity_slug: 'companies/acme-example', source: `test:${factKey}`, visibility: 'world', embedding: null } as never, { source_id: SRC });
  });

  test('recall over MCP: no page token, assignment value or fact key; identities byte-identical', async () => {
    const { text } = await call('recall', { query: 'verbmark rollout', entity: 'companies/acme-example' });
    for (const secret of [pageToken, assigned, factKey]) expect(text.includes(secret)).toBe(false);
    const body = JSON.parse(text);
    const hit = body.results.find((r: { slug: string }) => r.slug === 'notes/verb-page');
    expect(hit.provenance).toBe('notes/verb-page');
    expect(hit.chunk).toContain('<REDACTED:github_token>');
    expect(hit.chunk).toContain('GITHUB_TOKEN=<REDACTED:high_entropy_assignment>');
    const fact = body.facts.find((f: { entity_slug: string }) => f.entity_slug === 'companies/acme-example');
    expect(fact.fact).toBe('verbfact key <REDACTED:openai>');
    expect(fact.provenance).toBe('test:<REDACTED:openai>');
    expect(fact.fact_id).toBe(String(fact.id));
  });

  test('recall from the trusted local CLI: facts raw, query-arm results still redacted', async () => {
    const body = await operationsByName.recall!.handler(localCtx(), { query: 'verbmark rollout', entity: 'companies/acme-example' }) as {
      facts: Array<{ fact: string; source: string; entity_slug: string }>; results: Array<{ chunk: string }>;
    };
    const fact = body.facts.find(f => f.entity_slug === 'companies/acme-example')!;
    expect(fact.fact).toBe(`verbfact key ${factKey}`);
    expect(fact.source).toBe(`test:${factKey}`);
    const out = JSON.stringify(body.results);
    expect(out.includes(pageToken) || out.includes(assigned)).toBe(false);
  });

  test('context_pack and delta over MCP return no fact key; the local CLI gets facts raw but redacted text', async () => {
    for (const [name, args] of [['context_pack', { entities: 'companies/acme-example', session_id: randomUUID() }], ['delta', { since: '2000-01-01T00:00:00Z' }]] as const) {
      const { text } = await call(name, args);
      expect(text.includes(factKey), name).toBe(false);
      expect(text, name).toContain('verbfact key <REDACTED:openai>');
      const local = await operationsByName[name]!.handler(localCtx(), args) as { facts: Array<{ fact: string }>; text: string };
      expect(local.facts.some(f => f.fact === `verbfact key ${factKey}`), name).toBe(true);
      expect(local.text.includes(factKey), name).toBe(false);
    }
  });
});

describe('budgets and the delta cursor are computed from delivered (redacted) text (ENG-5)', () => {
  // 15 distinct characters + a digit: clears the assignment rule's entropy gate every run.
  const distinct = () => [...ALNUM].sort(() => randomBytes(1)[0]! - 128).slice(0, 15).join('') + '3';
  const shortSecrets = Array.from({ length: 30 }, distinct);

  beforeAll(async () => {
    for (const [i, s] of shortSecrets.entries()) {
      await engine.insertFact({ fact: `budgetmark ${i} password=${s}`, entity_slug: 'projects/budget-example', source: 'test:budget', visibility: 'world', embedding: null } as never, { source_id: SRC });
      await engine.putPage(`notes/budget-${String(i).padStart(2, '0')}`, { type: 'note', title: `budget ${i} password=${s}`, compiled_truth: 'b', frontmatter: {} }, { sourceId: SRC });
    }
  });

  test('context_pack: budget_used is the delivered text and stays within the allocation', async () => {
    for (const budget of [60, 90, 140]) {
      const body = JSON.parse((await call('context_pack', { entities: 'projects/budget-example', budget_tokens: budget, session_id: randomUUID() })).text);
      for (const s of shortSecrets) expect(body.text.includes(s)).toBe(false);
      expect(body.budget_used).toBe(estimateTokens(body.text));
      expect(body.budget_used).toBeLessThanOrEqual(budget);
      expect(body.dropped_count).toBeGreaterThan(0);
    }
  });

  test('delta: budget_used is the delivered text and the cursor never passes an undelivered page', async () => {
    const body = JSON.parse((await call('delta', { since: '2000-01-01T00:00:00Z', budget_tokens: 200 })).text);
    for (const s of shortSecrets) expect(JSON.stringify(body).includes(s)).toBe(false);
    expect(body.budget_used).toBe(estimateTokens(body.text));
    expect(body.budget_used).toBeLessThanOrEqual(200);
    expect(body.has_more).toBe(true);
    expect(body.pages.length).toBeGreaterThan(0);
    const last = body.pages[body.pages.length - 1];
    expect(body.next_cursor).toEqual({ since: last.updated_at, slug: last.slug });
    for (const p of body.pages) expect(body.text).toContain(`\`${p.slug}\``);
  });

  test('context_pack text over 64 KiB is redacted in full, never replaced with output_limit', async () => {
    const big = vendorToken();
    for (let i = 0; i < 40; i++) {
      await engine.insertFact({ fact: `bigmark ${i} ${big} ${'lorem ipsum dolor '.repeat(500)}`, entity_slug: 'projects/big-example', source: 'test:big', visibility: 'world', embedding: null } as never, { source_id: SRC });
    }
    const body = JSON.parse((await call('context_pack', { entities: 'projects/big-example', session_id: randomUUID() })).text);
    expect(body.text.length).toBeGreaterThan(64 * 1024);
    expect(body.text.includes(big)).toBe(false);
    expect(body.text).toContain('<REDACTED:github_token>');
    expect(body.text).not.toContain('<REDACTED:output_limit>');
  });
});
