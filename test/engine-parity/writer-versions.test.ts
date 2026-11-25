/**
 * BrainEngine parity — the writer-version reads (engine-sql/writer-versions.ts): `readWriterVersionCutoff` (doctor
 * writer_version check), `listWriterVersions` (persistence/administration.ts writer status) and `recentWriterVersions`
 * (doctor writer_version check, repair/extractor-facts.ts mixed-version warnings), and `readSegmentedGateEvidence` (the
 * segmented-storage gate, page-body/limits.ts and persistence/segmented-gate-hold.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the cutoff is an ISO time no later than the first request admitted after it. listWriterVersions names,
 *    per role, the latest version each host and principal stamped (a consumer only for a committed request), newest
 *    first, at most `limit`. recentWriterVersions groups the committed requests published in the window per role, host,
 *    principal and version, with a count, newest first; a zero-day window read after the last write reads no row (a row
 *    stamped in the read's own clock tick is inside `>= now() - 0` on every arm; no caller reads a zero-day window).
 *    Rows that tie on last_seen come by role, host (no host first), principal and version in byte order, and of
 *    requests with one latest time the lowest request id names the version, on every arm. readSegmentedGateEvidence groups
 *    every admitted request (any state), every published request and every ingest-log row in the window per role,
 *    host, principal, version and segment-reader mark, newest first; an ingest row carries this binary's version and
 *    the mark. On every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that refuses these reads leaves `gbrain doctor` reporting writer health unknown and hides
 *    an older writer still publishing; one that groups or orders differently names the wrong host as out of date. A
 *    Rust gate that reads no writer turns segmented storage on while an older binary still writes the brain.
 *  - Why existing coverage misses it: the reads were raw SQL in persistence/writer-versions.ts and the doctor check,
 *    which the parity cases cannot call (D18), so the Rust engine refused them and no case compared them.
 *  - Seam: none. Typed journal members only (no executeRaw: D18). Times differ per arm, so the cases compare the rows
 *    without `last_seen` and check each `last_seen` is ISO text in the order the rows come back.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { VERSION } from '../../src/version.ts';

const { parityTest } = parityArms(testBackends());

const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';
const ADMITTER = 'e0000000-0000-4000-8000-0000000000e1';
const CONSUMER = 'e0000000-0000-4000-8000-0000000000e2';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Admission { request: string; writer: 'a' | 'b'; version: string; host: string | null }

/** Admits one queued request outside a transaction, as each member runs on its own; returns its journal id. */
async function admit(engine: BrainEngine, a: Admission): Promise<string> {
  const source = await engine.readSourceMembership('default');
  const keys = [`principal:local_cli:parity-writer-${a.writer}`, 'brain'];
  await engine.lockPersistenceCounters(keys);
  return (await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: `parity-writer-${a.writer}`, requestId: a.request, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source!.incarnation, pageId: null, slug: `notes/writer-version-${a.request.slice(-2)}`, worktreeId: null,
    topologyGeneration: null, digest: 'd'.repeat(64), intent: { kind: 'put_page' }, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: a.version, admitterHostId: a.host,
    counterKeys: keys, clientRequestId: null, state: 'queued', deferredRefreshId: null,
  })).id;
}

/** Claims and completes an admitted request as committed, stamped with `version` and `host`. */
async function commit(engine: BrainEngine, id: string, writer: 'a' | 'b', version: string, host: string | null) {
  await engine.stampWriteClaim(id, TOKEN, 60_000, JSON.stringify({ phase: 'parity' }));
  await engine.completeWriteRow({
    id, state: 'committed', outcome: { status: 'parity' }, errorCode: null, errorMessage: null, consumerVersion: version,
    consumerHostId: host, errorDetail: null, resultBytes: 0, counterKeys: [`principal:local_cli:parity-writer-${writer}`, 'brain'],
    intentBytes: 100, retainedBytes: 800, terminalReservation: 4096, probePurges: false,
  });
}

