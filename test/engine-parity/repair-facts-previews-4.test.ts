/**
 * BrainEngine parity: the applies of the fact repair kinds whose previews batch 4.1 and 4.2 made portable, and the
 * previews of `gbrain repair rename-identity` and `unwithdrawn-facts` (batch 4.3b of the repair-on-Rust plan).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain seeded so each preview lists at least one item, the apply of the printed preview of
 *    consolidate-ties, facts-rehome, ontology-facts, duplicate-facts, extractor-facts and fact-claim-dates changes the
 *    same rows on PGLite and Postgres (DATABASE_URL); the Rust engine (GBRAIN_TEST_RUST_ARM=1) gives the same preview and
 *    then refuses the apply as `engine_capability_missing` (raw_sql) with the step's name ("repair <kind> fact write" or
 *    "repair <kind> page write") before its first write. rename-identity's listing of a seeded source with no downgrade
 *    record is equal on every arm; with one record every arm lists the pair (the Rust engine serves
 *    readIdentityDowngradeRows since identity-restore-rust). unwithdrawn-facts
 *    lists a retired fact the same way on every arm (its classifier reads the page body through a typed member).
 *  - Named stop proven on a SQL engine without raw_sql: the unwithdrawn-facts restore (managed publications only) stops
 *    at "repair unwithdrawn-facts fact write".
 *  - Regression: each apply reached executeRaw with no stop, so a Rust brain failed on a generic executeRaw refusal that
 *    named no repair step.
 *  - Why existing coverage misses it: the parity previews never applied, and the repair tests seed with raw SQL on PGLite
 *    or Postgres only.
 *  - Seam: pages, facts and sources are seeded through typed members. Two seeds have no typed writer yet and run real
 *    writers on the SQL arms only: the identity-downgrade record (recordIdentityDowngrades, raw SQL; the Rust arm takes the
 *    record through the typed writeOpCheckpointRecord, which is all its refusal needs) and the facts-fence generation
 *    (publishFenceGeneration, raw SQL). Generated values (hashes, ids) are compared by shape.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms, recordIdentityDowngrade } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { publishSegmentedPage, segmentText } from '../helpers/page-body-fixtures.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { unwithdrawnFactsRepair } from '../../src/core/repair/unwithdrawn-facts.ts';
import { publishFenceGeneration, readFenceBlocks, FACT_FENCE_KIND } from '../../src/core/generations/fence.ts';
import { factFenceItems, factPreimages, factRetireItem } from '../../src/core/generations/adapters/fact-rows.ts';

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
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-previews4-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

type RunOpts = Record<string, unknown>;
const runKind = async (engine: BrainEngine, kind: RepairKind, apply: boolean, opts: RunOpts = {}, source?: string) =>
  (await repairRunner(engine, { apply, noEmbed: true, logger: quiet })).run(kind, await resolveRepairScope(engine, source), { explicit: true, ...opts });

/** The refusal text of an error: its message and detail, where the capability and the step it names are. */
const refusalText = (err: unknown) => JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail });

/** A preview that must list something, then the apply of what it printed: a SQL arm applies it; the Rust engine refuses the apply by name (`stop`). */
async function previewThenApply(engine: BrainEngine, backend: string, kind: RepairKind, stop: string, opts: RunOpts = {}) {
  return withHome(async () => {
    const previewed = await runKind(engine, kind, false, opts);
    expect(previewed.listing?.length ?? 0).toBeGreaterThan(0);
    try {
      const applied = await runKind(engine, kind, true, { ...opts, expect: previewed.preview_hash });
      return { preview: shape(previewed), applied: shape(applied) };
    } catch (err) {
      if (backend === 'rust') expect(refusalText(err)).toContain(stop);
      throw err;
    }
  });
}

const note = (title: string, type = 'note') => ({ type: type as 'note', title, compiled_truth: `${title} body.`, timeline: '', frontmatter: {} });

