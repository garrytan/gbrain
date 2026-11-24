/**
 * BrainEngine parity — the shared `gbrain repair` runner on every engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the runner's checkpoint row (`op_checkpoints`, op `repair`), the preview-approval set every
 *    preview-bound kind saves (op `repair-approval`) and the scope and capacity reads answer the same on PGLite,
 *    Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1); a repair kind whose own reads every
 *    engine serves gives the same dry run and apply result on each.
 *  - Regression: `runRepair` read and wrote its cursor, the approval sets, the brain id and the journal counters
 *    through `executeRaw`, which a Rust brain refuses, so every repair kind stopped before its first read there.
 *  - Why existing coverage misses it: the repair tests (test/repair-*.test.ts, test/persistence-*.test.ts) run on
 *    PGLite or Postgres only, and no parity case ran the runner.
 *  - Seam: none. Generated values (run ids, the brain id, timestamps) are compared by shape, never by value.
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
import { clearApprovedSet, loadApprovedSet, saveApprovedSet } from '../../src/core/persistence/preview-approval.ts';
import { GRADUATION_INVENTORY } from '../../src/core/persistence/graduation-inventory.ts';

const { parityTest } = parityArms(testBackends());

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A database timestamp by shape and by being recent (the clocks of the arms differ). */
const recent = (at: string | undefined) => typeof at === 'string' && ISO_MS.test(at) && Math.abs(Date.parse(at) - Date.now()) < 10 * 60_000;

/** The kinds whose own reads every engine serves once the runner does (batch 1 of the repair-on-Rust plan). */
const B1_KINDS: RepairKind[] = ['contextual-mode', 'connector-checkpoints', 'embedding-effects', 'planner-stats', 'google-file-modes',
  'frontmatter-keys', 'stuck-recovery', 'facts-home'];
/**
 * On an empty brain these applies refuse before the run stores a cursor: frontmatter-keys finds nothing, so its preview
 * saves no set to apply; stuck-recovery needs the version to keep.
 */
const REFUSED_APPLY = new Set<RepairKind>(['frontmatter-keys', 'stuck-recovery']);

/**
 * A result with the generated values reduced to their shape. A preview hash binds the brain id, which each new brain
 * draws at random, so every SHA-256 hex digest is replaced by a marker wherever it appears.
 */
