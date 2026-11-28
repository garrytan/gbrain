/**
 * BrainEngine parity: the four doctor checks that still read through `executeRaw` (the timeline dedup index shape in
 * src/core/timeline-dedup-repair.ts, the sources read in src/commands/doctor/report-remote.ts, the schema-pack config
 * reads in src/commands/doctor/schema-pack-checks.ts, and the three counts in src/commands/doctor/checks/calibration.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the focused doctor report run_doctor returns (doctorReportRemote, brain-wide, as an unscoped caller gets it)
 *    completes on every arm and has a row for each check
 *    these four files feed. On PGLite and Postgres each row is a real answer. On the Rust arm each row says it could not
 *    check (a `Could not check ...` row, or a `Not verified` row), never ok or a zero count, because the Rust engine
 *    refuses `executeRaw` and the check catches that refusal. The idx_timeline_dedup shape is a named permanent loss: it
 *    is a Postgres index, and the Rust store keeps no SQL index.
 *  - Regression: lane L3 found that run_doctor on a Rust brain catches raw-SQL refusals in these four files, and no
 *    stop pin on rust-engine/main named them, so a swapped brain's doctor could have turned one into a healthy row with
 *    nothing to catch it.
 *  - Why existing coverage misses it: test/doctor-report-remote.serial.test.ts and the doctor golden tests run on PGLite
 *    and Postgres only; no parity file ran run_doctor on the Rust arm and asked what each of these rows says.
 *  - Seam: none. A page is seeded with putPage and a second source with an empty local directory (createSource), so the
 *    drift check has a source to walk on every arm. The report is called directly: run_doctor over MCP binds the caller
 *    to one source, and the drift check needs a second one to run at all.
 *  - On the Rust arm the caught refusals are pinned by calling file in test/rust-stop-pins/lane-2b-doctor-raw.tsv. Each
 *    pin goes when its file stops calling executeRaw on a Rust brain. With a second source the report also catches the
 *    raw reads of src/core/sync-attempt.ts (sync_freshness names it: "last attempt unreadable") and
 *    src/core/shared-skills/adopted-packs.ts (the read-only skill-pack exemption, which then exempts nothing); both
 *    are pinned there too.
 */
import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { doctorReportRemote } from '../../src/commands/doctor.ts';
import { checkTimelineDedupIndex, repairTimelineDedupIndex } from '../../src/core/timeline-dedup-repair.ts';

const { parityTest } = parityArms(testBackends());

/** The rows the four raw-SQL doctor files feed, with the file each row reads through. */
const RAW_ROWS: Record<string, string> = {
  timeline_dedup_index: 'src/core/timeline-dedup-repair.ts',
  multi_source_drift: 'src/commands/doctor/report-remote.ts',
  schema_pack_source_drift: 'src/commands/doctor/schema-pack-checks.ts',
  abandoned_threads: 'src/commands/doctor/checks/calibration.ts',
  grade_confidence_drift: 'src/commands/doctor/checks/calibration.ts',
  contextual_retrieval_coverage: 'src/commands/doctor/checks/calibration.ts',
};
const NOT_CHECKED = /^(Could not check |Not verified: )/;

type Check = { name?: unknown; status?: unknown; message?: unknown };

parityTest('the doctor report answers each raw-SQL check on SQL engines and says it could not check it on Rust', {
  methods: ['putPage'], timeout: 240_000,
}, async (engine: BrainEngine, backend) => {
  await engine.putPage('notes/doctor-raw', { type: 'note' as never, title: 'Doctor raw', compiled_truth: 'A note.', timeline: '', frontmatter: {} });
  const dir = mkdtempSync(join(tmpdir(), 'doctor-raw-source-'));
  let report: Awaited<ReturnType<typeof doctorReportRemote>>;
  try {
    await createSource(engine, backend, 'doctor-raw-second', {}, dir);
    report = await doctorReportRemote(engine, { remote: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const checks: Check[] = report.checks;
  const rows = Object.keys(RAW_ROWS).map((name) => {
    const row = checks.find((c) => c.name === name);
    return { name, status: row?.status, message: typeof row?.message === 'string' ? row.message : '' };
  });
  expect(rows.filter((r) => r.status === undefined).map((r) => r.name)).toEqual([]);
  // The swap-critical half: on Rust no row may pass as healthy, and on the SQL engines no row may be a non-answer.
  const notChecked = rows.filter((r) => r.status === 'warn' && NOT_CHECKED.test(r.message)).map((r) => r.name);
  expect({ backend, notChecked }).toEqual({ backend, notChecked: backend === 'rust' ? Object.keys(RAW_ROWS) : [] });
  return { rows: rows.map((r) => r.name) };
});

parityTest('the timeline dedup index check reads the shape of a Postgres index', {
  methods: ['executeRaw'], requires: 'raw_sql',
}, async (engine: BrainEngine) => {
  // Named permanent loss (docs/designs/RUST_ENGINE.md#named-permanent-losses): idx_timeline_dedup is a Postgres unique
  // index; the Rust store keeps no SQL index (its timeline dedup is a store key), so there is no shape to read or rebuild.
  const status = await checkTimelineDedupIndex(engine);
  expect(status).toEqual({ tablePresent: true, indexPresent: true, columns: ['page_id', 'date', 'md5(summary)', 'source'], needsRepair: false });
  const repair = await repairTimelineDedupIndex(engine);
  expect(repair).toEqual({ repaired: false, before: ['page_id', 'date', 'md5(summary)', 'source'], collapsedDuplicates: 0, reason: 'already_correct' });
  return { status, repair };
});