/** The rows without their times, after checking each time is ISO text and the rows come newest first. */
function untimed<R extends { last_seen: string | null }>(rows: R[]): Array<Omit<R, 'last_seen'>> {
  const times = rows.map(row => row.last_seen);
  for (const time of times) expect(time).toMatch(ISO);
  expect([...times].sort().reverse()).toEqual(times);
  return rows.map(({ last_seen: _, ...rest }) => rest);
}

/**
 * Four requests: writer a admits two at version a1 (the second also published) and one at a2 that stays queued; writer
 * b admits and publishes one without a host. In order: admit 1, admit 2 (queued), admit 3, commit 1, commit 3, admit
 * 4, commit 4.
 */
async function seed(engine: BrainEngine) {
  const r1 = await admit(engine, { request: 'b0000000-0000-4000-8000-0000000000b1', writer: 'a', version: 'a1', host: ADMITTER });
  const r2 = await admit(engine, { request: 'b0000000-0000-4000-8000-0000000000b2', writer: 'a', version: 'a2', host: ADMITTER });
  const r3 = await admit(engine, { request: 'b0000000-0000-4000-8000-0000000000b3', writer: 'b', version: 'b1', host: null });
  await commit(engine, r1, 'a', 'c1', CONSUMER);
  await commit(engine, r3, 'b', 'c3', null);
  const r4 = await admit(engine, { request: 'b0000000-0000-4000-8000-0000000000b4', writer: 'a', version: 'a1', host: ADMITTER });
  // Admitting r4 sets the admitter a1 row's last_seen and committing it sets the consumer c1 row's. On a fast runner
  // both can land in the same clock tick, and a tie leaves the newest-first order to the plan (seen on macOS CI).
  await Bun.sleep(5);
  await commit(engine, r4, 'a', 'c1', CONSUMER);
  return { r1, r2, r3, r4 };
}

/**
 * A zero-day window read waits this long after the last write, so every row is strictly older than the read's now():
 * a row stamped in the read's own clock tick is inside `>= now() - 0`. The members take no timestamp, so a past time
 * cannot be written on every arm.
 */
const apart = () => Bun.sleep(20);

/** The rows with the importer's host (this process's identity, different per arm) replaced by one name. */
function oneImporterHost<R extends { role: string; host_id: string | null }>(rows: R[]): R[] {
  return rows.map(row => (row.role === 'importer' ? { ...row, host_id: 'this-host' } : row));
}

