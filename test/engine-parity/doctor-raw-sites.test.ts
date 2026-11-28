/**
 * BrainEngine parity: the doctor check that still reads through `executeRaw` (the timeline dedup index shape in
 * src/core/timeline-dedup-repair.ts), and the multi_source_drift, schema_pack_source_drift and three calibration rows
 * (src/commands/doctor/checks/calibration.ts), which every arm answers.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the focused doctor report run_doctor returns (doctorReportRemote, brain-wide, as an unscoped caller gets it)
 *    completes on every arm and has a row for each check
 *    these files feed. On PGLite and Postgres each row is a real answer. On the Rust arm each row says it could not
 *    check (a `Could not check ...` row, or a `Not verified` row), never ok or a zero count, because the Rust engine
 *    refuses `executeRaw` and the check catches that refusal. The idx_timeline_dedup shape is a named permanent loss: it
 *    is a Postgres index, and the Rust store keeps no SQL index.
 *  - Contract: contextual_retrieval_coverage, abandoned_threads and grade_confidence_drift give the same status and
 *    message on every arm: their counts are typed members, and before they were the Rust arm said "Could not check".
 *  - Regression: lane L3 found that run_doctor on a Rust brain catches raw-SQL refusals in these four files, and no
 *    stop pin on rust-engine/main named them, so a swapped brain's doctor could have turned one into a healthy row with
 *    nothing to catch it.
 *  - Why existing coverage misses it: test/doctor-report-remote.serial.test.ts and the doctor golden tests run on PGLite
 *    and Postgres only; no parity file ran run_doctor on the Rust arm and asked what each of these rows says.
 *  - Seam: none. A page is seeded with putPage and a second source with a local directory (createSource) holding that
 *    page's file and an uningested one, so the drift walk reaches its existence probe on every arm and finds one misroute. The report is called directly: run_doctor over MCP binds the caller
 *    to one source, and the drift check needs a second one to run at all.
 *  - On the Rust arm the caught refusals are pinned by calling file in test/rust-stop-pins/lane-2b-doctor-raw.tsv. Each
 *    pin goes when its file stops calling executeRaw on a Rust brain. Any source with a local path and no successful
 *    sync (one is enough) also reaches the raw read of src/core/sync-attempt.ts: sync_freshness then says "last attempt
 *    unreadable" on Rust. That is pinned there too, and the sync-attempt case below reproduces it with one source.
 *
 * The adopted skill-pack read (src/core/shared-skills/adopted-packs.ts) is served on every arm by
 * listAdoptedSkillPackSourceIds. Before it was, a Rust brain with any source that has a local path got the note
 * "read-only skill-pack exemption unavailable (...)" on sync_freshness, and a read-only pack source was judged as a git
 * source that never synced: a false warning, so a wrong answer. The pack case below failed on Rust at 88cfad0f15.
 */
import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SharedSkillRevisionWrite } from '../../src/core/engine-sql/shared-skill-members.ts';
import type { RustEngine } from '../../src/core/rust-engine.ts';
import { checkSyncFreshness } from '../../src/commands/doctor/checks/extraction-sync.ts';
import { doctorReportRemote } from '../../src/commands/doctor.ts';
import { checkTimelineDedupIndex, repairTimelineDedupIndex } from '../../src/core/timeline-dedup-repair.ts';

const { parityTest } = parityArms(testBackends());

/** The rows the raw-SQL doctor files feed, with the file each row reads through. */
const RAW_ROWS: Record<string, string> = {
  timeline_dedup_index: 'src/core/timeline-dedup-repair.ts',
};
/** The calibration rows, which typed members serve (countContextualCoverage, countAbandonedTakes, countAppliedTakeGrades). */
const CALIBRATION_ROWS = ['contextual_retrieval_coverage', 'abandoned_threads', 'grade_confidence_drift'] as const;
const NOT_CHECKED = /^(Could not check |Not verified: )/;

type Check = { name?: unknown; status?: unknown; message?: unknown };

