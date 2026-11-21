/**
 * BrainEngine parity: the generation repair kinds of batch 7 of the repair-on-Rust plan.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain seeded so each preview lists at least one item, the preview is equal on PGLite, Postgres
 *    (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1). lost-fence-rows lists a fact row a fence generation
 *    retired while the page lost its whole facts fence, restored from the page version that held it; the restore is a
 *    page write on the SQL arms, and the Rust engine refuses it by name ("repair lost-fence-rows page write", lane 7's
 *    writer). The lost-fence-rows members answer the same rows on every arm.
 *  - Regression: the kind read the generation ledger, page versions, facts and takes through executeRaw, so a Rust brain
 *    failed on a generic executeRaw refusal that named no step.
 *  - Why existing coverage misses it: test/repair-lost-fence-rows.test.ts runs on PGLite and Postgres only.
 *  - Seam: the ledger row is written through the typed activateGenerationRows (lane 7), pages and versions through
 *    putPage and createVersion, facts and takes through insertFacts and addTakesBatch.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  const text = JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    // Postgres sequences keep counting across cases (harness reset), so page and version ids are not comparable; nor
    // is a generation's creation time.
    .replace(/"page_id":\d+/g, '"page_id":"<id>"').replace(/"version_id":\d+/g, '"version_id":"<id>"').replace(/page version \d+/g, 'page version <id>')
    .replace(/"id":\d+/g, '"id":"<id>"').replace(/retired \d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+00/g, 'retired <time>')
    .replace(/"retired_at":"[^"]*"/g, '"retired_at":"<time>"');
  return JSON.parse(text);
}

const runKind = async (engine: BrainEngine, kind: RepairKind, apply: boolean, opts: Record<string, unknown> = {}) =>
  (await repairRunner(engine, { apply, noEmbed: true, logger: quiet })).run(kind, await resolveRepairScope(engine), { explicit: true, ...opts });

const refusalText = (err: unknown) => JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail });

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-b7-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ---- lost-fence-rows ----

const SLUG = 'people/alice-example';
const LOST = 'Alice Example prefers written agendas';

/**
 * A version of the page holds facts rows 1 and 2; the live page has no facts fence at all. A fact_fence generation of
 * the page retired row 2 (its preimage), and no stored fact holds that text.
 */
