/**
 * BrainEngine parity — the effect worker's scans (engine-sql/persistence-effect-scans.ts): `listGatedMirrorRequests`
 * (persistence/segmented-mirror-gate.ts `resumeGatedMirrors`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain with no worktree, each scan answers no row for any uuid host id (lowercase or uppercase),
 *    also after a write request is admitted and queued; a host id that is not a uuid refuses with the `::uuid` cast's
 *    message, never with an empty answer. On every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    through test/engine-parity/harness.ts).
 *  - Regression: an engine that cannot run a scan stops every effect pass of the write worker, so a queued `gbrain put`
 *    is never applied; one that answers empty for a bad host id hides a caller bug Postgres reports.
 *  - Why existing coverage misses it: each scan was raw SQL in its caller, which the parity cases cannot call (D18), so
 *    the Rust engine refused it at `executeRaw` and no case compared it across engines.
 *  - Seam: none. Typed members and the real admission path only (no executeRaw: D18). Rows from a managed worktree
 *    cannot be built through typed members, so the SQL's row matching stays covered by the callers' own tests.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { SEGMENTED_MIRROR_GATE_CODE } from '../../src/core/persistence/segmented-mirror-gate.ts';
import { WITHHELD_BY_MIRROR } from '../../src/core/persistence/effect-model.ts';

const { parityTest } = parityArms(testBackends());

const HOST = 'c0000000-0000-4000-8000-0000000000c1';
const REQUEST = 'c0000000-0000-4000-8000-0000000000c2';
const CODES = [SEGMENTED_MIRROR_GATE_CODE, WITHHELD_BY_MIRROR];

/** 'ok', or the part of the refusal message `pattern` matches (the whole message when it does not match). */
async function outcome(run: () => Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return pattern.exec(message)?.[0] ?? message;
  }
}

/** Admits one put_page request for `slug` through the real admission path, as a CLI put does. It stays queued. */
async function admitPut(engine: BrainEngine, slug: string, requestId: string) {
  const source = await engine.readSourceMembership('default');
  const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source!.incarnation, slug);
  return admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source!.incarnation, slug, requestId, callerIntent: { body: slug }, intent: { body: slug } });
}

describe('engine parity: effect scans', () => {
  parityTest('listGatedMirrorRequests finds no parked mirror without a worktree and refuses a non-uuid host', {
    methods: ['listGatedMirrorRequests', 'readSourceMembership'],
    timeout: 60_000,
  }, async (engine) => {
    const empty = await engine.listGatedMirrorRequests(HOST, SEGMENTED_MIRROR_GATE_CODE, CODES);
    await registerLocalWriter(engine, 'cli');
    await admitPut(engine, 'notes/gated-mirror', REQUEST);
    const queued = await engine.listGatedMirrorRequests(HOST, SEGMENTED_MIRROR_GATE_CODE, CODES);
    const upper = await engine.listGatedMirrorRequests(HOST.toUpperCase(), SEGMENTED_MIRROR_GATE_CODE, []);
    const bad = await outcome(() => engine.listGatedMirrorRequests('not-a-host', SEGMENTED_MIRROR_GATE_CODE, CODES),
      /invalid input syntax for type uuid/);
    const answers = { empty, queued, upper, bad };
    expect(answers).toEqual({ empty: [], queued: [], upper: [], bad: 'invalid input syntax for type uuid' });
    return answers;
  });
});
