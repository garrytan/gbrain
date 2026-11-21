/**
 * BrainEngine parity: the doctor health reads of engine-sql/doctor-health.ts (calibration, remote report, catalog and
 * request-index checks) and the doctor checks and ops route that read them.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts), so a doctor check reports the same finding on each. The catalog
 *    checks have two cases each: (a) a fresh brain, compared on all three arms; (b) a brain whose schema drifted, which
 *    only the SQL engines can have: PGLite and Postgres seed the drift with harness-only DDL and pin the finding, and
 *    the Rust arm pins the answer its key layout gives (never a skip).
 *  - Regression: an engine whose read drifts, refuses on raw SQL, or answers a silent empty where the SQL engines count
 *    rows gives a different doctor status, message or details per backend.
 *  - Why existing coverage misses it: the doctor check tests run these checks on PGLite only, and the Rust arm skipped
 *    the catalog checks (`catalogSkipCheck`) or stopped on the raw SQL refusal.
 *  - Seam: typed members, seeded through typed writers; the drift fixtures of the (b) cases are DDL behind the backend
 *    switch, restored before the case ends.
 *
 * Request indexes: the Rust store has no request-table index (it finds a request by a full scan of its request keys), so
 * none can be missing or INVALID and `readRequestIndexStates` answers each named index valid. Doctor and
 * `repair request-indexes` print what a healthy PGLite brain prints; the scan's speed loss is row 20 of "Open before
 * `rust` can be selected" in docs/designs/RUST_ENGINE.md, not a doctor finding.
 *
 * Known stop on Rust: the full `repair request-indexes` run (preview and apply) gets past the index states and stops on
 * the repair core's own raw SQL, its cursor read on op_checkpoints (src/core/repair/core.ts readCursor). The case pins
 * that refusal and ends on it, so the harness counts it stopped. Lane 10 (rust-engine/repair-rust) types that core;
 * whichever of rust-engine/doctor-checks-3 and rust-engine/repair-rust lands second removes the pin.
 *
 * Links table on Rust: the Rust engine answers a catalog probe for the links table from the `links` capability
 * (store-members/catalog.ts TABLE_CAPABILITY), and reports a capability only when every member of the family is served.
 * The edge-proposal members (rust-engine/main 0895649aab) still refuse, so `links` is not reported and
 * links_link_source_check prints "no links table yet" (status ok) on Rust, though the links store holds links and
 * refuses a non-kebab link_source on every write. The (a) case compares name, status and the written links on all arms
 * and pins the message per arm; when the family is served again the Rust message changes and the case names the pin.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { checkAbandonedThreads, checkContextualRetrievalCoverage, checkGradeConfidenceDrift } from '../../src/commands/doctor/checks/calibration.ts';
import { checkSchemaPackSourceDrift } from '../../src/commands/doctor/schema-pack-checks.ts';
import { linkSourceCheckConstraintCheck, pagesUpsertArbiterCheck } from '../../src/commands/doctor/checks/core-health.ts';
import { requestIndexesCheck } from '../../src/commands/doctor/checks/persistence-requests.ts';
import { checkBrainstormHealth } from '../../src/commands/doctor/checks/graph-embedding.ts';
import { checkTimelineDedupIndex } from '../../src/core/timeline-dedup-repair.ts';
import { readCapacityView } from '../../src/core/persistence/capacity-view.ts';
import { cachedOpsSnapshot } from '../../src/commands/doctor/ops-snapshot.ts';
import { PERSISTENCE_REQUEST_ID_INDEX, PERSISTENCE_REQUEST_ONLINE_INDEXES } from '../../src/core/persistence/schema.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { resolveRepairScope, runRepair } from '../../src/core/repair/core.ts';
import { requestIndexesRepair } from '../../src/core/repair/request-indexes.ts';
import { renderRepairResult } from '../../src/commands/repair.ts';

const { parityTest } = parityArms(testBackends());

/** The pin's failure once the repair core is typed (the known stop in the header). */
const REPAIR_CORE_STOP_LIFTED = 'lane 10 rust-engine/repair-rust 8982a86c49 typed readOpCheckpointRecord/writeOpCheckpointRecord/readCounterRows: '
  + 'remove this pin and compare the printed output on 3 arms';

