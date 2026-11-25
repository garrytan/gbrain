/**
 * PR B refresh write barrier: every SQL or TypeScript test of a write request's open states decides about `deferred`.
 *
 * Protects: a write deferred behind a refresh is a durable, non-terminal request. Checks that must not proceed past an
 * accepted write (activation, deactivation, graduation, topology changes, staging retention, purges, redaction,
 * watermarks, capacity and diagnostics) list `deferred`; claim and head-of-queue selectors name released deferred rows
 * through RELEASED_DEFERRED; managed-sync checks deliberately leave deferred rows out, so a refresh's own member syncs are
 * never held behind writes that wait for that refresh. TypeScript checks read receipts, where a deferred row reads as
 * `queued`, or rows of producers that never defer.
 * Regression it catches: a new `('queued','running','recovering')` list added without that decision (for example the
 * staging sweep, which would expire the body of a waiting write).
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OPEN_WITHOUT_DEFERRED = /'queued', ?'running', ?'recovering'/g;

/** Files whose open-state lists leave `deferred` out on purpose, with how many such lists each holds. */
const DECIDED: Record<string, { count: number; why: string }> = {
  'src/commands/book-mirror.ts': { count: 1, why: 'receipt state (a deferred row reads as queued)' },
  'src/core/engine-sql/doctor-sync.ts': { count: 3, why: 'the managed-sync failure and orphan reads, written out from managed-sync-orphans.ts and sync-failures.ts (test/doctor-sync-sql.test.ts pins the copy): managed sync' },
  'src/core/engine-sql/doctor-terminal.ts': { count: 6, why: 'the terminal-failure aggregate and batch, written out from terminal-failures.ts and terminal-classify.ts (test/doctor-terminal-sql.test.ts pins the copy): the classifier lists sync knock-ons and managed sync' },
  'src/core/engine-sql/persistence-claims.ts': { count: 7, why: 'copies of journal.ts lists, pinned by test/persistence-journal-statements.test.ts. The claimable-row test (claimableWriteSql): its two EARLIER_HEAD lists, with the written-out EARLIER_DEFERRED probe and RELEASED_DEFERRED beside them. The FIFO head read (claimHeadText): its waiting list pairs RELEASED_DEFERRED, its two named-sync lists match managed sync rows, which are never deferred, and its two EARLIER_HEAD lists sit beside the EARLIER_DEFERRED probe (worktree rows) or match rows with no worktree, which are never deferred; test/claim-head-deferred-decisions.test.ts proves each' },
  'src/core/engine-sql/managed-sync-orphans.ts': { count: 4, why: 'managed sync' },
  'src/core/engine-sql/sync-status-reads.ts': { count: 1, why: 'managed sync: the drain stall probe head-request read moved here from sync-drain.ts' },
  'src/core/engine-sql/persistence-housekeeping.ts': { count: 2, why: 'the compaction listing writes out terminal-classify.ts supersessionSql (test/persistence-journal-statements.test.ts pins the copy): the same two lists and the same decision' },
  'src/core/engine-sql/head-blocker.ts': { count: 1, why: "the head-blocker probe's earlier-request list (#6543) writes out the journal's EARLIER_HEAD list, with the released-deferred probe (a deferred row whose refresh released or whose import moved on) written out beside it, as persistence-claims.ts does; test/persistence-journal-statements.test.ts pins it against the journal fragments" },
  'src/core/engine-sql/dream-cycle.ts': { count: 1, why: 'cycle producer, never deferred (listLaterPersistenceRequests, moved from cycle/synthesize-postprocess.ts)' },
  'src/core/engine-sql/facts-trust.ts': { count: 1, why: 'facts producer, never deferred (readPendingWriteReceipt, moved from facts/absorb-log.ts)' },
  'src/core/rust-engine/store-members/facts-write-path.ts': { count: 1, why: 'the store copy of readPendingWriteReceipt (engine-sql/facts-trust.ts): the same facts-producer list, never deferred' },
  'src/core/generations/managed-retire.ts': { count: 1, why: 'maintenance producer, never deferred' },
  'src/core/minions/handlers/subagent-oneshot.ts': { count: 1, why: 'receipt state' },
  'src/core/minions/tool-write-identity.ts': { count: 1, why: 'receipt state' },
  'src/core/persistence/atom-maintenance.ts': { count: 3, why: 'maintenance producer, never deferred' },
  'src/core/persistence/atom-retry.ts': { count: 2, why: 'receipt state' },
  'src/core/persistence/managed-sync-orphans.ts': { count: 3, why: 'managed sync: the checkpoint-moved, slug-mode-refused and pass-stamp orphan lists the doctor tests pin, kept as exports here when the engine-sql copy took the repair reads (batch 10 merge of cli-members-next)' },
  'src/core/persistence/checkpoint-validation-sql.ts': { count: 2, why: 'managed sync: the checkpoint validation statements, moved byte for byte from checkpoint-validation.ts' },
  'src/core/persistence/journal.ts': { count: 6, why: 'claim and head selectors pair the list with RELEASED_DEFERRED (EARLIER_HEAD with its own EARLIER_DEFERRED probe); the two named-sync lists match sync rows, never deferred; the rest are recovery rules' },
  'src/core/engine-sql/refresh-store.ts': { count: 2, why: 'the downgrade backlog (moved from persistence/refresh-barrier.ts) names deferred ahead of the open states: a released deferred row that is still queued or running has not published; the drain count (moved from persistence/worktree-refresh.ts) counts released deferred rows through the written-out RELEASED_DEFERRED' },
  'src/core/engine-sql/group-publish-store.ts': { count: 1, why: 'the follower candidates (moved from persistence/journal.ts claimGroupFollowers) pair the list with the written-out RELEASED_DEFERRED' },
  'src/core/persistence/page-batch.ts': { count: 1, why: 'batches are never deferred' },
  'src/core/persistence/schema.ts': { count: 3, why: 'the original state CHECK and partial indexes; deferred rows have their own index' },
  'src/core/persistence/sync-admission-sql.ts': { count: 1, why: 'managed sync' },
  'src/core/persistence/sync-cursor-key.ts': { count: 2, why: 'managed sync' },
  'src/core/persistence/sync-drain.ts': { count: 1, why: 'managed sync' },
  'src/core/persistence/sync-dry-run-writer.ts': { count: 1, why: 'managed sync' },
  'src/core/engine-sql/applied-watermark-reads.ts': { count: 1, why: 'managed sync (the movement watermark, moved from persistence/sync-movement.ts)' },
  'src/core/persistence/sync-pass-batch.ts': { count: 1, why: 'managed sync' },
  'src/core/persistence/sync-pass-carried.ts': { count: 2, why: 'managed sync' },
  'src/core/persistence/sync-pass-run.ts': { count: 3, why: 'managed sync' },
  'src/core/persistence/sync-pass.ts': { count: 3, why: 'managed sync' },
  'src/core/persistence/sync-run.ts': { count: 4, why: 'managed sync' },
  'src/core/persistence/sync-waivers.ts': { count: 2, why: 'managed sync' },
  'src/core/persistence/sync-window.ts': { count: 1, why: 'managed sync' },
  'src/core/persistence/terminal-classify.ts': { count: 2, why: 'classifies sync knock-ons' },
  'src/core/persistence/types.ts': { count: 1, why: 'the public receipt states, where deferred reads as queued' },
  'src/core/rust-engine/store-members/managed-sync-orphans.ts': { count: 1, why: 'managed sync (the Rust members mirror engine-sql/managed-sync-orphans.ts)' },
  'src/core/shared-skills/retention.ts': { count: 1, why: 'skill bundles are never deferred' },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.ts') && !name.includes('.generated.')) out.push(path);
  }
  return out;
}

test('every open-state list of write requests either names deferred or is a recorded decision', () => {
  const found: Record<string, number> = {};
  for (const file of walk('src')) {
    const count = readFileSync(file, 'utf8').match(OPEN_WITHOUT_DEFERRED)?.length ?? 0;
    if (count) found[file] = count;
  }
  const undecided = Object.entries(found).filter(([file, count]) => DECIDED[file]?.count !== count)
    .map(([file, count]) => `${file}: ${count} list(s) without 'deferred' (recorded: ${DECIDED[file]?.count ?? 0})`);
  const stale = Object.keys(DECIDED).filter(file => !found[file]);
  expect({ undecided, stale }).toEqual({ undecided: [], stale: [] });
});
