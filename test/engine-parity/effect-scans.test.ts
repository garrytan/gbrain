/**
 * BrainEngine parity — the effect worker's scans (engine-sql/persistence-effect-scans.ts): `listGatedMirrorRequests`
 * (persistence/segmented-mirror-gate.ts `resumeGatedMirrors`) and `listEffectRecoveries`
 * (persistence/effect-recovery-scan.ts `selectEffectRecoveries`), and the claim's candidate read `selectClaimableEffect`
 * (persistence/effect-journal.ts `claimPersistenceEffect`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain with no worktree and no published write, each scan answers no row (the claim read null, in
 *    the claim's own direct transaction, with and without dead owner keys) for any uuid host id (lowercase or uppercase),
 *    also after a write request is admitted and queued; a host id that is not a uuid refuses with the `::uuid` cast's
 *    message, never with an empty answer; so does a recovery cursor that is not a bigint (syntax or range) and a limit
 *    that is fractional or negative. On every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
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
  const source = await engine.readSourceIncarnation('default');
  const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source!.incarnation, slug);
  return admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source!.incarnation, slug, requestId, callerIntent: { body: slug }, intent: { body: slug } });
}

describe('engine parity: effect scans', () => {
  parityTest('listGatedMirrorRequests finds no parked mirror without a worktree and refuses a non-uuid host', {
    methods: ['listGatedMirrorRequests', 'readSourceIncarnation'],
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

  parityTest('listEffectRecoveries finds no recovery without a worktree and refuses what its casts refuse', {
    methods: ['listEffectRecoveries', 'readSourceIncarnation'],
    timeout: 60_000,
  }, async (engine) => {
    const empty = await engine.listEffectRecoveries(HOST, null, 10);
    await registerLocalWriter(engine, 'cli');
    await admitPut(engine, 'notes/effect-recovery', REQUEST);
    const queued = await engine.listEffectRecoveries(HOST, null, 10);
    const cursor = await engine.listEffectRecoveries(HOST.toUpperCase(), ' +12 ', 0);
    const refusal = (hostId: string, after: string | null, limit: number) =>
      outcome(() => engine.listEffectRecoveries(hostId, after, limit), /invalid input syntax for type \w+: "[^"]*"|value "[^"]*" is out of range for type bigint|LIMIT must not be negative/);
    const refused = {
      host: await refusal('not-a-host', null, 10),
      after: await refusal(HOST, 'x1', 10),
      range: await refusal(HOST, '99999999999999999999', 10),
      negative: await refusal(HOST, null, -1),
      fraction: await refusal(HOST, null, 1.5),
    };
    const answers = { empty, queued, cursor, refused };
    expect(answers).toEqual({ empty: [], queued: [], cursor: [], refused: {
      host: 'invalid input syntax for type uuid: "not-a-host"',
      after: 'invalid input syntax for type bigint: "x1"',
      range: 'value "99999999999999999999" is out of range for type bigint',
      negative: 'LIMIT must not be negative',
      fraction: 'invalid input syntax for type bigint: "1.5"',
    } });
    return answers;
  });

  parityTest('selectClaimableEffect finds no effect before a write is published and refuses a non-uuid host', {
    methods: ['selectClaimableEffect', 'transaction', 'readSourceIncarnation'],
    timeout: 60_000,
  }, async (engine) => {
    const claim = (hostId: string, deadOwners: readonly string[]) =>
      engine.transaction(tx => tx.selectClaimableEffect(hostId, deadOwners));
    const empty = await claim(HOST, []);
    await registerLocalWriter(engine, 'cli');
    await admitPut(engine, 'notes/effect-claim', REQUEST);
    const queued = await claim(HOST, []);
    const dead = await claim(HOST.toUpperCase(), ['1:nonce:2']);
    const bad = await outcome(() => claim('not-a-host', []), /invalid input syntax for type uuid: "[^"]*"/);
    const answers = { empty, queued, dead, bad };
    expect(answers).toEqual({ empty: null, queued: null, dead: null, bad: 'invalid input syntax for type uuid: "not-a-host"' });
    return answers;
  });
});
