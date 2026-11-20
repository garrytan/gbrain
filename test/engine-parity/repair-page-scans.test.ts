/**
 * BrainEngine parity — the page scans of `gbrain repair safe-chunks` and `gbrain repair origin-twins` (batch 3 of the
 * repair-on-Rust plan).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain with markdown pages, code pages with and without a file, a soft-deleted page and a page whose
 *    origin is another page's origin under a legacy `scope/` prefix, the five scan members return the same rows, and
 *    the safe-chunks preview plus the origin-twins preview and apply give the same result, on PGLite, Postgres
 *    (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: both plans read through `executeRaw`, which a Rust brain refuses, so each kind stopped before its first
 *    read there. The legacy-pair read also had no ORDER BY under its LIMIT, so the pairs it kept were not fixed.
 *  - Why existing coverage misses it: test/repair-safe-chunks*.test.ts and test/origin-twins*.test.ts run on PGLite
 *    or Postgres only.
 *  - Seam: none. The safe-chunks apply re-seals chunks, a write that moves in batch 6, so this case previews it only.
 *    Generated values (the brain id, timestamps, hashes) are compared by shape.
 */
import { describe } from 'bun:test';
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
});
