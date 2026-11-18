/**
 * BrainEngine parity — the writer-version reads (engine-sql/writer-versions.ts): `readWriterVersionCutoff` (doctor
 * writer_version check).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the cutoff is an ISO time no later than the first request admitted after it. On every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: an engine that refuses this read leaves `gbrain doctor` reporting writer health unknown.
 *  - Why existing coverage misses it: the read was raw SQL in the doctor check, which the parity cases cannot call
 *    (D18), so the Rust engine refused it and no case compared it.
 *  - Seam: none. Typed journal members only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

const ADMITTER = 'e0000000-0000-4000-8000-0000000000e1';
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
});
