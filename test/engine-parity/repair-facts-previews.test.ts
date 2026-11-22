/**
 * BrainEngine parity: the previews of `gbrain repair consolidate-ties`, `facts-rehome`, `ontology-facts`,
 * `duplicate-facts` and `extractor-facts` (batch 4.1 of the repair-on-Rust plan).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain seeded so each preview LISTS at least one item, the plan (apply:false) of each of the five
 *    kinds gives the same preview, hash, listing and residuals on PGLite, Postgres (DATABASE_URL) and the Rust engine
 *    (GBRAIN_TEST_RUST_ARM=1). `listClosedConsolidationTies`, `listPagelessEntityFacts`, `listOntologyFactCandidates`
 *    and `listDuplicateFactRows` answer the same rows on every arm.
 *  - Regression: each plan read its candidates through `executeRaw`, which a Rust brain refuses, so every preview
 *    stopped at its first read there (extractor-facts at its page-id lookup).
 *  - Why existing coverage misses it: the repair tests for these kinds seed with raw SQL and run on PGLite or
 *    Postgres only, and the runner parity cases preview empty brains, which prove nothing about a listing.
 *  - Seam: none. Every fact, page and withdrawal is seeded through typed members. Only previews run: the applies of
 *    these kinds still write through raw SQL and the page write path (lane 5 and lane 7). Generated values (hashes,
 *    the brain id) are compared by shape; fact ids are the seeded ones, in the same order on every arm.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { publishSegmentedPage, segmentText } from '../helpers/page-body-fixtures.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { classifyOntologyFacts } from '../../src/core/repair/ontology-facts.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;
const EXTRACTOR = 'cli:extract-conversation-facts';

/** A result with every SHA-256 digest (a preview hash binds the brain id, drawn at random per brain) reduced to a marker. */
function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  const text = JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } });
  return JSON.parse(text.replace(/\b[0-9a-f]{64}\b/g, '<sha256>'));
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-previews-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The preview (apply:false) of one kind, shaped; the case fails unless it lists something. */
async function preview(engine: BrainEngine, kind: RepairKind, opts: Record<string, unknown> = {}) {
  return withHome(async () => {
    const scope = await resolveRepairScope(engine);
    const result = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run(kind, scope, { explicit: true, ...opts });
    expect(result.listing?.length ?? 0).toBeGreaterThan(0);
    return shape(result);
  });
}

const note = (title: string, type = 'note') => ({ type: type as 'note', title, compiled_truth: `${title} body.`, timeline: '', frontmatter: {} });

/** Facts through the typed `insertFacts` (no dedup); a row without a `source_markdown_slug` is filed on `notes/seed` with no fence row. Returns the ids as numbers. */
async function insert(engine: BrainEngine, rows: Array<Record<string, unknown>>): Promise<number[]> {
  const out = await engine.insertFacts(rows.map(row => ({ kind: 'fact', visibility: 'private', entity_slug: null, row_num: null, source_markdown_slug: 'notes/seed', ...row })) as never, { source_id: 'default' });
  return out.ids.map(Number);
}

/**
 * A result with the seeded fact ids reduced to their seed order (`f0`, `f1`, ...): a Postgres brain draws ids from a sequence
 * the cases before it advanced, so the arms agree on the relation of the ids, never on their value. Ids are named by the keys
 * `id`, `ids` and `partners` and by `#N` (not `row #N`), `fact N` and `facts/N` in a listing's text.
 */
