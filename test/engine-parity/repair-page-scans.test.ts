/**
 * BrainEngine parity — the page scans of `gbrain repair safe-chunks` and `gbrain repair origin-twins` (batch 3 of the
 * repair-on-Rust plan), and the page reads of `gbrain repair ghost-pages` and `gbrain repair legacy-twins`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain with markdown pages, code pages with and without a file, a soft-deleted page and a page whose
 *    origin is another page's origin under a legacy `scope/` prefix, the five scan members return the same rows, and
 *    the safe-chunks preview plus the origin-twins preview and apply give the same result, on PGLite, Postgres
 *    (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: both plans read through `executeRaw`, which a Rust brain refuses, so each kind stopped before its first
 *    read there. The legacy-pair read also had no ORDER BY under its LIMIT, so the pairs it kept were not fixed.
 *    The ghost-pages and legacy-twins scans read pages through `executeRaw` too; `listRepairScanPages` and
 *    `countLiveFileBackedPages({ nonBlank })` now answer each of their query shapes (a page after an id, a legacy page
 *    with no origin, live file pages by slug, pages in any state by id). Merging a twin read what it would land on
 *    (links, link transitions, timeline entries and raw data already on the survivor) through `executeRaw` as well;
 *    `listTwinMergeLosers` answers it. The origin-twins verdict read each claimant's body digest, frontmatter id, trust tier,
 *    privacy and slug-keyed withdrawals through `executeRaw` (`readOriginClaimants`); `listOriginClaimants` answers it. The uncommitted-deletions scan read its tombstones (and whether a managed sync
 *    made each one) through `executeRaw` too; `listFileTombstones` answers it, by id descending below a page id.
 *  - Why existing coverage misses it: test/repair-safe-chunks*.test.ts and test/origin-twins*.test.ts run on PGLite
 *    or Postgres only.
 *  - Seam: none. The safe-chunks apply re-seals chunks, a write that moves in batch 6, so this case previews it only.
 *    Generated values (the brain id, timestamps, hashes) are compared by shape.
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

const { parityTest } = parityArms(testBackends());

const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?\b/g;

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  return JSON.parse(JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(ISO, '<ts>'));
}

const quiet = { info() {}, warn() {}, error() {} } as never;

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-page-scans-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function preview(engine: BrainEngine, kind: RepairKind) {
  const scope = await resolveRepairScope(engine);
  return (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run(kind, scope, { explicit: true });
}

/** Preview, then apply what the preview printed (bound by its hash), as `gbrain repair <kind> --apply --expect` does. */
async function previewThenApply(engine: BrainEngine, kind: RepairKind) {
  const shown = await preview(engine, kind);
  const applied = await (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet }))
    .run(kind, await resolveRepairScope(engine), { explicit: true, ...(shown.preview_hash ? { expect: shown.preview_hash } : {}) })
    .then(shape, (e: { code?: string }) => ({ refused: e.code ?? String(e) }));
  return { preview: shape(shown), applied };
}