function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  const text = JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } });
  return JSON.parse(text.replace(/\b[0-9a-f]{64}\b/g, '<sha256>'));
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-parity-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('engine parity: the repair runner', () => {
  parityTest('a checkpoint record round-trips its JSON array, its stamp and freshness, and a null write deletes it with its paths', {
    methods: ['readOpCheckpointRecord', 'writeOpCheckpointRecord', 'appendOpCheckpointPaths', 'readOpCheckpointKeys'],
  }, async (engine) => {
    const missing = await engine.readOpCheckpointRecord('repair', 'fp-a', { freshWithinDays: 7 });
    const payload = [{ kind: 'contextual-mode', scope: { brain_id: 'b', source_ids: ['default', 'side'] }, cursor: { phase: 1, id: 7 }, run_id: 'r1' }];
    await engine.writeOpCheckpointRecord('repair', 'fp-a', payload);
    const fresh = await engine.readOpCheckpointRecord('repair', 'fp-a', { freshWithinDays: 7 });
    // A window that ends in the future: no stamp is within it, on any clock.
    const stale = await engine.readOpCheckpointRecord('repair', 'fp-a', { freshWithinDays: -1 });
    const unasked = await engine.readOpCheckpointRecord('repair', 'fp-a');
    // A replace keeps one row; another fingerprint and another op read nothing of it.
    await engine.writeOpCheckpointRecord('repair', 'fp-a', [{ run_id: 'r2', cursor: null }]);
    const replaced = await engine.readOpCheckpointRecord('repair', 'fp-a');
    const other = [await engine.readOpCheckpointRecord('repair', 'fp-b'), await engine.readOpCheckpointRecord('repair-approval', 'fp-a')];
    await engine.appendOpCheckpointPaths('repair', 'fp-a', ['p1']);
    const withPath = await engine.readOpCheckpointKeys('repair', 'fp-a');
    await engine.writeOpCheckpointRecord('repair', 'fp-a', null);
    // Deleting a missing row is a no-op.
    await engine.writeOpCheckpointRecord('repair', 'fp-a', null);
    return {
      missing, other,
      fresh: { completed_keys: fresh?.completed_keys, fresh: fresh?.fresh, stamped: recent(fresh?.updated_at) },
      stale: stale?.fresh, unasked: unasked?.fresh,
      replaced: replaced?.completed_keys, withPath,
      deleted: [await engine.readOpCheckpointRecord('repair', 'fp-a'), await engine.readOpCheckpointKeys('repair', 'fp-a')],
    };
  });

  parityTest('a checkpoint record written in a transaction is read back in it, and a rolled-back write leaves nothing', {
    methods: ['transaction', 'readOpCheckpointRecord', 'writeOpCheckpointRecord'],
  }, async (engine) => {
    const inside = await engine.transaction(async (tx) => {
      await tx.writeOpCheckpointRecord('repair', 'fp-tx', [{ run_id: 'kept' }]);
      return (await tx.readOpCheckpointRecord('repair', 'fp-tx'))?.completed_keys;
    });
    const kept = (await engine.readOpCheckpointRecord('repair', 'fp-tx'))?.completed_keys;
    const rolledBack = await engine.transaction(async (tx) => {
      await tx.writeOpCheckpointRecord('repair', 'fp-tx', null);
      await tx.writeOpCheckpointRecord('repair', 'fp-rb', [{ run_id: 'dropped' }]);
      throw new Error('roll back');
    }).catch((e: Error) => e.message);
    return { inside, kept, rolledBack, after: [(await engine.readOpCheckpointRecord('repair', 'fp-tx'))?.completed_keys, await engine.readOpCheckpointRecord('repair', 'fp-rb')] };
  });

  parityTest('a preview-approval set saves, loads with its stamp, clears inside a transaction, and then refuses preview_changed', {
    methods: ['readOpCheckpointRecord', 'writeOpCheckpointRecord', 'transaction'],
  }, async (engine) => {
    const key = { command: 'stale-atoms' as const, hash: 'h1', previewCommand: 'gbrain repair stale-atoms' };
    const refused = async () => loadApprovedSet(engine, key).then(() => 'loaded', (e: { code?: string }) => e.code);
    const before = await refused();
    // A preview that found nothing approves applying nothing while its hash holds.
    const empty = await loadApprovedSet(engine, { ...key, emptyHash: async () => 'h1' });
    await saveApprovedSet(engine, key, [{ slug: 'a' }, { slug: 'b' }]);
    const loaded = await loadApprovedSet<{ slug: string }>(engine, key);
    const otherCommand = await loadApprovedSet(engine, { ...key, command: 'extractor-facts' }).then(() => 'loaded', (e: { code?: string }) => e.code);
    await engine.transaction((tx) => clearApprovedSet(tx, key));
    return {
      before, empty: { items: empty.items, stamped: recent(empty.approved_at) },
      loaded: { command: loaded.command, hash: loaded.hash, items: loaded.items, stamped: recent(loaded.approved_at) },
      otherCommand, cleared: await refused(),
    };
  });

  parityTest('the scope resolves the brain id and every active source', {
    methods: ['readPersistenceBrainId', 'listAllSources'],
  }, async (engine) => {
    const scope = await resolveRepairScope(engine);
    const narrowed = await resolveRepairScope(engine, 'default');
    const unknown = await resolveRepairScope(engine, 'nope').then(() => 'resolved', (e: { code?: string }) => e.code);
    return { brain: typeof scope.brain_id === 'string' && scope.brain_id.length > 0, sources: scope.source_ids, narrowed: narrowed.source_ids, unknown };
  });

  const previewThenApply = (kind: RepairKind) => async (engine: BrainEngine) => withHome(async () => {
    const scope = await resolveRepairScope(engine);
    const preview = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: { info() {}, warn() {}, error() {} } as never }))
      .run(kind, scope, { explicit: true });
    // An apply that refuses (an empty preview saved no set; a kind that needs a choice the preview lists) refuses
    // with the same code on every engine.
    const applied = await (await repairRunner(engine, { apply: true, noEmbed: true, logger: { info() {}, warn() {}, error() {} } as never }))
      .run(kind, scope, { explicit: true, ...(preview.preview_hash ? { expect: preview.preview_hash } : {}) })
      .then(shape, (e: { code?: string }) => ({ refused: e.code ?? String(e) }));
    return { preview: shape(preview), applied };
  });
  // The Rust store keeps no SQL indexes, so every online-built request index reads as built there (batch 8).
  parityTest('gbrain repair request-indexes finds every request index built and applies nothing', {
    methods: ['readOpCheckpointRecord', 'writeOpCheckpointRecord', 'readPersistenceBrainId', 'readCounterRows'], timeout: 60_000,
  }, previewThenApply('request-indexes'));
  // The cutoff is now minus the retention, so each arm's clock shows in it; the case keeps only its shape (batch 8).
  parityTest('gbrain repair receipt-compaction previews an empty journal and applies nothing', {
    methods: ['readOpCheckpointRecord', 'writeOpCheckpointRecord', 'readPersistenceBrainId', 'readCounterRows', 'readReceiptCompactionWindow',
      'listReceiptCompactionCandidates', 'countKeptFailedReceipts'], timeout: 60_000,
  }, async (engine) => {
    const result = await previewThenApply('receipt-compaction')(engine);
    return JSON.parse(JSON.stringify(result).replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z\b/g, '<cutoff>'));
  });
  parityTest('gbrain repair failed-writes previews an empty journal and applies nothing', {
    methods: ['readOpCheckpointRecord', 'writeOpCheckpointRecord', 'readPersistenceBrainId', 'readCounterRows', 'listFailedWriteRequests', 'listSourceIncarnations'],
    timeout: 60_000,
  }, previewThenApply('failed-writes'));
  parityTest('gbrain repair file-drift surveys a brain with no drift conflicts, and its apply refuses with the same code', {
    methods: ['readDriftConflictBounds', 'listDriftConflictGroups', 'readDriftConflictDetails'],
    timeout: 60_000,
  }, previewThenApply('file-drift'));
  // A Rust store creates every record family when it opens, so it checks PGLite's table list and finds none missing, as
  // a fully migrated PGLite brain does; the empty preview saves no set, so the apply refuses with the same code (batch 9).
  // Postgres expects its own table list (the graduation inventory's postgres column), so the count is checked per engine.
  parityTest('gbrain repair missing-tables checks every expected table, finds none missing, and its apply refuses with the same code', {
    methods: ['readOpCheckpointRecord', 'readPersistenceBrainId', 'readCounterRows', 'getConfig'], timeout: 60_000,
  }, async (engine, backend) => {
    const result = await previewThenApply('missing-tables')(engine);
    const { checked, ...details } = result.preview.details as { checked: number };
    const column = backend === 'postgres' ? 'postgres' : 'pglite';
    expect(checked).toBe(GRADUATION_INVENTORY.entries.filter(e => e.kind === 'table' && e.engines[column]).length);
    return { ...result, preview: { ...result.preview, details } };
  });
  for (const kind of B1_KINDS) {
    if (REFUSED_APPLY.has(kind)) {
      parityTest(`gbrain repair ${kind} previews, and its apply refuses with the same code`, {
        methods: ['readOpCheckpointRecord', 'readPersistenceBrainId', 'readCounterRows'], timeout: 60_000,
      }, previewThenApply(kind));
    } else {
      parityTest(`gbrain repair ${kind} previews and applies with the same result`, {
        methods: ['readOpCheckpointRecord', 'writeOpCheckpointRecord', 'readPersistenceBrainId', 'readCounterRows'], timeout: 60_000,
      }, previewThenApply(kind));
    }
  }
});
