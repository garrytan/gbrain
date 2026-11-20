/**
 * BrainEngine parity — the alias targets of `gbrain repair aliases` and doctor's `dangling_aliases` check
 * (batch 3 of the repair-on-Rust plan).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain where one page was renamed and then deleted, one page is soft-deleted and one is live, each
 *    with page aliases, `gbrain repair aliases` gives the same preview, the same apply result and the same alias rows
 *    afterwards on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), and
 *    `dangling_aliases` reports the same status, message and details before and after.
 *  - Regression: the plan, the apply and the doctor check ran through `executeRaw`, which a Rust brain refuses, so the
 *    kind stopped before its first read there and the check warned "Dangling aliases unknown".
 *  - Why existing coverage misses it: test/purge-aliases-6619.test.ts runs on PGLite only, and
 *    test/rust-cli-parity.serial.test.ts lists doctor differences, not equality.
 *  - Seam: none. Generated values (the brain id, timestamps, hashes) are compared by shape.
 */
import { describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { checkDanglingAliases } from '../../src/core/onboard/checks.ts';

const { parityTest } = parityArms(testBackends());

const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?\b/g;

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  return JSON.parse(JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(ISO, '<ts>'));
}

const quiet = { info() {}, warn() {}, error() {} } as never;

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-aliases-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Preview, then apply what the preview printed (bound by its hash), as `gbrain repair aliases` and `--apply --expect` do. */
async function previewThenApply(engine: BrainEngine) {
  const scope = await resolveRepairScope(engine);
  const preview = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run('aliases', scope, { explicit: true });
  const applied = await (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet }))
    .run('aliases', scope, { explicit: true, ...(preview.preview_hash ? { expect: preview.preview_hash } : {}) })
    .then(shape, (e: { code?: string }) => ({ refused: e.code ?? String(e) }));
  return { preview: shape(preview), applied };
}

async function put(engine: BrainEngine, slug: string, aliases: string[]) {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body.`, timeline: '' }, { sourceId: 'default' });
  await engine.setPageAliases(slug, 'default', aliases);
}

describe('engine parity: alias targets', () => {
  parityTest('repair aliases deletes the aliases of a deleted page, keeps a soft-deleted and a live page\'s, and doctor agrees', {
    methods: ['putPage', 'setPageAliases', 'updateSlug', 'softDeletePage', 'deletePage', 'listAliasTargets', 'deleteOrphanedAliases'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    // notes/old-example is renamed to notes/moved-example, leaving a slug redirect that resolves to the new slug.
    await engine.putPage('notes/old-example', { type: 'note', title: 'Old', compiled_truth: 'Renamed below.', timeline: '' }, { sourceId: 'default' });
    await engine.updateSlug('notes/old-example', 'notes/moved-example', { sourceId: 'default' });
    await engine.setPageAliases('notes/moved-example', 'default', ['moved one', 'moved two']);
    await put(engine, 'notes/soft-example', ['soft one']);
    await engine.softDeletePage('notes/soft-example', { sourceId: 'default' });
    await put(engine, 'notes/live-example', ['live one']);
    await engine.deletePage('notes/moved-example', { sourceId: 'default' });
    const before = { all: await engine.listAliasTargets(null), none: await engine.listAliasTargets([]),
      scoped: await engine.listAliasTargets(['default']), doctor: (await checkDanglingAliases(engine)).check };
    // A page row, soft-deleted or live, keeps every alias row.
    const kept = [await engine.deleteOrphanedAliases('default', 'notes/soft-example'), await engine.deleteOrphanedAliases('default', 'notes/live-example')];
    const repair = await previewThenApply(engine);
    const after = { all: await engine.listAliasTargets(null), doctor: (await checkDanglingAliases(engine)).check,
      again: await engine.deleteOrphanedAliases('default', 'notes/moved-example'),
      live: Object.fromEntries(await engine.resolveAliases(['live one'], { sourceIds: ['default'] })) };
    return { before, kept, repair, after };
  }));
});
