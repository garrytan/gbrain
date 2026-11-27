/**
 * BrainEngine parity — the plan reads of `gbrain repair frontmatter` and `gbrain repair segmented-tiling`, and the source
 * hold listing every sync hold reader starts from (batch 3 of the repair-on-Rust plan).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain with file-backed pages, a page with no origin, a soft-deleted page, a published segmented page,
 *    a segmented shell and two pages whose live rows do not tile their body, the four members return the same rows on
 *    PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1). Hold records of a current incarnation
 *    list by source then fingerprint in byte order, a stale incarnation's are left out, and a read-only mirror's holds
 *    read as such through readGitSourceHolds. The frontmatter and segmented-tiling previews give the same result.
 *  - Regression: both previews read through `executeRaw`, which a Rust brain refuses, so each kind stopped there
 *    (frontmatter at its segmented count, segmented-tiling at its untiled-page scan). The hold listing ordered by the
 *    database collation, so mixed-case fingerprints listed in a different order per database.
 *  - Why existing coverage misses it: test/repair-frontmatter*.test.ts, test/segmented-tiling*.test.ts and the sync hold
 *    tests run on PGLite or Postgres only.
 *  - Seam: the untiled pages are made by staging a published manifest row after the flip, damage no engine write makes.
 *    The segmented-tiling preview runs before that damage: its plan for a damaged page reads the page's file and stored
 *    fields, which no Rust brain can reach (a Rust flip refuses an untiled body). Generated values are compared by shape.
 */
import { describe } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { manifestRow, publishSegmentedPage, segmentText } from '../helpers/page-body-fixtures.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { GIT_HOLD_OP, readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';

const { parityTest } = parityArms(testBackends());

const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?\b/g;
const ONE = segmentText('# Intro\nfirst segment\n');
const TWO = segmentText('## Rest\nsecond segment\n');

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  return JSON.parse(JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(ISO, '<ts>'));
}

const quiet = { info() {}, warn() {}, error() {} } as never;

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-plan-scans-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function preview(engine: BrainEngine, kind: RepairKind) {
  const scope = await resolveRepairScope(engine);
  return shape(await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run(kind, scope, { explicit: true }));
}

async function put(engine: BrainEngine, slug: string, compiled_truth: string, source_path?: string) {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth, timeline: '', ...(source_path ? { source_path } : {}) }, { sourceId: 'default' });
}

/** A published row after the live ones: at the body's end (`long`) or past a gap (`gap`), so the rows no longer tile. */
async function damage(engine: BrainEngine, pageId: number, byteStart: number) {
  const [occurrence] = await engine.allocateBodyOccurrenceIds(1);
  await engine.stageManifestRows([manifestRow({ pageId, occurrenceId: occurrence!, genFrom: 1, seq: 2, text: TWO, byteStart, stagingId: null })]);
}

const bytes = ONE.body.byteLength + TWO.body.byteLength;

