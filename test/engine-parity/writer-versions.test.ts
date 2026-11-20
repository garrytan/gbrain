/**
 * BrainEngine parity — the writer-version reads (engine-sql/writer-versions.ts): `readWriterVersionCutoff` (doctor
 * writer_version check), `listWriterVersions` (persistence/administration.ts writer status) and `recentWriterVersions`
 * (doctor writer_version check, repair/extractor-facts.ts mixed-version warnings).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the cutoff is an ISO time no later than the first request admitted after it. listWriterVersions names,
 *    per role, the latest version each host and principal stamped (a consumer only for a committed request), newest
 *    first, at most `limit`. recentWriterVersions groups the committed requests published in the window per role, host,
 *    principal and version, with a count, newest first; an empty window reads no row. On every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that refuses these reads leaves `gbrain doctor` reporting writer health unknown and hides
 *    an older writer still publishing; one that groups or orders differently names the wrong host as out of date.
 *  - Why existing coverage misses it: the reads were raw SQL in persistence/writer-versions.ts and the doctor check,
 *    which the parity cases cannot call (D18), so the Rust engine refused them and no case compared them.
 *  - Seam: none. Typed journal members only (no executeRaw: D18). Times differ per arm, so the cases compare the rows
 *    without `last_seen` and check each `last_seen` is ISO text in the order the rows come back.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

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
  await admit(engine, { request: 'b0000000-0000-4000-8000-0000000000b2', writer: 'a', version: 'a2', host: ADMITTER });
  const r3 = await admit(engine, { request: 'b0000000-0000-4000-8000-0000000000b3', writer: 'b', version: 'b1', host: null });
  await commit(engine, r1, 'a', 'c1', CONSUMER);
  await commit(engine, r3, 'b', 'c3', null);
  const r4 = await admit(engine, { request: 'b0000000-0000-4000-8000-0000000000b4', writer: 'a', version: 'a1', host: ADMITTER });
  // Admitting r4 sets the admitter a1 row's last_seen and committing it sets the consumer c1 row's. On a fast runner
  // both can land in the same clock tick, and a tie leaves the newest-first order to the plan (seen on macOS CI).
  await Bun.sleep(5);
  await commit(engine, r4, 'a', 'c1', CONSUMER);
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
});
