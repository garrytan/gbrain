/**
 * guardOwnership sends its worktree share lock synchronously, so a caller that pipelines it with source locks keeps
 * worktrees locked before sources (scripts/persistence/lock-order.ts `worktrees_before_sources`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a Postgres transaction, `pipelined(tx, [() => guardOwnership(...), () => <source lock>])` sends the
 *    `persistence_worktrees ... FOR SHARE` statement before the `sources ... FOR SHARE` one, as group-publish.ts sends
 *    its guards and lockPageKeys.
 *  - Regression: guardOwnership opened the publication journal store itself (`await tx.publicationJournalStore()`)
 *    before its worktree lock. That await yields, so the pipeline sent lockPageKeys' source lock first: a group
 *    publication locked a source before its worktree, the inversion the crash robot reported on Postgres
 *    (overlapping_slugs_two_sources, seed 5105, hung_git).
 *  - Why existing coverage misses it: the lock-order tests in persistence-crash-robot.test.ts run on PGLite, where
 *    `pipelined` awaits each call in turn, and the robot reaches a group publication on Postgres only under some timings.
 *  - Seam: a fake Postgres transaction that records the order its statements are sent in; no database.
 */
import { describe, expect, test } from 'bun:test';
import { guardOwnership } from '../src/core/persistence/ownership.ts';
import { pipelined } from '../src/core/page-state/transactions.ts';
import { publicationJournalStore } from '../src/core/engine-sql/publication-journal.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';

const WORKTREE = '00000000-0000-4000-8000-0000000000a1';
const INCARNATION = '00000000-0000-4000-8000-0000000000b2';
const HOST = 'host-a';

function fakePostgresTx() {
  const sent: string[] = [];
  const tx = {
    kind: 'postgres' as const,
    async executeRaw(sql: string) {
      sent.push(sql.replace(/\s+/g, ' ').trim());
      // Answer after a turn, as a real round trip does: every pipelined statement is sent before any answer arrives.
      await new Promise(resolve => setTimeout(resolve, 1));
      if (/FROM persistence_worktrees/.test(sql)) return [{ owner_host_id: HOST, owner_epoch: 1, state: 'active' }];
      return [{ incarnation: INCARNATION }];
    },
    async getWorktreeBinding() {
      sent.push('getWorktreeBinding');
      return { worktree_id: WORKTREE, source_incarnation: INCARNATION, topology_generation: 1, owner_epoch: 1 };
    },
    publicationJournalStore() { return publicationJournalStore(tx as never); },
  };
  return { tx, sent };
}

const row = { worktree_id: WORKTREE, source_id: 'robot-0', source_incarnation: INCARNATION, topology_generation: 1, request_id: 'r-1' } as unknown as WriteRequest;

describe('guardOwnership lock order', () => {
  test('pipelined with a source lock, the worktree share lock is sent first', async () => {
    const { tx, sent } = fakePostgresTx();
    const journal = await tx.publicationJournalStore();
    sent.length = 0;
    const [binding] = await pipelined(tx, [
      () => guardOwnership(tx as never, journal, row, HOST),
      () => tx.executeRaw('SELECT incarnation FROM sources WHERE id=$1 FOR SHARE'),
    ]);
    expect(binding).toMatchObject({ worktree_id: WORKTREE });
    const worktree = sent.findIndex(sql => sql.includes('FROM persistence_worktrees') && sql.endsWith('FOR SHARE'));
    const source = sent.findIndex(sql => sql.includes('FROM sources') && sql.endsWith('FOR SHARE'));
    expect(worktree).toBeGreaterThanOrEqual(0);
    expect(source).toBeGreaterThanOrEqual(0);
    expect({ worktree, source, before: worktree < source }).toEqual({ worktree, source, before: true });
  });
});