describe('engine parity: repair plan scans', () => {
  parityTest('frontmatter and segmented-tiling plan from the same pages on every engine', {
    methods: ['putPage', 'softDeletePage', 'setConfig', 'createSegmentedPageShell', 'allocateBodyOccurrenceIds', 'openBodyStaging', 'stageSegmentTexts',
      'stageManifestRows', 'flipBodyGeneration', 'setBodyStagingState', 'transaction',
      'listPagesByOriginPath', 'countSegmentedOriginPages', 'listSegmentedPageSlugs', 'listUntiledSegmentedPages'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await put(engine, 'notes/b-example', 'x'.repeat(450), 'notes/b-example.md');
    await put(engine, 'notes/a-example', 'short body', 'notes/a-example.md');
    await put(engine, 'notes/bare-example', 'no origin');
    await put(engine, 'notes/gone-example', 'gone', 'notes/gone-example.md');
    await engine.softDeletePage('notes/gone-example', { sourceId: 'default' });
    const { pageId: longId } = await publishSegmentedPage(engine, 'notes/long-example', [ONE, TWO]);
    const { pageId: gapId } = await publishSegmentedPage(engine, 'notes/gap-example', [ONE, TWO]);
    await engine.createSegmentedPageShell('notes/shell-example', { type: 'note', title: 'Shell', frontmatter: {}, source_path: 'notes/shell-example.md' }, { sourceId: 'default' });
    // A checkout for the default source: one clean file, one whose frontmatter lacks its closing fence, one with no page.
    const root = mkdtempSync(join(tmpdir(), 'gbrain-repair-plan-scans-repo-'));
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes/a-example.md'), '---\ntitle: notes/a-example\n---\nshort body\n');
    writeFileSync(join(root, 'notes/b-example.md'), '---\ntitle: notes/b-example\n\nbody without a closing fence\n');
    writeFileSync(join(root, 'notes/new-example.md'), '---\ntitle: [unclosed\n---\nnew\n');
    await engine.setConfig('sync.repo_path', root);
    const plans = { frontmatter: await preview(engine, 'frontmatter').finally(() => rmSync(root, { recursive: true, force: true })),
      segmentedTiling: await preview(engine, 'segmented-tiling') };
    const healthy = await engine.listUntiledSegmentedPages();

    await damage(engine, longId, bytes);
    await damage(engine, gapId, bytes + 5);
    const untiled = (await engine.listUntiledSegmentedPages()).map(({ page_id, revision, ...row }) => ({ page_id: typeof page_id, revision: typeof revision, ...row }));
    const members = {
      origins: (await engine.listPagesByOriginPath('default')).map(({ id, revision, head, ...row }) => ({ id: typeof id, revision: typeof revision, head: head?.length ?? null, ...row })),
      noOrigins: await engine.listPagesByOriginPath('other-example'),
      segmented: await engine.countSegmentedOriginPages(['default']),
      segmentedElsewhere: await engine.countSegmentedOriginPages(['other-example']),
      segmentedSlugs: await engine.listSegmentedPageSlugs('default'),
      segmentedSlugsElsewhere: await engine.listSegmentedPageSlugs('other-example'),
      healthy, untiled,
      bySlug: (await engine.listUntiledSegmentedPages({ slugs: ['notes/long-example'] })).map(row => row.slug),
      capped: (await engine.listUntiledSegmentedPages({ limit: 1 })).map(row => row.slug),
      elsewhere: await engine.listUntiledSegmentedPages({ sourceIds: ['other-example'] }),
    };
    return { plans, members };
  }));

  parityTest('hold records of current incarnations list by source then fingerprint in byte order', {
    methods: ['insertSource', 'readSourceIncarnation', 'writeOpCheckpointRecord', 'listSourceHoldRecords'],
  }, async (engine) => {
    await engine.insertSource({ id: 'mirror-example', name: 'mirror-example', local_path: null, config: { mirror_read_only: true } });
    const incarnation = async (id: string) => (await engine.readSourceIncarnation(id))!.incarnation;
    const def = await incarnation('default');
    const mirror = await incarnation('mirror-example');
    const hold = (fingerprint: string, record: Record<string, unknown>) => engine.writeOpCheckpointRecord(GIT_HOLD_OP, fingerprint, [record]);
    await hold('b-two', { source_id: 'default', incarnation: def, slug: 'two', path: 'two.md', run_id: 'run-1' });
    await hold('B-one', { source_id: 'default', incarnation: def, slug: 'one', path: 'one.md', page_id: 7 });
    await hold('a-mirror', { source_id: 'mirror-example', incarnation: mirror, slug: 'mirrored', path: 'm.md', run_id: 'run-1' });
    await hold('c-stale', { source_id: 'default', incarnation: '00000000-0000-4000-8000-000000000000', slug: 'old', path: 'old.md' });
    await hold('d-gone', { source_id: 'gone-example', incarnation: def, slug: 'orphan', path: 'orphan.md' });
    await engine.writeOpCheckpointRecord('other-op-example', 'x', [{ source_id: 'default', incarnation: def }]);
    const view = (rows: { record: Record<string, unknown>; mirror_read_only: boolean }[]) =>
      rows.map(({ record, mirror_read_only }) => ({ slug: record.slug, source_id: record.source_id, same: record.incarnation === def || record.incarnation === mirror, mirror_read_only }));
    const grouped = (await readGitSourceHolds(engine)).map(entry => ({ sourceId: entry.sourceId, count: entry.count,
      holds: entry.holds.map(record => ({ slug: record.slug, read_only_checkout: record.read_only_checkout ?? null })) }));
    return {
      all: view(await engine.listSourceHoldRecords(GIT_HOLD_OP)),
      mirrorOnly: view(await engine.listSourceHoldRecords(GIT_HOLD_OP, { sourceIds: ['mirror-example'] })),
      run: view(await engine.listSourceHoldRecords(GIT_HOLD_OP, { runId: 'run-1' })),
      none: await engine.listSourceHoldRecords(GIT_HOLD_OP, { sourceIds: [] }),
      grouped,
    };
  });
});