/** Read when a links_link_source_check message changes on Rust: the links family is reported again, so drop the pin. */
const LINKS_CAPABILITY_LIFTED = 'the Rust links capability is withheld while the edge-proposal members of rust-engine/main 0895649aab refuse: when they are served, the Rust message becomes the v114 one; remove linkSourceGateMessage and compare the whole check on 3 arms';

/** The links_link_source_check message each arm prints on a fresh brain (the Rust one: see "Links table on Rust" above). */
function linkSourceGateMessage(backend: string): string {
  return backend === 'rust' ? 'no links table yet' : 'links_link_source_check has the v114 kebab-case gate';
}

const OTHER = 'other-source';

async function put(engine: BrainEngine, slug: string, extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}): Promise<number> {
  const page = await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '', ...extra } as never, opts as never);
  return Number(page.id);
}

/** Runs `fn` with a schema drift in place, and puts the schema back before returning. */
async function withDrift<T>(engine: BrainEngine, drift: string[], restore: string[], fn: () => Promise<T>): Promise<T> {
  for (const statement of drift) await engine.executeRaw(statement);
  try {
    return await fn();
  } finally {
    for (const statement of restore) await engine.executeRaw(statement);
  }
}

describe('doctor health reads', () => {
  parityTest(
    'contextual_retrieval_coverage counts chunker drift, unsealed pages and unstamped markdown per source',
    { methods: ['insertSource', 'putPage', 'softDeletePage', 'countContextualRetrievalCoverage'] },
    async (engine) => {
      const empty = await checkContextualRetrievalCoverage(engine);
      await engine.insertSource({ id: OTHER, name: OTHER, local_path: null, config: {} });
      await put(engine, 'notes/old', { chunker_version: 1 });
      await put(engine, 'notes/stamped', { chunker_version: 4 }, { contextualRetrieval: { mode: 'title', corpusGeneration: null } });
      await put(engine, 'notes/receipt', { type: 'extract_receipt', chunker_version: 4 });
      await put(engine, 'src/main-ts', { page_kind: 'code', chunker_version: 2, frontmatter: { file: 'src/main.ts' } });
      await put(engine, 'notes/gone', { chunker_version: 1 });
      await engine.softDeletePage('notes/gone');
      await put(engine, 'notes/elsewhere', { chunker_version: 1 }, { sourceId: OTHER });
      const all = await engine.countContextualRetrievalCoverage(99);
      const current = await engine.countContextualRetrievalCoverage(1);
      const scoped = await engine.countContextualRetrievalCoverage(99, ['default']);
      const nowhere = await engine.countContextualRetrievalCoverage(99, ['nowhere']);
      expect(nowhere).toEqual({ chunker_drift: 0, unsealed: 0, unsealed_code: 0, mode_null: 0 });
      const check = await checkContextualRetrievalCoverage(engine, { sourceIds: ['default'] });
      return { empty, all, current, scoped, nowhere, check };
    },
  );

  parityTest(
    'abandoned_threads counts old high-conviction takes nobody revisited, by page source',
    { methods: ['insertSource', 'putPage', 'addTakesBatch', 'resolveTake', 'countAbandonedThreads'] },
    async (engine) => {
      const empty = await checkAbandonedThreads(engine);
      await engine.insertSource({ id: OTHER, name: OTHER, local_path: null, config: {} });
      const page = await put(engine, 'notes/takes');
      const elsewhere = await put(engine, 'notes/other-takes', {}, { sourceId: OTHER });
      const take = (row: number, extra: Record<string, unknown>) => ({ page_id: page, row_num: row, claim: `claim ${row}`, kind: 'take', holder: 'h', ...extra });
      await engine.addTakesBatch([
        take(1, { weight: 0.9, since_date: '2020-01-15' }),
        take(2, { weight: 0.9, since_date: '2020-03' }),
        take(3, { weight: 0.7, since_date: '2020-01-15' }), // real 0.7 widens below 0.7
        take(4, { weight: 0.5, since_date: '2020-01-15' }),
        take(5, { weight: 0.9, since_date: '2099-01-01' }),
        take(6, { weight: 0.9 }),
        take(7, { weight: 0.9, since_date: '2020-01-15', active: false }),
        take(8, { weight: 0.9, since_date: '2020-01-15', superseded_by: 1 }),
        take(9, { weight: 0.9, since_date: '2020-01-15' }),
      ] as never);
      await engine.resolveTake(page, 9, { quality: 'correct', resolvedBy: 'tester' } as never);
      await engine.addTakesBatch([{ page_id: elsewhere, row_num: 1, claim: 'other', kind: 'take', holder: 'h', weight: 0.9, since_date: '2020-01-15' }] as never);
      const all = await engine.countAbandonedThreads();
      const scoped = await engine.countAbandonedThreads(['default']);
      const nowhere = await engine.countAbandonedThreads(['nowhere']);
      expect({ all, scoped, nowhere }).toEqual({ all: 3, scoped: 2, nowhere: 0 });
      const check = await checkAbandonedThreads(engine, { sourceIds: ['default'] });
      return { empty, all, scoped, nowhere, check };
    },
  );

  parityTest(
    'chronicle projection health counts projections of soft-deleted event pages, by event source',
    { methods: ['putPage', 'upsertEventProjection', 'softDeletePage', 'countOrphanedEventProjections'] },
    async (engine) => {
      const empty = await engine.countOrphanedEventProjections();
      await put(engine, 'people/alice-example');
      await put(engine, 'life/events/2026-02-01-001', { type: 'event', frontmatter: { event: { kind: 'meeting' } } });
      await put(engine, 'life/events/2026-02-02-001', { type: 'event', frontmatter: { event: { kind: 'meeting' } } });
      await engine.upsertEventProjection({ depthSlug: 'people/alice-example', eventSlug: 'life/events/2026-02-01-001', date: '2026-02-01', summary: 'Met' });
      await engine.upsertEventProjection({ depthSlug: 'people/alice-example', eventSlug: 'life/events/2026-02-02-001', date: '2026-02-02', summary: 'Kept' });
      const live = await engine.countOrphanedEventProjections();
      await engine.softDeletePage('life/events/2026-02-01-001');
      const orphaned = await engine.countOrphanedEventProjections();
      const scoped = await engine.countOrphanedEventProjections(['default']);
      const nowhere = await engine.countOrphanedEventProjections(['nowhere']);
      expect({ empty, live, orphaned, scoped, nowhere }).toEqual({ empty: 0, live: 0, orphaned: 1, scoped: 1, nowhere: 0 });
      return { empty, live, orphaned, scoped, nowhere };
    },
  );

  parityTest(
    'grade_confidence_drift (a): a fresh brain has no applied verdicts',
    { methods: ['countAppliedGradeVerdicts'] },
    async (engine) => {
      const check = await checkGradeConfidenceDrift(engine);
      const scoped = await engine.countAppliedGradeVerdicts(['default']);
      return { check, scoped };
    },
  );

  parityTest(
    'grade_confidence_drift (b): applied verdicts count on the SQL engines; Rust holds none',
    { methods: ['countAppliedGradeVerdicts'] },
    async (engine, backend) => {
      if (backend === 'rust') {
        // The store keeps no take_grade_cache, and grade-takes writes it through raw SQL, which Rust refuses.
        expect(await checkGradeConfidenceDrift(engine)).toEqual({ name: 'grade_confidence_drift', status: 'ok', message: 'Only 0 auto-applied verdicts — need 30+ for drift detection' });
        return 'pinned';
      }
      const page = await put(engine, 'notes/graded');
      await engine.addTakesBatch([{ page_id: page, row_num: 1, claim: 'graded', kind: 'take', holder: 'h', weight: 0.9 }] as never);
      const [take] = await engine.executeRaw<{ id: number }>(`SELECT id FROM takes WHERE page_id = $1`, [page]);
      await engine.executeRaw(`INSERT INTO take_grade_cache (take_id, prompt_version, judge_model_id, evidence_signature, verdict, confidence, applied)
        VALUES ($1, 'p1', 'judge', 'e1', 'correct', 0.9, true), ($1, 'p1', 'judge', 'e2', 'correct', 0.9, false)`, [take!.id]);
      expect(await checkGradeConfidenceDrift(engine)).toEqual({ name: 'grade_confidence_drift', status: 'ok', message: 'Only 1 auto-applied verdicts — need 30+ for drift detection' });
      expect(await engine.countAppliedGradeVerdicts([OTHER])).toBe(0);
      return 'pinned';
    },
  );

  parityTest(
    'schema_pack_source_drift reads the per-source pack overrides, scoped to the caller sources',
    { methods: ['setConfig', 'listConfigKeys', 'getConfigValues'] },
    async (engine) => {
      const none = await checkSchemaPackSourceDrift(engine);
      await engine.setConfig('schema_pack.source.default', 'pack-a');
      await engine.setConfig(`schema_pack.source.${OTHER}`, 'pack-b');
      await engine.setConfig('schema_pack.sources', 'not-an-override');
      const diverged = await checkSchemaPackSourceDrift(engine);
      const scoped = await checkSchemaPackSourceDrift(engine, { sourceIds: ['default'] });
      const nowhere = await checkSchemaPackSourceDrift(engine, { sourceIds: ['nowhere'] });
      expect(diverged.status).toBe('warn');
      return { none, diverged, scoped, nowhere };
    },
  );
});