function byOrder(value: unknown, ids: readonly number[]): unknown {
  const name = (n: unknown) => (typeof n === 'number' && ids.includes(n) ? `f${ids.indexOf(n)}` : n);
  const text = (t: string) => t.replace(/(?<=(?<!row )#|fact |facts\/)\d+/g, d => String(name(Number(d))));
  const walk = (v: unknown, key = ''): unknown => {
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === 'string') return text(v);
    return ['id', 'ids', 'partners'].includes(key) ? name(v) : v;
  };
  return walk(value);
}

describe('engine parity: repair kind previews that list facts', () => {
  parityTest('consolidate-ties lists the facts consolidation closed at their own instant, with their partners', {
    methods: ['insertFacts', 'consolidateFact', 'listClosedConsolidationTies', 'listSourceIncarnations', 'writeOpCheckpointRecord'], timeout: 60_000,
  }, async (engine) => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const tie = { entity_slug: 'companies/acme-example', claim_metric: 'arr', claim_unit: 'usd', claim_period: '2026', valid_from: at, valid_until: at, source: 'test' };
    const ids = await insert(engine, [{ ...tie, fact: 'Acme ARR is 5' }, { ...tie, fact: 'Acme ARR is 6' }, { ...tie, claim_unit: 'eur', fact: 'Acme ARR is 7 eur' },
      { ...tie, valid_until: null, fact: 'Acme ARR is 8' }]);
    for (const id of ids.slice(0, 3)) await engine.consolidateFact(id, 7);
    const rows = await engine.listClosedConsolidationTies(['default']);
    expect(rows.map(row => [Number(row.id), row.partners?.map(Number) ?? null])).toEqual([[ids[0]!, [ids[1]!]], [ids[1]!, [ids[0]!]], [ids[2]!, null]]);
    return byOrder({ rows: rows.map(row => ({ ...row, id: Number(row.id), take_id: Number(row.take_id), partners: row.partners?.map(Number) ?? null })), preview: await preview(engine, 'consolidate-ties') }, ids);
  });

  parityTest('facts-rehome lists a page-less entity slug that one organization page answers for', {
    methods: ['putPage', 'insertFacts', 'listPagelessEntityFacts', 'listSourceIncarnations', 'writeOpCheckpointRecord'], timeout: 60_000,
  }, async (engine) => {
    await engine.putPage('orgs/acme-example', note('Acme Example', 'company'), { sourceId: 'default' });
    const ids = await insert(engine, [
      { fact: 'Acme closed a round', entity_slug: 'companies/acme-example', source: 'mcp:extract_facts' },
      { fact: 'Acme hired a CFO', entity_slug: 'companies/acme-example', source: 'mcp:extract_facts' },
      { fact: 'Acme row on a page', entity_slug: 'companies/acme-example', source: 'fence', row_num: 1, source_markdown_slug: 'notes/acme' },
      { fact: 'Zed has no page', entity_slug: 'people/zed-nowhere', source: 'mcp:extract_facts' },
      { fact: 'Only a fence row', entity_slug: 'people/fenced-only', source: 'fence', row_num: 2, source_markdown_slug: 'notes/acme' },
      { fact: 'Lives on its page', entity_slug: 'orgs/acme-example', source: 'mcp:extract_facts' },
    ]);
    const rows = await engine.listPagelessEntityFacts(['default']);
    expect(rows.map(row => [row.slug, row.ids?.map(Number) ?? null, Number(row.fenced)])).toEqual([
      ['companies/acme-example', [ids[0]!, ids[1]!], 1], ['people/fenced-only', null, 1], ['people/zed-nowhere', [ids[3]!], 0]]);
    return byOrder({ rows: rows.map(row => ({ ...row, ids: row.ids?.map(Number) ?? null, fenced: Number(row.fenced) })), preview: await preview(engine, 'facts-rehome') }, ids);
  });

  parityTest('ontology-facts lists the observations the fence step moved, and excludes the withdrawn, consolidated and duplicate ones', {
    methods: ['insertFacts', 'consolidateFact', 'insertFactWithdrawal', 'listOntologyFactCandidates', 'listSourceIncarnations', 'writeOpCheckpointRecord'], timeout: 60_000,
  }, async (engine) => {
    // One valid_from for every observation: the duplicate test matches on it, and insertFacts stamps each row's own clock read.
    const obs = (value: string, extra: Record<string, unknown> = {}) => ({ fact: value, entity_slug: 'people/ana-example', dimension: 'role', value, value_hash: value,
      source: 'mine', source_markdown_slug: 'people/ana-example', valid_from: new Date('2026-01-02T03:04:05.000Z'), ...extra });
    const ids = await insert(engine, [
      obs('cto', { row_num: 1 }), obs('ceo', { expired_at: new Date('2026-02-03T04:05:06.123456Z') }), obs('cfo'), obs('coo'), obs('coo', { source_markdown_slug: 'mine' }),
      obs('cmo'), obs('cio', { source_markdown_slug: 'mine' }), obs('cxo', { source: `${EXTRACTOR}:v1`, source_markdown_slug: 'chats/x' }),
    ]);
    await engine.consolidateFact(ids[2]!, 3);
    await engine.insertFactWithdrawal('default', 'private', 'cmo', '*', null);
    const rows = await engine.listOntologyFactCandidates(['default']);
    expect(rows.map(row => [Number(row.id), row.withdrawn, row.consolidated, row.duplicate])).toEqual([
      [ids[0]!, false, false, false], [ids[1]!, false, false, false], [ids[2]!, false, true, false], [ids[3]!, false, false, true], [ids[5]!, true, false, false]]);
    const classified = await classifyOntologyFacts(engine, ['default']);
    return byOrder({ rows: rows.map(row => ({ ...row, id: Number(row.id), row_num: row.row_num == null ? null : Number(row.row_num) })),
      classes: classified.map(f => ({ id: f.id, class: f.class, reason: f.reason })), preview: await preview(engine, 'ontology-facts') }, ids);
  });

  parityTest('duplicate-facts lists a group of exact copies, the fenced copy first, and a fenced copy on a segmented page', {
    methods: ['insertFacts', 'putPage', 'createSegmentedPageShell', 'flipBodyGeneration', 'listDuplicateFactRows', 'listSegmentedPageSlugs', 'listSourceIncarnations', 'writeOpCheckpointRecord'],
    timeout: 60_000,
  }, async (engine) => {
    await engine.putPage('people/ana-example', note('Ana Example', 'person'), { sourceId: 'default' });
    await publishSegmentedPage(engine, 'notes/seg-example', [segmentText('a segmented body\n')]);
    const fence = (text: string, page: string, row: number, extra: Record<string, unknown> = {}) =>
      ({ fact: text, source: 'fence', visibility: 'world', row_num: row, source_markdown_slug: page, ...extra });
    const ids = await insert(engine, [
      { fact: 'Ana keeps bees', source: 'mcp:extract_facts' }, { fact: '  ana KEEPS bees ', source: 'mcp:extract_facts' },
      fence('Ana keeps bees', 'people/ana-example', 1), fence('ana keeps bees', 'people/ana-example', 2),
      fence('Bo rides', 'notes/seg-example', 1), fence('bo rides', 'notes/seg-example', 2),
      { fact: 'Ana keeps bees', source: 'mcp:extract_facts', attributed_to: 'user' }, { fact: 'Zed sings', source: 'mcp:extract_facts' },
    ]);
    const rows = await engine.listDuplicateFactRows(['default'], ['audit:terminal']);
    // Groups order by (visibility, fingerprint), so the world groups follow the hash; the order itself is compared across arms.
    expect(rows.map(row => Number(row.id)).sort((a, b) => a - b)).toEqual([ids[0]!, ids[1]!, ids[2]!, ids[3]!, ids[4]!, ids[5]!]);
    expect(await engine.listSegmentedPageSlugs('default')).toEqual(['notes/seg-example']);
    return byOrder({ rows: rows.map(row => ({ ...row, id: Number(row.id), row_num: row.row_num == null ? null : Number(row.row_num) })),
      preview: await preview(engine, 'duplicate-facts') }, ids);
  });

  parityTest('extractor-facts lists an expired fenceless extractor fact on a live page', {
    methods: ['putPage', 'insertFacts', 'listExtractorFactsForClassification', 'readLivePageIdBySlug', 'listSourceIncarnations'], timeout: 60_000,
  }, async (engine) => {
    await engine.putPage('chats/one-example', note('A chat'), { sourceId: 'default' });
    const ids = await insert(engine, [
      { fact: 'Ana keeps bees', source: `${EXTRACTOR}:v1`, source_markdown_slug: 'chats/one-example', expired_at: new Date('2026-03-04T05:06:07.654321Z') },
      { fact: 'Bo rides', source: `${EXTRACTOR}:v1`, source_markdown_slug: 'chats/one-example', entity_slug: 'people/bo-example', expired_at: new Date('2026-03-04T05:06:07.654321Z') },
      { fact: 'Still active', source: `${EXTRACTOR}:v1`, source_markdown_slug: 'chats/one-example' },
    ]);
    const rows = await engine.listExtractorFactsForClassification(['default'], null);
    expect(rows.map(row => Number(row.id))).toEqual([ids[0]!, ids[1]!]);
    return byOrder({ rows: rows.map(row => ({ ...row, id: Number(row.id), page_id: row.page_id == null ? null : 'page' })), preview: await preview(engine, 'extractor-facts') }, ids);
  });
});