parityTest('the doctor report answers each raw-SQL check on SQL engines and says it could not check it on Rust', {
  methods: ['putPage', 'addTakesBatch'], timeout: 240_000,
}, async (engine: BrainEngine, backend) => {
  const page = await engine.putPage('notes/doctor-raw', { type: 'note' as never, title: 'Doctor raw', compiled_truth: 'A note.', timeline: '', frontmatter: {} });
  // One abandoned conviction (weight 0.9, dated 2019), so abandoned_threads has a take to count.
  await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'An old conviction.', kind: 'take', holder: 'self', weight: 0.9, since_date: '2019-01' }]);
  const dir = mkdtempSync(join(tmpdir(), 'doctor-raw-source-'));
  let report: Awaited<ReturnType<typeof doctorReportRemote>>;
  try {
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, 'notes', 'doctor-raw.md'), '# Doctor raw\n');
    writeFileSync(join(dir, 'notes', 'not-ingested.md'), '# Not ingested\n');
    await createSource(engine, backend, 'doctor-raw-second', {}, dir);
    await engine.setConfig('schema_pack.source.default', 'pack-a');
    await engine.setConfig('schema_pack.source.doctor-raw-second', 'pack-b');
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
  // The drift roster and existence probe are typed members (readDoctorSources 'drift_roster', probeSlugSources): every
  // arm walks the second source and finds the one page that sits at default but not at its intended source.
  const drift = checks.find((c) => c.name === 'multi_source_drift') as Check & { details?: { code?: unknown } } | undefined;
  const driftRow = { status: drift?.status, code: drift?.details?.code, message: drift?.message };
  expect({ status: driftRow.status, code: driftRow.code }).toEqual({ status: 'warn', code: 'drift_detected' });
  expect(String(driftRow.message)).toStartWith("1 page slug(s) appear at 'default' but NOT at the intended source (e.g., notes/doctor-raw (intended=doctor-raw-second)).");
  // The per-source pack overrides are a typed member (listSchemaPackSourceOverrides): every arm finds the two packs.
  const packDrift = checks.find((c) => c.name === 'schema_pack_source_drift');
  const packDriftRow = { status: packDrift?.status, message: packDrift?.message };
  expect(packDriftRow).toEqual({ status: 'warn', message: 'Per-source pack divergence detected: 2 distinct packs across 2 sources. Run `gbrain sources list` then `gbrain schema active --source <id>` per source to audit.' });
  const calibration = Object.fromEntries(CALIBRATION_ROWS.map((name) => {
    const row = checks.find((c) => c.name === name);
    return [name, { status: row?.status, message: row?.message }];
  }));
  // The calibration counts are typed members: every arm reads the same three rows from the one page and its take.
  expect(calibration).toEqual({
    contextual_retrieval_coverage: {
      status: 'warn',
      message: '1 page(s) at older chunker_version; 1 page(s) below the safe-chunk index version — withheld from remote/MCP chunk retrieval until re-sealed; 1 page(s) never evaluated against CR ladder. Preview the re-seal: gbrain repair safe-chunks — apply: gbrain repair safe-chunks --apply. Preview the mode stamp (#5621): gbrain repair contextual-mode — apply: gbrain repair contextual-mode --apply. Run `gbrain reindex --markdown` to align.',
    },
    abandoned_threads: { status: 'ok', message: '1 high-conviction take(s) older than 12 months and never revisited — see `gbrain calibration` for details' },
    grade_confidence_drift: { status: 'ok', message: 'Only 0 auto-applied verdicts — need 30+ for drift detection' },
  });
  return { rows: rows.map((r) => r.name), drift: driftRow, packDrift: packDriftRow, calibration };
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

const PACK_BODY = '---\nname: notes\ndescription: Take notes.\n---\nTake notes.\n';

/** One revision of skill `notes` in pack `pack` of `sourceId`; `deleted` makes its head a deleted one. */
function packRevision(sourceId: string, incarnation: string, revision: string, deleted: boolean): SharedSkillRevisionWrite {
  const file = { path: 'skills/notes/SKILL.md', file_class: 'prose', audience: ['readers'], media_type: 'text/markdown', size: Buffer.byteLength(PACK_BODY),
    sha256: createHash('sha256').update(PACK_BODY).digest('hex'), depends_on: [], content: Buffer.from(PACK_BODY).toString('base64') };
  return { sourceId, incarnation, packId: 'pack', name: 'notes', revision, deleted, policyEpoch: 'e0000000-0000-4000-8000-0000000000e1',
    requestId: 'e0000000-0000-4000-8000-0000000000e2',
    metadata: { description: 'Take notes.', triggers: [], requirements: [], private: false, audience: ['readers'], writes_pages: false, mutating: false,
      file_policy: [{ file_class: 'prose', audience: ['readers'] }], tools_declared: false },
    files: deleted ? [] : [file] };
}

/**
 * Fixture: store a pack row and its one head for `sourceId`'s current incarnation, as a publication leaves them (no
 * commit is recorded). The SQL arms write under replica role (the publication guard refuses without activation); the
 * Rust arm activates publication in its store (the pack write refuses without it) and writes the same records there.
 */