describe('doctor catalog checks', () => {
  parityTest(
    'pages_upsert_arbiter (a): a fresh brain has the (source_id, slug) arbiter',
    { methods: ['readPagesUpsertArbiter'] },
    async (engine) => ({ check: await pagesUpsertArbiterCheck(engine), read: await engine.readPagesUpsertArbiter() }),
  );

  parityTest(
    'pages_upsert_arbiter (b): a dropped arbiter fails on the SQL engines; Rust keys pages by (source, slug)',
    { methods: ['readPagesUpsertArbiter'] },
    async (engine, backend) => {
      // Rust: keys.rs keys::page is (source, slug); pages.rs store_page writes that one key; page_body.rs refuses a
      // taken pair with the pages_source_slug_key error; pages.rs rename_page refuses a taken slug and deletes the old
      // key (store test a_source_and_slug_hold_one_page_record). So the arbiter is present with no duplicate group.
      if (backend === 'rust') {
        expect(await engine.readPagesUpsertArbiter()).toEqual({ tablePresent: true, arbiterPresent: true, duplicateGroups: 0 });
        expect(await pagesUpsertArbiterCheck(engine)).toEqual({ name: 'pages_upsert_arbiter', status: 'ok', message: 'pages has the UNIQUE(source_id, slug) upsert arbiter' });
        return 'pinned';
      }
      await put(engine, 'notes/a');
      await withDrift(engine, ['ALTER TABLE pages DROP CONSTRAINT pages_source_slug_key'],
        ['ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug)'], async () => {
          expect(await engine.readPagesUpsertArbiter()).toEqual({ tablePresent: true, arbiterPresent: false, duplicateGroups: 0 });
          const check = await pagesUpsertArbiterCheck(engine);
          expect({ name: check.name, status: check.status }).toEqual({ name: 'pages_upsert_arbiter', status: 'fail' });
          expect(check.message).toContain('pages is missing the UNIQUE(source_id, slug) arbiter');
        });
      return 'pinned';
    },
  );

  parityTest(
    'links_link_source_check (a): a fresh brain has the kebab-case gate, and a kebab provenance link is written',
    { methods: ['putPage', 'addLink', 'getLinks'] },
    async (engine, backend) => {
      await put(engine, 'concepts/from');
      await put(engine, 'notes/to');
      await engine.addLink('concepts/from', 'notes/to', '', 'synthesized_from', 'concept-provenance');
      const links = (await engine.getLinks('concepts/from')).map(l => ({ to: l.to_slug, source: l.link_source }));
      const check = await linkSourceCheckConstraintCheck(engine);
      expect({ backend, message: check.message, lifted: LINKS_CAPABILITY_LIFTED })
        .toEqual({ backend, message: linkSourceGateMessage(backend), lifted: LINKS_CAPABILITY_LIFTED });
      return { check: { name: check.name, status: check.status }, links };
    },
  );

  parityTest(
    'links_link_source_check (b): a dropped gate warns on the SQL engines; the Rust links store enforces it on every write',
    { methods: ['putPage', 'addLink'] },
    async (engine, backend) => {
      await put(engine, 'concepts/from');
      await put(engine, 'notes/to');
      // Rust: rust/crates/gbrain-store/src/links.rs valid_link_source checks every link_source write.
      if (backend === 'rust') {
        const refused = await engine.addLink('concepts/from', 'notes/to', '', 'cites', 'Not Kebab').then(() => null, (e: Error) => e.message);
        expect(refused).not.toBeNull();
        expect({ check: await linkSourceCheckConstraintCheck(engine), lifted: LINKS_CAPABILITY_LIFTED })
          .toEqual({ check: { name: 'links_link_source_check', status: 'ok', message: linkSourceGateMessage(backend) }, lifted: LINKS_CAPABILITY_LIFTED });
        return 'pinned';
      }
      const [row] = await engine.executeRaw<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = to_regclass('links') AND conname = 'links_link_source_check'`);
      await withDrift(engine, ['ALTER TABLE links DROP CONSTRAINT links_link_source_check'],
        [`ALTER TABLE links ADD CONSTRAINT links_link_source_check ${row!.def}`], async () => {
          await engine.addLink('concepts/from', 'notes/to', '', 'synthesized_from', 'concept-provenance');
          const check = await linkSourceCheckConstraintCheck(engine);
          expect({ name: check.name, status: check.status }).toEqual({ name: 'links_link_source_check', status: 'warn' });
          expect(check.message).toContain('links_link_source_check is absent');
        });
      return 'pinned';
    },
  );

  parityTest(
    'timeline dedup index (a): a fresh brain has the four-column dedup index',
    { methods: ['readTimelineDedupIndex'] },
    async (engine) => ({ status: await checkTimelineDedupIndex(engine), read: await engine.readTimelineDedupIndex() }),
  );

  parityTest(
    'timeline dedup index (b): a three-column index needs repair on the SQL engines; Rust dedups on all four columns',
    { methods: ['readTimelineDedupIndex'] },
    async (engine, backend) => {
      // Rust: rust/crates/gbrain-store/src/timeline.rs keys the dedup on (page_id, date, md5(summary), source).
      if (backend === 'rust') {
        expect(await checkTimelineDedupIndex(engine)).toEqual({ tablePresent: true, indexPresent: true, columns: ['page_id', 'date', 'md5(summary)', 'source'], needsRepair: false });
        return 'pinned';
      }
      const { indexdef } = await engine.readTimelineDedupIndex();
      await withDrift(engine, ['DROP INDEX idx_timeline_dedup', 'CREATE UNIQUE INDEX idx_timeline_dedup ON timeline_entries (page_id, date, summary)'],
        ['DROP INDEX idx_timeline_dedup', indexdef!], async () => {
          expect(await checkTimelineDedupIndex(engine)).toEqual({ tablePresent: true, indexPresent: true, columns: ['page_id', 'date', 'summary'], needsRepair: true });
        });
      return 'pinned';
    },
  );

  parityTest(
    'persistence_request_indexes (a): every request index reads valid, so doctor prints the same ok on every engine',
    { methods: ['readRequestIndexStates'] },
    async (engine) => {
      // Rust has no request-table index to leave missing or INVALID (it finds a request by a full scan of keys::REQUEST,
      // persistence.rs all_requests), so it answers each named index valid; the scan's speed loss is RUST_ENGINE.md row 20.
      const check = await requestIndexesCheck(engine);
      expect(check.status).toBe('ok');
      return { check, states: await engine.readRequestIndexStates(PERSISTENCE_REQUEST_ONLINE_INDEXES.map(i => i.name)) };
    },
  );

  parityTest(
    'persistence_request_indexes (b): a dropped request index warns on the SQL engines; Rust has none to drop and stays ok',
    { methods: ['readRequestIndexStates'] },
    async (engine, backend) => {
      if (backend === 'rust') {
        expect((await requestIndexesCheck(engine)).status).toBe('ok');
        expect(await engine.readRequestIndexStates([PERSISTENCE_REQUEST_ID_INDEX.name]))
          .toEqual([{ name: PERSISTENCE_REQUEST_ID_INDEX.name, valid: true, phase: null, blocks_done: null, blocks_total: null }]);
        return 'pinned';
      }
      const [row] = await engine.executeRaw<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [PERSISTENCE_REQUEST_ID_INDEX.name]);
      await withDrift(engine, [`DROP INDEX ${PERSISTENCE_REQUEST_ID_INDEX.name}`], [row!.indexdef], async () => {
        const check = await requestIndexesCheck(engine);
        expect(check.status).toBe('warn');
        expect(check.message).toContain(`${PERSISTENCE_REQUEST_ID_INDEX.name} is missing`);
      });
      return 'pinned';
    },
  );

  parityTest(
    'repair request-indexes plans nothing to build on a healthy brain, the same on every engine',
    { methods: ['readRequestIndexStates'] },
    async (engine) => {
      // Every engine serves the index states, so a typed refusal here is a failure, not a Rust "refused" outcome.
      const plan = await requestIndexesRepair.plan(engine, { brain_id: 'host', source_ids: ['default'] }, null)
        .catch((error: unknown) => { throw new Error(`the request-indexes plan did not read the index states: ${(error as Error).message}`); });
      expect(plan.items).toEqual([]);
      return plan;
    },
  );

  parityTest(
    'repair request-indexes previews and applies nothing on a healthy brain, with the same output on every engine',
    { methods: ['readRequestIndexStates'] },
    async (engine, backend) => {
      const ctx = { engine, config: {}, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const scope = await resolveRepairScope(engine);
      if (backend === 'rust') {
        // Known stop on Rust (see the header): the run ends on the repair core's cursor read, raw SQL on op_checkpoints.
        const stop: unknown = await runRepair(ctx, requestIndexesRepair, scope, { apply: false }).then(() => null, (error: unknown) => error);
        const atReadCursor = isCapabilityRefusal(stop, 'raw_sql') && /at readCursor \([^)]*src\/core\/repair\/core\.ts:/.test((stop as Error).stack ?? '');
        if (!atReadCursor) throw new Error(`${REPAIR_CORE_STOP_LIFTED} (the run ${stop === null ? 'finished' : `ended on: ${(stop as Error).message}`})`);
        throw stop;
      }
      const preview = await runRepair(ctx, requestIndexesRepair, scope, { apply: false });
      const applied = await runRepair(ctx, requestIndexesRepair, scope, { apply: true });
      expect({ affected: applied.affected, applied: applied.applied, failed: applied.failed, complete: applied.complete }).toEqual({ affected: 0, applied: 0, failed: [], complete: true });
      return { preview: renderRepairResult(preview), applied: renderRepairResult(applied) };
    },
  );

  parityTest(
    'brainstorm_health (a): the retrieval tracking column is present on every engine',
    { methods: ['readRetrievalTrackingColumn'] },
    async (engine) => {
      const check = await checkBrainstormHealth(engine);
      expect(check.status).toBe('ok');
      return { check, column: await engine.readRetrievalTrackingColumn() };
    },
  );

  parityTest(
    'brainstorm_health (b): a missing column warns on the SQL engines; the Rust store records retrievals',
    { methods: ['readRetrievalTrackingColumn'] },
    async (engine, backend) => {
      // Rust: rust/crates/gbrain-store/src/page_ops/retrievals.rs records each page retrieval (bumpPageRetrievals).
      if (backend === 'rust') {
        expect(await engine.readRetrievalTrackingColumn()).toBe(true);
        return 'pinned';
      }
      await withDrift(engine, ['ALTER TABLE pages RENAME COLUMN last_retrieved_at TO last_retrieved_at_parity'],
        ['ALTER TABLE pages RENAME COLUMN last_retrieved_at_parity TO last_retrieved_at'], async () => {
          expect(await engine.readRetrievalTrackingColumn()).toBe(false);
          const check = await checkBrainstormHealth(engine);
          expect({ status: check.status, missing: check.message.includes('pages.last_retrieved_at column missing') }).toEqual({ status: 'warn', missing: true });
        });
      return 'pinned';
    },
  );
});

describe('doctor ops route (/admin/api/ops)', () => {
  parityTest(
    'the ops route capacity view reads the same counters on every engine',
    { methods: ['listCapacityCounters'] },
    async (engine) => {
      const view = await readCapacityView(engine);
      expect('status' in view).toBe(false);
      return view;
    },
  );

  parityTest(
    'the ops route snapshot: capacity is read on the SQL engines; the full Rust ops report stops on the connection check',
    { methods: ['listCapacityCounters'] },
    async (engine, backend) => {
      const snapshot = await cachedOpsSnapshot(engine);
      expect('status' in snapshot.capacity).toBe(false);
      if (backend === 'rust') {
        // The ops tier stops at the database connection check (a raw SELECT 1): the report holds that one failed check
        // and the capacity view, and no read of this file refuses. rust-engine/admin-unowned-rust (pingStore, lane 12)
        // and rust-engine/doctor-slices lift that stop; until then the case ends on the stop itself and the Rust tally
        // counts it as refused.
        expect(snapshot.report.checks.map(c => ({ name: c.name, status: c.status }))).toEqual([{ name: 'connection', status: 'fail' }]);
        await engine.executeRaw('SELECT 1');
      }
      expect(snapshot.report.checks.length).toBeGreaterThan(1);
      return { capacity: snapshot.capacity };
    },
  );
});