describe('engine parity: writer-version reads', () => {
  parityTest('readWriterVersionCutoff is an ISO time before every request admitted after it', {
    methods: ['readWriterVersionCutoff', 'readWriteRequestById', 'insertWriteRequest', 'lockPersistenceCounters', 'readSourceMembership'],
    timeout: 60_000,
  }, async (engine) => {
    const cutoff = await engine.readWriterVersionCutoff();
    const id = await admit(engine, { request: 'b0000000-0000-4000-8000-0000000000b1', writer: 'a', version: 'a1', host: ADMITTER });
    const admitted = await engine.readWriteRequestById(id);
    const answers = { iso: ISO.test(cutoff ?? ''), beforeAdmission: Date.parse(cutoff!) <= new Date(admitted!.created_at).getTime() };
    expect(answers).toEqual({ iso: true, beforeAdmission: true });
    return answers;
  });

  parityTest('listWriterVersions names the latest version per role, host and principal, newest first', {
    methods: ['listWriterVersions', 'insertWriteRequest', 'lockPersistenceCounters', 'stampWriteClaim', 'completeWriteRow', 'readSourceMembership'],
    timeout: 60_000,
  }, async (engine) => {
    const empty = await engine.listWriterVersions(50);
    await seed(engine);
    const all = untimed(await engine.listWriterVersions(50));
    const limited = untimed(await engine.listWriterVersions(2));
    const none = await engine.listWriterVersions(0);
    const answers = { empty, all, limited, none };
    const consumerA = { role: 'consumer' as const, host_id: CONSUMER, principal: 'local_cli:parity-writer-a', version: 'c1' };
    const admitterA = { role: 'admitter' as const, host_id: ADMITTER, principal: 'local_cli:parity-writer-a', version: 'a1' };
    expect(answers).toEqual({
      empty: [],
      all: [consumerA, admitterA,
        { role: 'consumer', host_id: null, principal: 'local_cli:parity-writer-b', version: 'c3' },
        { role: 'admitter', host_id: null, principal: 'local_cli:parity-writer-b', version: 'b1' }],
      limited: [consumerA, admitterA],
      none: [],
    });
    return answers;
  });

  parityTest('recentWriterVersions counts the published requests per role, host, principal and version', {
    methods: ['recentWriterVersions', 'insertWriteRequest', 'lockPersistenceCounters', 'stampWriteClaim', 'completeWriteRow', 'readSourceMembership'],
    timeout: 60_000,
  }, async (engine) => {
    const empty = await engine.recentWriterVersions(7);
    await seed(engine);
    const week = untimed(await engine.recentWriterVersions(7));
    // A zero-day window starts at the read's now(), and `>= now() - 0` counts a request published in that very clock
    // tick (seen on a macOS run). The read waits past the last publication, so the window holds none of the requests.
    await apart();
    const window = await engine.recentWriterVersions(0);
    const answers = { empty, week, window };
    expect(answers).toEqual({
      empty: [],
      week: [
        { role: 'consumer', host_id: CONSUMER, principal: 'local_cli:parity-writer-a', version: 'c1', requests: 2 },
        { role: 'admitter', host_id: ADMITTER, principal: 'local_cli:parity-writer-a', version: 'a1', requests: 2 },
        { role: 'consumer', host_id: null, principal: 'local_cli:parity-writer-b', version: 'c3', requests: 1 },
        { role: 'admitter', host_id: null, principal: 'local_cli:parity-writer-b', version: 'b1', requests: 1 },
      ],
      window: [],
    });
    return answers;
  });

  parityTest('readSegmentedGateEvidence groups admitters, consumers and importers with their segment-reader mark', {
    methods: ['readSegmentedGateEvidence', 'logIngest', 'insertWriteRequest', 'lockPersistenceCounters', 'stampWriteClaim', 'completeWriteRow', 'readSourceMembership'],
    timeout: 60_000,
  }, async (engine) => {
    const empty = await engine.readSegmentedGateEvidence(7);
    await seed(engine);
    await engine.logIngest({ source_type: 'parity-import', source_ref: 'parity', pages_updated: ['notes/a'], summary: 'one' });
    await engine.logIngest({ source_type: 'parity-import', source_ref: 'parity', pages_updated: ['notes/b'], summary: 'two' });
    const rows = await engine.readSegmentedGateEvidence(7);
    for (const row of rows) {
      expect(row.first_seen).toMatch(ISO);
      expect(Date.parse(row.first_seen!)).toBeLessThanOrEqual(Date.parse(row.last_seen!));
    }
    // The importer's host is this process's identity, which differs per arm; it is checked as a uuid or null.
    const importer = rows.find(row => row.role === 'importer');
    expect(importer?.host_id === null || /^[0-9a-f-]{36}$/.test(importer?.host_id ?? '')).toBe(true);
    const week = untimed(rows.map(({ first_seen: _, ...row }) => row.role === 'importer' ? { ...row, host_id: 'this-host' } : row));
    // As in the recentWriterVersions case: the zero-day read waits past the last write, so no row is in its clock tick.
    await apart();
    const window = await engine.readSegmentedGateEvidence(0);
    const answers = { empty, week: [...week].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), window };
    const writerA = 'local_cli:parity-writer-a', writerB = 'local_cli:parity-writer-b';
    expect(answers).toEqual({
      empty: [],
      week: [
        { role: 'admitter', host_id: ADMITTER, principal: writerA, version: 'a1', segment_reader: true, requests: 2 },
        { role: 'admitter', host_id: ADMITTER, principal: writerA, version: 'a2', segment_reader: true, requests: 1 },
        { role: 'admitter', host_id: null, principal: writerB, version: 'b1', segment_reader: true, requests: 1 },
        { role: 'consumer', host_id: CONSUMER, principal: writerA, version: 'c1', segment_reader: true, requests: 2 },
        { role: 'consumer', host_id: null, principal: writerB, version: 'c3', segment_reader: true, requests: 1 },
        { role: 'importer', host_id: 'this-host', principal: 'ingest:parity-import', version: VERSION, segment_reader: true, requests: 2 },
      ],
      window: [],
    });
    return answers;
  });

  /**
   * Every row below ties on last_seen: the requests are admitted, published and read in ONE transaction, where each arm
   * stamps them with the transaction's now(). A tie falls back to role, host (no host first), principal and version, then
   * the segment-reader mark, in byte order, on every arm, so the order of tied rows is never left to the plan.
   */
  parityTest('listWriterVersions, recentWriterVersions and readSegmentedGateEvidence order rows that tie on last_seen by role, host, principal and version', {
    methods: ['listWriterVersions', 'recentWriterVersions', 'readSegmentedGateEvidence', 'logIngest', 'insertWriteRequest', 'lockPersistenceCounters', 'stampWriteClaim', 'completeWriteRow', 'readSourceMembership'],
    timeout: 60_000,
  }, async (engine) => {
    let ids!: Awaited<ReturnType<typeof seed>>;
    const answers = await engine.transaction(async (tx) => {
      ids = await seed(tx);
      await tx.logIngest({ source_type: 'parity-import', source_ref: 'parity', pages_updated: ['notes/a'], summary: 'one' });
      const latest = await tx.listWriterVersions(50);
      const recent = await tx.recentWriterVersions(7);
      const gate = await tx.readSegmentedGateEvidence(7);
      return {
        ties: [...latest, ...recent, ...gate].every(row => row.last_seen === recent[0]?.last_seen),
        latest: untimed(latest),
        recent: untimed(recent),
        gate: untimed(oneImporterHost(gate)).map(({ first_seen: _, ...row }) => row),
      };
    });
    const writerA = 'local_cli:parity-writer-a', writerB = 'local_cli:parity-writer-b';
    // Writer a's requests r1, r2 and r4 were all admitted at one now(), so the latest admission is a tie too: the request
    // with the lowest journal id (byte order, as the Rust store scans them) names the version.
    const firstAdmitted = ([[ids.r1, 'a1'], [ids.r2, 'a2'], [ids.r4, 'a1']] as const).toSorted((x, y) => (x[0] < y[0] ? -1 : 1))[0]![1];
    expect(answers).toEqual({
      ties: true,
      latest: [
        { role: 'admitter', host_id: null, principal: writerB, version: 'b1' },
        { role: 'admitter', host_id: ADMITTER, principal: writerA, version: firstAdmitted },
        { role: 'consumer', host_id: null, principal: writerB, version: 'c3' },
        { role: 'consumer', host_id: CONSUMER, principal: writerA, version: 'c1' },
      ],
      recent: [
        { role: 'admitter', host_id: null, principal: writerB, version: 'b1', requests: 1 },
        { role: 'admitter', host_id: ADMITTER, principal: writerA, version: 'a1', requests: 2 },
        { role: 'consumer', host_id: null, principal: writerB, version: 'c3', requests: 1 },
        { role: 'consumer', host_id: CONSUMER, principal: writerA, version: 'c1', requests: 2 },
      ],
      gate: [
        { role: 'admitter', host_id: null, principal: writerB, version: 'b1', segment_reader: true, requests: 1 },
        { role: 'admitter', host_id: ADMITTER, principal: writerA, version: 'a1', segment_reader: true, requests: 2 },
        { role: 'admitter', host_id: ADMITTER, principal: writerA, version: 'a2', segment_reader: true, requests: 1 },
        { role: 'consumer', host_id: null, principal: writerB, version: 'c3', segment_reader: true, requests: 1 },
        { role: 'consumer', host_id: CONSUMER, principal: writerA, version: 'c1', segment_reader: true, requests: 2 },
        { role: 'importer', host_id: 'this-host', principal: 'ingest:parity-import', version: VERSION, segment_reader: true, requests: 1 },
      ],
    });
    // The journal ids are random per arm, so the arms compare that row by the rule it follows, not by the version it names.
    return { ...answers, latest: answers.latest.map(row => (row.version === firstAdmitted && row.role === 'admitter' && row.host_id === ADMITTER ? { ...row, version: 'lowest-id' } : row)) };
  });
});
