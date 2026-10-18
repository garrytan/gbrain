/**
 * The unmanaged projection points (docs/designs/BELIEF_LEDGER.md section 4):
 * legacy import, the cycle's `writeFenceReconcile` and takes reextract write
 * outside the shared publication path, so each runs its transaction's
 * projections in an `unmanaged` belief batch over the page keys it holds
 * (sorted, locked before the batch reads its pre-state). A writer nested in
 * an enclosing batch that already records those slugs appends nothing of its
 * own. `commit` marks the publication after the transaction commits; a mark
 * left unwritten (a crash, or a point nested in another batch whose
 * transaction commits later) is filled by doctor or the cycle.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { markBeliefCommits } from './append.ts';
import { beliefBatchCovers, coverageActive, insideBeliefBatch, readLedgerSource, withBeliefBatch } from './ledger.ts';

export function unmanagedBeliefPoint(sourceId: string, slugs: readonly string[], op: string) {
  const sorted = [...new Set(slugs)].sort();
  const publicationId = randomUUID();
  const report = { appended: 0 };
  let nested = false;
  return {
    async run<T>(tx: BrainEngine, fn: () => Promise<T>): Promise<T> {
      if (beliefBatchCovers(sourceId, sorted)) return fn();
      nested = insideBeliefBatch();
      await tx.lockPageKeys(sorted.map(slug => ({ sourceId, slug })));
      return withBeliefBatch(tx, { sourceId, slugs: sorted, op, origin: 'unmanaged', publicationId, report }, fn);
    },
    async commit(engine: Pick<BrainEngine, 'executeRaw'>): Promise<void> {
      if (report.appended && !nested) await markBeliefCommits(engine, [publicationId]);
    },
  };
}

/** One projection-point transaction: `transaction` runs its writes through `run`, and the commit is marked after it returns. */
export async function withUnmanagedBeliefs<T>(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slugs: readonly string[], op: string,
  transaction: (run: <U>(tx: BrainEngine, fn: () => Promise<U>) => Promise<U>) => Promise<T>): Promise<T> {
  const point = unmanagedBeliefPoint(sourceId, slugs, op);
  const result = await transaction((tx, fn) => point.run(tx, fn));
  await point.commit(engine);
  return result;
}

/** The given sources whose ledger records now: a bulk writer wraps only their items. */
export async function beliefCoveredSources(tx: Pick<BrainEngine, 'executeRaw'>, sourceIds: readonly string[]): Promise<Set<string>> {
  const covered = new Set<string>();
  for (const sourceId of new Set(sourceIds)) if (coverageActive((await readLedgerSource(tx, sourceId))?.coverage ?? null)) covered.add(sourceId);
  return covered;
}
