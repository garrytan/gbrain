/**
 * BrainEngine parity — the operation checkpoint statements (engine-sql/op-checkpoint.ts) that op-checkpoint.ts runs for
 * a resumable sync: bank paths, record keys, load them back, clear them.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) appendOpCheckpointPaths banks each path once, writeOpCheckpointKeys replaces the
 *    parent's completed_keys and keeps the paths, readOpCheckpointKeys returns both, and deleteOpCheckpoint drops the
 *    checkpoint and its paths. Each checkpoint is keyed by (op, fingerprint) and no other checkpoint sees its keys,
 *    including a fingerprint that is a prefix of another. A housekeeping turn row reads back as a checkpoint too.
 *  - Regression: an engine that loses a banked path makes a resumed sync import that file again; one that leaks keys
 *    across fingerprints makes a sync skip files it never imported. The Rust engine has no SQL, so the statements
 *    have to exist as typed members.
 *  - Why existing coverage misses it: the statements ran through `executeRaw` / `executeRawDirect` inside
 *    op-checkpoint.ts, which the parity cases cannot call (D18). test/op-checkpoint.test.ts runs PGLite only.
 *  - Seam: none. Typed members only (no executeRaw: D18). Key order is unspecified, so the keys are compared sorted.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const HOST = '00000000-0000-4000-8000-0000000000c5';
const sorted = (keys: string[]) => [...keys].sort();

describe('engine parity: operation checkpoints', () => {
  parityTest('banked paths and recorded keys read back per checkpoint and clear together', {
    methods: ['readOpCheckpointKeys', 'writeOpCheckpointKeys', 'appendOpCheckpointPaths', 'deleteOpCheckpoint'],
  }, async (engine) => {
    const empty = await engine.readOpCheckpointKeys('sync', 'f1');
    await engine.appendOpCheckpointPaths('sync', 'f1', ['notes/b.md', 'notes/a.md']);
    await engine.appendOpCheckpointPaths('sync', 'f1', ['notes/a.md', 'notes/é.md']);
    await engine.appendOpCheckpointPaths('sync', 'f10', ['notes/other.md']);
    await engine.appendOpCheckpointPaths('import', 'f1', ['notes/import.md']);
    const banked = await engine.readOpCheckpointKeys('sync', 'f1');
    await engine.writeOpCheckpointKeys('sync', 'f1', ['legacy/x.md', 'legacy/y.md']);
    await engine.writeOpCheckpointKeys('sync', 'f1', ['legacy/z.md']);
    const recorded = await engine.readOpCheckpointKeys('sync', 'f1');
    await engine.writeOpCheckpointKeys('embed', 'f2', ['k1']);
    const keysOnly = await engine.readOpCheckpointKeys('embed', 'f2');
    await engine.deleteOpCheckpoint('sync', 'f1');
    const cleared = await engine.readOpCheckpointKeys('sync', 'f1');
    const neighbour = await engine.readOpCheckpointKeys('sync', 'f10');
    const otherOp = await engine.readOpCheckpointKeys('import', 'f1');
    await engine.deleteOpCheckpoint('sync', 'f-missing');

    const out = {
      empty, cleared,
      banked: { ...banked, keys: sorted(banked.keys) },
      recorded: { ...recorded, keys: sorted(recorded.keys) },
      keysOnly, neighbour, otherOp,
    };
    expect(out.empty).toEqual({ keys: [], corruptParent: false });
    expect(out.banked).toEqual({ keys: ['notes/a.md', 'notes/b.md', 'notes/é.md'], corruptParent: false });
    expect(out.recorded).toEqual({ keys: ['legacy/z.md', 'notes/a.md', 'notes/b.md', 'notes/é.md'], corruptParent: false });
    expect(out.keysOnly).toEqual({ keys: ['k1'], corruptParent: false });
    expect(out.cleared).toEqual({ keys: [], corruptParent: false });
    expect(out.neighbour).toEqual({ keys: ['notes/other.md'], corruptParent: false });
    expect(out.otherOp).toEqual({ keys: ['notes/import.md'], corruptParent: false });
    return out;
  });

  parityTest('a housekeeping turn row is the same op_checkpoints row a checkpoint read sees', {
    methods: ['claimHousekeepingTurn', 'completeHousekeepingTurn', 'readOpCheckpointKeys'],
  }, async (engine) => {
    await engine.claimHousekeepingTurn({ op: 'parity-housekeeping', hostId: HOST, intervalMs: 60_000, leaseMs: 3_600_000,
      consumerKinds: ['serve', 'sync'], consumerLiveMs: 30_000 });
    const leased = await engine.readOpCheckpointKeys('parity-housekeeping', HOST);
    await engine.completeHousekeepingTurn({ op: 'parity-housekeeping', hostId: HOST });
    const done = await engine.readOpCheckpointKeys('parity-housekeeping', HOST);
    expect(leased).toEqual({ keys: ['leased'], corruptParent: false });
    expect(done).toEqual({ keys: ['done'], corruptParent: false });
    return { leased, done };
  });
});