async function seedPack(engine: BrainEngine, backend: string, sourceId: string, revision: string, deleted = false): Promise<void> {
  const incarnation = (await engine.readSourceMembership(sourceId))!.incarnation;
  const write = packRevision(sourceId, incarnation, revision, deleted);
  const pack = { sourceId, incarnation, packId: 'pack', revision, manifest: { name: 'pack' }, manifestHash: 'h' };
  if (backend === 'rust') {
    const brain = (engine as unknown as RustEngine).openStore('seedPack').brain;
    await brain.activateSharedSkillPublication(false);
    await brain.writeSharedSkillRevision(write);
    await brain.writeSharedSkillPack(pack);
    return;
  }
  await engine.transaction(async (tx) => {
    await tx.executeRaw('SET LOCAL session_replication_role = replica');
    await tx.writeSharedSkillRevision(write);
    await tx.executeRaw('INSERT INTO shared_skill_packs(source_id,source_incarnation,pack_id,revision,manifest,manifest_hash) VALUES($1,$2::uuid,$3,$4::uuid,$5::text::jsonb,$6)',
      [pack.sourceId, pack.incarnation, pack.packId, pack.revision, JSON.stringify(pack.manifest), pack.manifestHash]);
  });
}

parityTest('a read-only adopted skill pack is exempt from sync freshness on every engine; a deleted-head pack and the default source are not adopted', {
  methods: ['listAdoptedSkillPackSourceIds', 'readSourceMembership'], timeout: 240_000,
}, async (engine: BrainEngine, backend) => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-raw-pack-'));
  try {
    // The one source with a local path: a pack published into a plain directory (no .git, no commit recorded).
    await createSource(engine, backend, 'skill-pack', {}, dir);
    await seedPack(engine, backend, 'skill-pack', 'e0000000-0000-4000-8000-0000000000a1');
    // Discriminators: a pack whose only head is deleted, and a live pack on the default source; neither is adopted.
    await createSource(engine, backend, 'deleted-pack', {});
    await seedPack(engine, backend, 'deleted-pack', 'e0000000-0000-4000-8000-0000000000a2', true);
    await seedPack(engine, backend, 'default', 'e0000000-0000-4000-8000-0000000000a3');
    const adopted = (await engine.listAdoptedSkillPackSourceIds()).sort();
    expect(adopted).toEqual(['skill-pack']);
    const check = await checkSyncFreshness(engine);
    const result = { adopted, status: check.status, message: check.message, details: check.details };
    expect(result).toEqual({ adopted: ['skill-pack'], status: 'ok', message: expect.stringContaining('1 read-only skill-pack source(s): no commits to sync'),
      details: expect.objectContaining({ read_only_pack_count: 1, stale_count: 0 }) });
    expect(check.message).not.toContain('exemption unavailable');
    expect(Object.keys(check.details ?? {})).not.toContain('read_only_pack_note');
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The named Rust stop of the sync-attempt case; the case's error carries it. */
const SYNC_ATTEMPT_PIN = 'lane 2b (doctor-raw, due 2026-12-09): src/core/sync-attempt.ts:72 reads the last sync job with executeRaw, which a Rust brain refuses, so readLastSyncAttempt answers "unreadable" instead of "no attempt recorded"; remove this rustStop and the sync-attempt.ts row of test/rust-stop-pins/lane-2b-doctor-raw.tsv when the read is a typed member with Rust parity (RUST_ENGINE.md ledger row 65)';

parityTest('one source with a local path and no successful sync: sync_freshness reads its last attempt', {
  methods: ['readDoctorSources'], timeout: 240_000,
  rustStop: { code: 'last_attempt_unreadable', pin: SYNC_ATTEMPT_PIN },
}, async (engine: BrainEngine, backend) => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-raw-never-'));
  try {
    await createSource(engine, backend, 'never-synced', {}, dir);
    const check = await checkSyncFreshness(engine);
    const entries = ((check.details as { no_successful_sync?: Array<Record<string, unknown>> } | undefined)?.no_successful_sync ?? []);
    const message = String(check.message);
    if (backend === 'rust' && /last attempt unreadable/.test(message)) {
      throw Object.assign(new Error(`${SYNC_ATTEMPT_PIN}. sync_freshness said: ${message.slice(0, 400)}`), { code: 'last_attempt_unreadable' });
    }
    const result = { status: check.status, codes: entries.map((e) => e.code), reasons: entries.map((e) => e.reason), unreadable: /unreadable/.test(message),
      noAttempt: /no attempt recorded/.test(message) };
    expect(result).toEqual({ status: 'fail', codes: ['sync_no_successful_sync'], reasons: expect.any(Array), unreadable: false, noAttempt: true });
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