/** Facts through the typed `insertFacts` (no dedup); a row without a `source_markdown_slug` is filed on `notes/seed` with no fence row. Returns the ids as numbers. */
async function insert(engine: BrainEngine, rows: Array<Record<string, unknown>>): Promise<number[]> {
  const out = await engine.insertFacts(rows.map(row => ({ kind: 'fact', visibility: 'private', entity_slug: null, row_num: null, source_markdown_slug: 'notes/seed', ...row })) as never, { source_id: 'default' });
  return out.ids.map(Number);
}

/** The seeded fact ids reduced to their seed order (`f0`, `f1`, ...), as in repair-facts-previews.test.ts. */
function byOrder(value: unknown, ids: readonly number[]): unknown {
  const name = (n: unknown) => (typeof n === 'number' && ids.includes(n) ? `f${ids.indexOf(n)}` : n);
  const text = (t: string) => t.replace(/(?<=(?<!row )#|fact |facts\/)\d+/g, d => String(name(Number(d))));
  const walk = (v: unknown, key = ''): unknown => {
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === 'string') return text(v);
    return ['id', 'ids', 'partners', 'kept', 'superseded_by'].includes(key) ? name(v) : v;
  };
  return walk(value);
}

/** The engine with raw_sql withheld from its capabilities, every member still its own: a SQL brain that answers lacksRawSql as the Rust engine does. */
function withoutRawSql(engine: BrainEngine): BrainEngine {
  const capabilities = { has: (capability: string) => capability !== 'raw_sql' };
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'capabilities') return capabilities;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('engine parity: repair fact applies, rename-identity and unwithdrawn-facts (batch 4.3b)', () => {
  parityTest('consolidate-ties applies the same way on every arm', {
    methods: ['insertFacts', 'consolidateFact', 'listClosedConsolidationTies', 'writeOpCheckpointRecord'], timeout: 60_000,
  }, async (engine, backend) => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const tie = { entity_slug: 'companies/acme-example', claim_metric: 'arr', claim_unit: 'usd', claim_period: '2026', valid_from: at, valid_until: at, source: 'test' };
    const ids = await insert(engine, [{ ...tie, fact: 'Acme ARR is 5' }, { ...tie, fact: 'Acme ARR is 6' }]);
    for (const id of ids) await engine.consolidateFact(id, 7);
    const out = await previewThenApply(engine, backend, 'consolidate-ties', 'repair consolidate-ties fact write');
    expect(await engine.listClosedConsolidationTies(['default'])).toEqual([]);
    return byOrder(out, ids);
  });

  parityTest('facts-rehome applies the same way on every arm', {
    methods: ['putPage', 'insertFacts', 'listPagelessEntityFacts'], timeout: 60_000,
  }, async (engine, backend) => {
    await engine.putPage('orgs/acme-example', note('Acme Example', 'company'), { sourceId: 'default' });
    const ids = await insert(engine, [{ fact: 'Acme closed a round', entity_slug: 'companies/acme-example', source: 'mcp:extract_facts' }]);
    const out = await previewThenApply(engine, backend, 'facts-rehome', 'repair facts-rehome fact write');
    expect(await engine.listPagelessEntityFacts(['default'])).toEqual([]);
    return byOrder(out, ids);
  });

  parityTest('ontology-facts applies the same way on every arm', {
    methods: ['insertFacts', 'listOntologyFactCandidates'], timeout: 60_000,
  }, async (engine, backend) => {
    const ids = await insert(engine, [{ fact: 'cto', entity_slug: 'people/ana-example', dimension: 'role', value: 'cto', value_hash: 'cto', source: 'mine',
      source_markdown_slug: 'people/ana-example', row_num: 1 }]);
    const out = await previewThenApply(engine, backend, 'ontology-facts', 'repair ontology-facts fact write');
    expect(await engine.listOntologyFactCandidates(['default'])).toEqual([]);
    return byOrder(out, ids);
  });

  parityTest('duplicate-facts applies a database-only group the same way on every arm', {
    methods: ['insertFacts', 'putPage', 'createSegmentedPageShell', 'flipBodyGeneration', 'listDuplicateFactRows'], timeout: 60_000,
  }, async (engine, backend) => {
    await engine.putPage('people/ana-example', note('Ana Example', 'person'), { sourceId: 'default' });
    await publishSegmentedPage(engine, 'notes/seg-example', [segmentText('a segmented body\n')]);
    const ids = await insert(engine, [{ fact: 'Ana keeps bees', source: 'mcp:extract_facts' }, { fact: '  ana KEEPS bees ', source: 'mcp:extract_facts' }]);
    const out = await previewThenApply(engine, backend, 'duplicate-facts', 'repair duplicate-facts page write');
    expect(await engine.listDuplicateFactRows(['default'], ['audit:terminal'])).toEqual([]);
    return byOrder(out, ids);
  });

  parityTest('extractor-facts applies the same way on every arm', {
    methods: ['putPage', 'insertFacts', 'listExtractorFactsForClassification'], timeout: 60_000,
  }, async (engine, backend) => {
    await engine.putPage('chats/one-example', note('A chat'), { sourceId: 'default' });
    const ids = await insert(engine, [{ fact: 'Ana keeps bees', source: `${EXTRACTOR}:v1`, source_markdown_slug: 'chats/one-example', expired_at: new Date('2026-03-04T05:06:07.654321Z') }]);
    const out = await previewThenApply(engine, backend, 'extractor-facts', 'repair extractor-facts fact write', { includeAmbiguous: true });
    return byOrder({ ...out, after: (await engine.listExtractorFactsForClassification(['default'], null)).map(row => Number(row.id)) }, ids);
  });

  parityTest('fact-claim-dates applies a database-only fact move the same way on every arm', {
    methods: ['insertFacts', 'listFactsOnValidDay'], timeout: 60_000,
  }, async (engine, backend) => {
    const day = '2026-02-03';
    const ids = await insert(engine, [{ source: 'test', valid_from: new Date(`${day}T10:11:12.345678Z`), fact: 'Acme closed a seed round on 2025-03-14',
      entity_slug: 'companies/acme-example', source_markdown_slug: null }]);
    const out = await previewThenApply(engine, backend, 'fact-claim-dates', 'repair fact-claim-dates fact write', { day });
    expect((await engine.listFactsOnValidDay('default', day)).map(row => Number(row.id))).toEqual([]);
    return byOrder(out, ids);
  });

  parityTest('the repair apply members recheck and write the same rows on every arm', {
    methods: ['putPage', 'insertFacts', 'consolidateFact', 'computeFactFingerprints', 'restoreConsolidationTie', 'listLiveDuplicateRows',
      'supersedeDuplicateFacts', 'linkStruckDuplicateFacts', 'listCommittedRestorePages', 'listActivePositionedFactIds', 'readFactRestorePage',
      'restoreExtractorFact', 'moveFactClaimDates', 'readSourceCloneRow', 'detachFenceRowFacts', 'hasDatabaseOnlyClaim', 'lockApprovedFacts',
      'expireApprovedFacts'], timeout: 60_000,
  }, async (engine) => {
    await engine.putPage('notes/fenced', note('Fenced'), { sourceId: 'default' });
    const at = new Date('2026-01-01T00:00:00.000Z');
    const ids = await insert(engine, [
      { fact: 'Ana keeps bees', entity_slug: 'people/ana-example', source: 'mcp:extract_facts' },
      { fact: '  ana KEEPS bees ', entity_slug: 'people/ana-example', source: 'mcp:extract_facts' },
      { fact: 'Fenced claim', entity_slug: 'notes/fenced', source: 'mcp:put_page', source_markdown_slug: 'notes/fenced', row_num: 3 },
      { fact: 'Acme ARR is 5', entity_slug: 'companies/acme-example', claim_metric: 'arr', claim_unit: 'usd', claim_period: '2026', valid_from: at,
        valid_until: at, source: 'test' },
      { fact: 'Ana keeps hives', source: `${EXTRACTOR}:v1`, expired_at: new Date('2026-03-04T05:06:07.654321Z') },
      { fact: 'Acme closed a seed round on 2025-03-14', entity_slug: 'companies/acme-example', source: 'test',
        valid_from: new Date('2026-02-03T10:11:12.345678Z') },
    ]);
    const [f0, f1, f2, f3, f4, f5] = ids;
    await engine.consolidateFact(f3!, 7);
    const name = (v: unknown): unknown => (Array.isArray(v) ? v.map(name) : typeof v === 'number' && ids.includes(v) ? `f${ids.indexOf(v)}` : v);
    const [fingerprint] = await engine.computeFactFingerprints(['Ana keeps bees']);
    const live = async () => (await engine.listLiveDuplicateRows('default', [f0!, f1!, f2!], 'private', fingerprint!)).map(r => ({ ...r, id: name(r.id) }));
    const before = await live();
    const superseded = name(await engine.supersedeDuplicateFacts('default', [f1!], f0!, 'private', fingerprint!));
    const supersededAgain = name(await engine.supersedeDuplicateFacts('default', [f1!], f0!, 'private', fingerprint!));
    const after = await live();
    // A JS Date carries milliseconds, so the seeded expiry and valid_from are stored to the millisecond on every arm.
    const restored = [await engine.restoreExtractorFact('default', f4!, 9, '2026-03-04T05:06:07.653000Z'),
      await engine.restoreExtractorFact('default', f4!, 9, '2026-03-04T05:06:07.654000Z'),
      await engine.restoreExtractorFact('default', f4!, 9, '2026-03-04T05:06:07.654000Z')];
    const positioned = name(await engine.listActivePositionedFactIds([f0!, f2!, f4!]));
    const page = await engine.readFactRestorePage('default', 'notes/fenced');
    const pages = { page: page && { ...page, id: typeof page.id }, gone: await engine.readFactRestorePage('default', 'notes/no-such-page') };
    const tie = { source_id: 'default', id: f3!, entity_slug: 'companies/acme-example', take_id: 7, valid_from: at };
    const ties = [await engine.restoreConsolidationTie(tie), await engine.restoreConsolidationTie(tie)];
    const move = [{ id: f5!, valid_from: '2026-02-03T10:11:12.345000Z', date: '2025-03-14' }];
    const moved = [name(await engine.moveFactClaimDates('default', move)), name(await engine.moveFactClaimDates('default', move))];
    const detached = [name(await engine.detachFenceRowFacts('default', 'notes/fenced', 3)), name(await engine.detachFenceRowFacts('default', 'notes/fenced', 3))];
    const claims = [await engine.hasDatabaseOnlyClaim('default', 'notes/fenced', 'Fenced claim'), await engine.hasDatabaseOnlyClaim('default', 'notes/fenced', 'Other claim')];
    await engine.lockApprovedFacts('default', [f0!]);
    const expired = name(await engine.expireApprovedFacts('default', [f0!, f5!]));
    const linked = [name(await engine.linkStruckDuplicateFacts('default', [f0!, f2!], f5!)), name(await engine.linkStruckDuplicateFacts('default', [f0!], f5!))];
    const committed = await engine.listCommittedRestorePages(['default'], ['chats/one-example'], 'no-such-hash', []);
    const clone = { known: await engine.readSourceCloneRow('default'), unknown: await engine.readSourceCloneRow('no-such-source') };
    return { before, superseded, supersededAgain, after, restored, positioned, pages, ties, moved, detached, claims, expired, linked, committed, clone };
  });

  parityTest('rename-identity lists no pair on a seeded source with no downgrade record', {
    methods: ['putPage', 'softDeletePage', 'readIdentityDowngradeRows'], timeout: 60_000,
  }, async (engine) => {
    await engine.putPage('people/old-example', note('Old Example', 'person'), { sourceId: 'default' });
    await engine.putPage('people/new-example', note('New Example', 'person'), { sourceId: 'default' });
    expect(await engine.softDeletePage('people/old-example', { sourceId: 'default' })).toEqual({ slug: 'people/old-example' });
    return withHome(async () => shape(await runKind(engine, 'rename-identity', false, { sourceFlag: 'default' }, 'default')));
  });

  parityTest('rename-identity lists an open pair on every arm (identity-restore-rust serves readIdentityDowngradeRows)', {
    methods: ['putPage', 'softDeletePage', 'readIdentityDowngradeRows'], timeout: 60_000,
  }, async (engine, backend) => {
    await engine.putPage('people/old-example', note('Old Example', 'person'), { sourceId: 'default' });
    await engine.putPage('people/new-example', note('New Example', 'person'), { sourceId: 'default' });
    await engine.softDeletePage('people/old-example', { sourceId: 'default' });
    const pair = { from: 'people/old-example.md', to: 'people/new-example.md', similarity: 0.5, reason: 'no_identity_signal' as const };
    // The record writer is the harness's (raw SQL on the SQL arms, the store's typed checkpoint row on Rust): both store the open record.
    await recordIdentityDowngrade(engine, backend, 'default', 'people/old-example', { ...pair, source_id: 'default' });
    const result = await withHome(() => runKind(engine, 'rename-identity', false, { sourceFlag: 'default' }, 'default'));
    expect(result.residuals).toEqual({ open_pairs: 1 });
    return shape(result);
  });

  parityTest('unwithdrawn-facts lists a fact a facts-fence generation retired the same way on every arm', {
    methods: ['putPage', 'insertFacts', 'expireFenceFacts', 'listUnwithdrawnFacts', 'readPageInlineBody'], timeout: 60_000,
  }, async (engine) => {
    const slug = 'people/alice-example';
    // A facts fence the generation parses, holding row 1 only.
    const fence = ['## Facts', '', '<!--- gbrain:facts:begin -->', '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
      '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
      '| 1 | Alice founded acme-example | fact | 1.0 | private | medium | 2020-01-01 |  | chat |  |', '<!--- gbrain:facts:end -->', ''].join('\n');
    await engine.putPage(slug, { ...note('Alice Example', 'person'), compiled_truth: `# Alice Example\n\n${fence}` }, { sourceId: 'default' });
    const ids = await insert(engine, [{ fact: 'Alice runs marathons', entity_slug: slug, source: 'mcp:put_page', row_num: 2, source_markdown_slug: slug }]);
    // What the pre-fix projection did on a page's first fact generation: record it, retiring the row with its before-state, and expire it
    // (an empty incoming fence states no row, so the expiry detaches and expires the retired row).
    await engine.transaction(async tx => {
      const page = (await tx.readPageSnapshot(slug, { sourceId: 'default' }))!.page;
      await publishFenceGeneration(tx, { kind: FACT_FENCE_KIND, sourceId: 'default', slug, read: readFenceBlocks(page, 'facts'),
        items: factFenceItems([{ row_num: 1, fact: 'Alice founded acme-example', visibility: 'private' }]),
        retire: (await factPreimages(tx, 'default', ids)).map(factRetireItem), writer: 'projection' });
      await tx.expireFenceFacts('default', slug, '[]', ids);
    });
    // On this unmanaged brain the listing excludes the row (an extract_facts reconcile would retire it again), so the
    // preview is the whole contract; the restore runs only inside a managed publication.
    const result = await withHome(() => runKind(engine, 'unwithdrawn-facts', false));
    expect(result.listing?.length ?? 0).toBeGreaterThan(0);
    // The restore's named stop, on this brain with raw_sql withheld as the Rust engine withholds it.
    const stop = await unwithdrawnFactsRepair.apply({ engine: withoutRawSql(engine) } as never, { page: {}, hash: 'h', last: false } as never).then(() => 'no stop', refusalText);
    expect(stop).toContain('repair unwithdrawn-facts fact write');
    return byOrder(shape(result), ids);
  });
});
