/**
 * BrainEngine parity — the page repair reads of the access and orphan-children kinds and of the origin index
 * (batch 3 of the repair-on-Rust plan).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `gbrain repair access` and `gbrain repair orphan-children` give the same preview and the same apply
 *    result on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), and doctor's
 *    `access_page_readers_backfill`, `child_table_orphans` and `origin_twins` checks report the same status, message
 *    and details, on a brain whose pages name readers, carry child rows and record file origins.
 *  - Regression: each read ran through `executeRaw`, which a Rust brain refuses, so both kinds stopped before their
 *    first read there and the three doctor checks warned with the refusal instead of PGLite's answer.
 *  - Why existing coverage misses it: the kinds' own tests (test/access-repair.test.ts,
 *    test/repair-orphan-children-5216.test.ts, test/doctor-child-orphans.test.ts, test/e2e/origin-twins-6948.test.ts)
 *    run on PGLite or Postgres only, and test/rust-cli-parity.serial.test.ts lists doctor differences, not equality.
 *  - Seam: none. Generated values (the brain id, timestamps) are compared by shape.
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
import { PAGE_CHILD_FK_TARGETS } from '../../src/core/repair/orphan-children.ts';
import { childTableOrphansCheck } from '../../src/commands/doctor/checks/core-health.ts';
import { backfill } from '../../src/commands/doctor/checks/member-access.ts';
import { originTwinsEntry } from '../../src/commands/doctor/checks/origin-twins.ts';
import type { DoctorContext, DoctorEntry } from '../../src/commands/doctor/context.ts';

const { parityTest } = parityArms(testBackends());

const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?\b/g;

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  return JSON.parse(JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(ISO, '<ts>'));
}

const quiet = { info() {}, warn() {}, error() {} } as never;

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-page-reads-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Preview, then apply what the preview printed (bound by its hash), as `gbrain repair <kind>` and `--apply --expect` do. */
async function previewThenApply(engine: BrainEngine, kind: RepairKind) {
  const scope = await resolveRepairScope(engine);
  const preview = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run(kind, scope, { explicit: true });
  const applied = await (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet }))
    .run(kind, scope, { explicit: true, ...(preview.preview_hash ? { expect: preview.preview_hash } : {}) })
    .then(shape, (e: { code?: string }) => ({ refused: e.code ?? String(e) }));
  return { preview: shape(preview), applied };
}

/** The named doctor checks, as `gbrain doctor --json` prints them. */
async function doctorChecks(engine: BrainEngine, entry: DoctorEntry, names: string[]) {
  const checks = await entry.run({ engine } as DoctorContext);
  return (Array.isArray(checks) ? checks : []).filter(c => names.includes(c.name));
}

/** Two pages that name readers, one with a file origin, linked and tagged, with a timeline; a third deleted. */
async function seed(engine: BrainEngine) {
  await engine.putPage('notes/shared-example', { type: 'note', title: 'Shared', compiled_truth: 'Shared with one member.', timeline: '',
    frontmatter: { readable_by: ['alice-example'] } }, { sourceId: 'default' });
  await engine.putPage('notes/team-example', { type: 'note', title: 'Team', compiled_truth: 'Shared with a group. See [[notes/shared-example]].',
    timeline: '- 2026-01-02: Written.', frontmatter: { readable_by: 'group:team-a' }, source_path: 'notes/team-example.md' } as never, { sourceId: 'default' });
  await engine.putPage('notes/gone-example', { type: 'note', title: 'Gone', compiled_truth: 'Removed below.', timeline: '' }, { sourceId: 'default' });
  await engine.addTag('notes/team-example', 'team');
  await engine.addTag('notes/gone-example', 'gone');
  await engine.addLink('notes/team-example', 'notes/shared-example', 'mention', 'mention');
  await engine.addLink('notes/gone-example', 'notes/shared-example', 'mention', 'mention');
  await engine.deletePage('notes/gone-example', { sourceId: 'default' });
}

describe('engine parity: page repair reads', () => {
  parityTest('repair access finds no page whose stored readers differ from its frontmatter, and doctor agrees', {
    methods: ['putPage', 'listAccessReaderDrift', 'countAccessReaderDrift', 'deriveAccessReaders'], timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await seed(engine);
    const listed = await engine.listAccessReaderDrift(['default'], 0);
    const counted = await engine.countAccessReaderDrift();
    const page = await engine.getPage('notes/shared-example', { sourceId: 'default' });
    const derived = await engine.deriveAccessReaders(page!.id);
    // The check alone: the entry's other three checks still read through executeRaw on Rust.
    const doctor = await backfill(engine);
    return { listed, counted, derived, doctor, ...(await previewThenApply(engine, 'access')) };
  }));

  parityTest('repair orphan-children finds no orphan child row and no torn body after a page is deleted, and doctor agrees', {
    methods: ['putPage', 'deletePage', 'countPageChildOrphans', 'clearPageChildOrphans', 'probeTornPages', 'countOrphanChunks'], timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await seed(engine);
    const counts = await Promise.all(PAGE_CHILD_FK_TARGETS.map(async t => [`${t.table}.${t.col}`, await engine.countPageChildOrphans(t)]));
    const cleared = await Promise.all(PAGE_CHILD_FK_TARGETS.map(t => engine.clearPageChildOrphans(t)));
    const torn = await engine.probeTornPages();
    const unlisted = await engine.countPageChildOrphans({ table: 'pages', col: 'id' }).then(String, (e: Error) => e.message);
    return { counts, cleared, torn, unlisted, doctor: await childTableOrphansCheck(engine), ...(await previewThenApply(engine, 'orphan-children')) };
  }));

  parityTest('doctor origin_twins reads the origin index present and no duplicate-origin group', {
    methods: ['putPage', 'readOriginIndexState', 'listOriginTwinCounts'], timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await seed(engine);
    return {
      state: await engine.readOriginIndexState(),
      groups: await engine.listOriginTwinCounts(50),
      doctor: await doctorChecks(engine, originTwinsEntry, ['origin_twins']),
    };
  }));
});