async function put(engine: BrainEngine, slug: string, page_kind: 'markdown' | 'code', source_path?: string, frontmatter: Record<string, unknown> = {}) {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body.`, timeline: 'tl', page_kind, frontmatter,
    ...(source_path ? { source_path } : {}) }, { sourceId: 'default' });
}

describe('engine parity: repair page scans', () => {
  parityTest('safe-chunks and origin-twins plan from the same live pages on every engine', {
    methods: ['putPage', 'softDeletePage', 'listSafeChunksPending', 'listOriginTwinGroups', 'listLegacyOriginPairs', 'listLiveOriginPages', 'countLiveFileBackedPages'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await put(engine, 'notes/x-example', 'markdown', 'notes/x-example.md');
    await put(engine, 'scope/notes/x-example', 'markdown', 'scope/notes/x-example.md');
    await put(engine, 'code/bare-example', 'code');
    await put(engine, 'code/file-example', 'code', undefined, { file: 'src/file-example.ts' });
    await put(engine, 'notes/gone-example', 'markdown', 'notes/gone-example.md');
    await engine.softDeletePage('notes/gone-example', { sourceId: 'default' });
    const ids = Object.fromEntries((await engine.listLiveOriginPages('default', ['notes/x-example.md', 'scope/notes/x-example.md', 'notes/gone-example.md']))
      .map(row => [row.source_path, typeof row.id]));
    const pending = (await engine.listSafeChunksPending(['default'])).map(({ id, ...row }) => ({ id: typeof id, ...row }));
    const members = {
      pending, other: await engine.listSafeChunksPending(['other-example']),
      twins: await engine.listOriginTwinGroups('default', 10),
      pairs: (await engine.listLegacyOriginPairs('default', 'scope/', 10)).map(({ legacy_id, ...row }) => ({ legacy_id: typeof legacy_id, ...row })),
      capped: (await engine.listLegacyOriginPairs('default', 'scope/', 0)).length,
      none: await engine.listLegacyOriginPairs('default', 'nope/', 10),
      ids, fileBacked: await engine.countLiveFileBackedPages('default'),
    };
    return { members, safeChunks: shape(await preview(engine, 'safe-chunks')), originTwins: await previewThenApply(engine, 'origin-twins') };
  }));

  parityTest('listOriginClaimants reads the verdict inputs of live pages: body digest, frontmatter id, trust tier, privacy and withdrawals or purges', {
    methods: ['putPage', 'softDeletePage', 'insertFactWithdrawal', 'insertFactPurge', 'listRepairScanPages', 'listOriginClaimants'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await put(engine, 'notes/claim-plain', 'markdown', 'notes/claim-plain.md');
    await put(engine, 'notes/claim-id', 'markdown', 'notes/claim-id.md', { id: 'explicit-note-id' });
    await put(engine, 'notes/claim-private', 'markdown', 'notes/claim-private.md', { visibility: 'private' });
    await put(engine, 'notes/claim-withdrawn', 'markdown', 'notes/claim-withdrawn.md');
    await put(engine, 'notes/claim-purged', 'markdown', 'notes/claim-purged.md');
    await put(engine, 'notes/claim-gone', 'markdown', 'notes/claim-gone.md');
    await engine.putPage('notes/claim-same-body', { type: 'note', title: 'x', compiled_truth: 'notes/claim-plain body.', timeline: 'tl', frontmatter: {} }, { sourceId: 'default' });
    await engine.softDeletePage('notes/claim-gone', { sourceId: 'default' });
    await engine.insertFactWithdrawal('default', 'private', 'a withdrawn claim', 'notes/claim-withdrawn', null);
    await engine.insertFactPurge({ sourceId: 'default', visibility: 'world', subject: 'notes/claim-purged', factHash: 'f'.repeat(32), requestId: null, actor: null, reason: null } as never);
    const pages = await engine.listRepairScanPages('default', { afterId: 0, limit: 50 });
    const slugOf = new Map(pages.map(page => [Number(page.id), page.slug]));
    const rows = await engine.listOriginClaimants('default', [...slugOf.keys(), 999_999].reverse());
    const bySlug = Object.fromEntries(rows.map(row => [slugOf.get(row.id), { fm_id: row.fm_id, trust_tier: row.trust_tier, private: row.private, restricted: row.restricted, revision: typeof row.revision,
      digest: row.body_hash === null ? null : row.body_hash.length }]));
    const same = rows.filter(row => ['notes/claim-plain', 'notes/claim-same-body'].includes(slugOf.get(row.id)!)).map(row => row.body_hash);
    expect(same[0]).toBe(same[1]);
    expect(rows.map(row => row.id)).toEqual([...rows.map(row => row.id)].sort((a, b) => a - b));
    return { listed: rows.length, bySlug, other: await engine.listOriginClaimants('other-example', [...slugOf.keys()]), none: await engine.listOriginClaimants('default', []) };
  }));

  parityTest('ghost-pages and legacy-twins read the same pages for each scan shape on every engine', {
    methods: ['putPage', 'softDeletePage', 'listRepairScanPages', 'countLiveFileBackedPages'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await put(engine, 'notes/a-example', 'markdown', 'notes/a-example.md');
    await put(engine, 'notes/B-example', 'markdown');
    await put(engine, 'notes/b-example', 'markdown', 'notes/b-example.md');
    await put(engine, 'notes/c-example', 'markdown');
    await put(engine, 'notes/gone-example', 'markdown', 'notes/gone-example.md');
    const row = (r: Awaited<ReturnType<BrainEngine['listRepairScanPages']>>[number]) => ({ ...r, id: typeof r.id, revision: typeof r.revision,
      content_hash: typeof r.content_hash, request_id: r.request_id === null ? null : typeof r.request_id, updated_ms: typeof r.updated_ms });
    const before = await engine.listRepairScanPages('default', { afterId: 0, limit: 10 });
    const ids = Object.fromEntries(before.map(r => [r.slug, Number(r.id)]));
    await engine.softDeletePage('notes/gone-example', { sourceId: 'default' });
    return {
      before: before.map(row),
      all: (await engine.listRepairScanPages('default', { afterId: 0, limit: 10 })).map(r => r.slug),
      paged: (await engine.listRepairScanPages('default', { afterId: ids['notes/a-example']!, limit: 2 })).map(r => r.slug),
      legacy: (await engine.listRepairScanPages('default', { afterId: 0, limit: 10, legacy: true })).map(r => r.slug),
      bySlug: (await engine.listRepairScanPages('default', { slugs: ['notes/b-example', 'notes/B-example', 'notes/gone-example', 'notes/none-example'] })).map(r => r.slug),
      byId: (await engine.listRepairScanPages('default', { ids: [ids['notes/gone-example']!, ids['notes/c-example']!, 999_999] })).map(row),
      otherSource: await engine.listRepairScanPages('other-example', { afterId: 0, limit: 10 }),
      fileBacked: await engine.countLiveFileBackedPages('default'),
      nonBlank: await engine.countLiveFileBackedPages('default', { nonBlank: true }),
    };
  }));

  parityTest('the twin-merge conflict read names the same landing rows on every engine', {
    methods: ['putPage', 'addLink', 'addTimelineEntry', 'putRawData', 'listRepairScanPages', 'listTwinMergeLosers'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    for (const slug of ['notes/s-example', 'notes/t-example', 'notes/x-example', 'notes/y-example', 'notes/z-example']) {
      await put(engine, slug, 'markdown', `${slug}.md`);
    }
    const [s, t, x, y, z] = ['s', 't', 'x', 'y', 'z'].map(k => `notes/${k}-example`) as [string, string, string, string, string];
    // x: the same key and context (a quiet loser); y: the same key, another context; z: the twin's alone.
    await engine.addLink(s, x, 'c', 'mentions', 'markdown');
    await engine.addLink(t, x, 'c', 'mentions', 'markdown');
    await engine.addLink(s, y, 'c', 'mentions', 'markdown');
    await engine.addLink(t, y, 'other', 'mentions', 'markdown');
    await engine.addLink(t, z, 'c', 'mentions', 'markdown');
    // An edge only the origin moves: x -> z by way of the twin lands on x -> z by way of the survivor.
    await engine.addLink(x, z, 'c', 'mentions', 'frontmatter', s, 'related');
    await engine.addLink(x, z, 'c', 'mentions', 'frontmatter', t, 'related');
    // Between the pair: not a moving row.
    await engine.addLink(t, s, 'c', 'mentions', 'markdown');
    await engine.addTimelineEntry(s, { date: '2026-01-02', source: 'notes', summary: 'met', detail: 'one' });
    await engine.addTimelineEntry(t, { date: '2026-01-02', source: 'notes', summary: 'met', detail: 'two' });
    await engine.addTimelineEntry(t, { date: '2026-01-03', source: 'notes', summary: 'met', detail: 'two' });
    await engine.putRawData(s, 'api', { a: 1 });
    await engine.putRawData(t, 'api', { a: 2 });
    await engine.putRawData(s, 'same', { a: 1 });
    await engine.putRawData(t, 'same', { a: 1 });
    const ids = Object.fromEntries((await engine.listRepairScanPages('default', { afterId: 0, limit: 10 })).map(r => [r.slug, Number(r.id)]));
    const losers = await engine.listTwinMergeLosers(ids[s]!, ids[t]!);
    expect(losers.links.map(l => [l.link_source, l.same])).toEqual([['markdown', true], ['markdown', false], ['frontmatter', true]]);
    expect(losers.timeline).toHaveLength(1);
    expect(losers.raw_data).toEqual([{ source: 'api' }]);
    const ascending = (rows: { id: number }[]) => rows.every((r, i) => i === 0 || rows[i - 1]!.id < r.id);
    return {
      links: losers.links.map(l => ({ link_source: l.link_source, same: l.same, id: typeof l.id })),
      linksAscending: ascending(losers.links),
      transitions: losers.transitions,
      timeline: losers.timeline.map(r => typeof r.id),
      raw_data: losers.raw_data,
      noPair: await engine.listTwinMergeLosers(ids[s]!, 999_999),
    };
  }));

  parityTest('uncommitted-deletions reads the same file tombstones on every engine', {
    methods: ['putPage', 'softDeletePage', 'writeOpCheckpointRecord', 'listFileTombstones'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await put(engine, 'notes/a-example', 'markdown', 'notes/a-example.md');
    await put(engine, 'notes/b-example', 'markdown', 'notes/b-example.md');
    await put(engine, 'notes/blank-example', 'markdown', '  ');
    await put(engine, 'notes/none-example', 'markdown');
    await put(engine, 'notes/live-example', 'markdown', 'notes/live-example.md');
    for (const slug of ['notes/a-example', 'notes/b-example', 'notes/blank-example', 'notes/none-example']) {
      await engine.softDeletePage(slug, { sourceId: 'default' });
    }
    const all = await engine.listFileTombstones('default', { before: null, limit: 10 });
    // A tombstone record at another time than the page's deleted_at does not mark it as a sync deletion.
    await engine.writeOpCheckpointRecord('sync-delete-tombstone', String(all[0]!.id), [{ deleted_at: '2001-01-01T00:00:00+00:00' }]);
    const row = (r: (typeof all)[number]) => ({ ...r, id: typeof r.id, revision: typeof r.revision, deleted_at: typeof r.deleted_at });
    return {
      all: (await engine.listFileTombstones('default', { before: null, limit: 10 })).map(row),
      descending: all.every((r, i) => i === 0 || all[i - 1]!.id > r.id),
      isoMs: all.every(r => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.deleted_at)),
      below: (await engine.listFileTombstones('default', { before: all[0]!.id, limit: 10 })).map(r => r.slug),
      capped: (await engine.listFileTombstones('default', { before: null, limit: 1 })).map(r => r.slug),
      otherSource: await engine.listFileTombstones('other-example', { before: null, limit: 10 }),
      preview: shape(await preview(engine, 'uncommitted-deletions')),
    };
  }));
});