async function seedLostFact(engine: BrainEngine) {
  const fence = renderFactsTable([
    { rowNum: 1, claim: 'Alice Example runs the platform team', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
    { rowNum: 2, claim: LOST, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
  ] as never);
  const page = (body: string) => ({ type: 'person' as const, title: 'Alice Example', compiled_truth: body, timeline: '' });
  await engine.putPage(SLUG, page(`# Alice Example\n\nProse.\n\n## Facts\n\n${fence}\n`), { sourceId: 'default' });
  await engine.createVersion(SLUG, { sourceId: 'default' });
  await engine.putPage(SLUG, page('# Alice Example\n\nProse, rewritten without the facts section.\n'), { sourceId: 'default' });
  await engine.activateGenerationRows({ sourceId: 'default', kind: 'fact_fence', ownerKey: `page:${SLUG}` }, null,
    { generation: 1, runId: null, operationId: 'op-lost-1', inputPin: null, inputSize: null, completeness: '{}', setHash: 'set-1', restoreOf: null,
      activationId: null, locator: null },
    [{ item_key: 'row:2', identity_hash: 'identity-2', action: 'retired',
      preimage: { id: 987_654, fact: LOST, visibility: 'world', row_num: 2, entity_slug: SLUG, expired_at: null }, preimage_bytes: null, pending: false }]);
}

describe('engine parity: the generation repair kinds of batch 7', () => {
  parityTest('lost-fence-rows previews a lost fact row the same way, and the Rust engine refuses the restore by name', {
    methods: ['putPage', 'createVersion', 'activateGenerationRows', 'listRetiredFenceItems', 'listInlineVersionTexts', 'hasActiveFactText',
      'readFactTrustTier', 'listFenceFactRowNums'],
    requires: 'raw_sql', timeout: 60_000,
  }, async (engine, backend) => withHome(async () => {
    await seedLostFact(engine);
    const previewed = await runKind(engine, 'lost-fence-rows', false);
    expect(previewed.affected).toBe(1);
    try {
      const applied = await runKind(engine, 'lost-fence-rows', true, { expect: previewed.preview_hash });
      expect((await engine.getPage(SLUG, { sourceId: 'default' }))?.compiled_truth).toContain(LOST);
      return { preview: shape(previewed), applied: shape(applied) };
    } catch (err) {
      if (backend === 'rust') expect(refusalText(err)).toContain('repair lost-fence-rows page write');
      throw err;
    }
  }));

  parityTest('the lost-fence-rows members answer the same rows on every arm', {
    methods: ['putPage', 'createVersion', 'activateGenerationRows', 'insertFacts', 'addTakesBatch', 'listRetiredFenceItems', 'listInlineVersionTexts',
      'hasActiveFactText', 'hasTakeClaim', 'readFactTrustTier', 'listFenceFactRowNums', 'listTakeRowNums', 'readLiveFactRowTier', 'readTakeRowTierByClaim'],
    timeout: 60_000,
  }, async (engine) => {
    await seedLostFact(engine);
    const page = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
    const pageId = Number(page.id);
    const ins = await engine.insertFacts([
      { fact: 'Stored fact', kind: 'fact', entity_slug: SLUG, visibility: 'world', source: 'fence', row_num: 3, source_markdown_slug: SLUG },
      { fact: 'Private fact', kind: 'fact', entity_slug: SLUG, visibility: 'private', source: 'fence', row_num: 5, source_markdown_slug: SLUG },
    ] as never, { source_id: 'default' });
    await engine.addTakesBatch([{ page_id: pageId, row_num: 4, claim: 'A take', kind: 'bet', holder: 'world', weight: 0.6, active: true, superseded_by: null }] as never);
    const strip = (rows: Array<{ id: number }>) => rows.map(({ id, ...rest }) => { void id; return rest; });
    const tier = (row: { id: number; trust_tier: string | null } | null) => row && { trust_tier: row.trust_tier };
    return {
      retired: (await engine.listRetiredFenceItems(['default'], null)).map(({ retired_at, ...rest }) => ({ ...rest, retired_at: typeof retired_at })),
      retiredOne: (await engine.listRetiredFenceItems(['default'], { source_id: 'default', slug: SLUG })).length,
      retiredOther: (await engine.listRetiredFenceItems(['default'], { source_id: 'default', slug: 'people/nobody' })).length,
      versions: strip(await engine.listInlineVersionTexts(pageId)),
      activeWorld: await engine.hasActiveFactText('default', SLUG, 'Stored fact', 'world'),
      activePrivate: await engine.hasActiveFactText('default', SLUG, 'Stored fact', 'private'),
      takeClaim: await engine.hasTakeClaim(pageId, 'A take'),
      noTakeClaim: await engine.hasTakeClaim(pageId, 'No take'),
      factTier: await engine.readFactTrustTier(Number(ins.ids[0])),
      noFactTier: await engine.readFactTrustTier(999_999),
      factRows: await engine.listFenceFactRowNums('default', SLUG),
      takeRows: await engine.listTakeRowNums(pageId),
      liveFact: tier(await engine.readLiveFactRowTier('default', SLUG, 3, 'Stored fact')),
      noLiveFact: await engine.readLiveFactRowTier('default', SLUG, 3, 'Other text'),
      liveTake: tier(await engine.readTakeRowTierByClaim(pageId, 4, 'A take')),
      noLiveTake: await engine.readTakeRowTierByClaim(pageId, 4, 'Other claim'),
    };
  });
});
