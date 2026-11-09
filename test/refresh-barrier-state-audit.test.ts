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
  'src/core/cycle/synthesize-postprocess.ts': { count: 1, why: 'cycle producer, never deferred' },
  'src/core/facts/absorb-log.ts': { count: 1, why: 'facts producer, never deferred' },
  'src/core/generations/managed-retire.ts': { count: 1, why: 'maintenance producer, never deferred' },
  'src/core/minions/handlers/subagent-oneshot.ts': { count: 1, why: 'receipt state' },
  'src/core/minions/tool-write-identity.ts': { count: 1, why: 'receipt state' },
  'src/core/persistence/atom-maintenance.ts': { count: 3, why: 'maintenance producer, never deferred' },
  'src/core/persistence/atom-retry.ts': { count: 2, why: 'receipt state' },
  'src/core/persistence/checkpoint-validation.ts': { count: 2, why: 'managed sync' },
  'src/core/persistence/journal.ts': { count: 7, why: 'claim and head selectors pair the list with RELEASED_DEFERRED (EARLIER_HEAD with its own EARLIER_DEFERRED probe); the two named-sync lists match sync rows, never deferred; the rest are recovery rules' },
  'src/core/persistence/managed-sync-orphans.ts': { count: 4, why: 'managed sync' },
  'src/core/persistence/refresh-barrier.ts': { count: 1, why: 'the downgrade backlog names deferred ahead of the open states: a released deferred row that is still queued or running has not published' },
  'src/core/persistence/page-batch.ts': { count: 1, why: 'batches are never deferred' },
  'src/core/persistence/schema.ts': { count: 3, why: 'the original state CHECK and partial indexes; deferred rows have their own index' },
  'src/core/persistence/sync-admission.ts': { count: 1, why: 'managed sync' },
  'src/core/persistence/sync-cursor-key.ts': { count: 2, why: 'managed sync' },
  'src/core/persistence/sync-drain.ts': { count: 2, why: 'managed sync' },
  'src/core/persistence/sync-dry-run-writer.ts': { count: 1, why: 'managed sync' },
  'src/core/persistence/sync-movement.ts': { count: 1, why: 'managed sync' },
  'src/core/persistence/sync-pass-batch.ts': { count: 1, why: 'managed sync' },
  'src/core/persistence/sync-pass-carried.ts': { count: 2, why: 'managed sync' },
  'src/core/persistence/sync-pass-run.ts': { count: 3, why: 'managed sync' },
  'src/core/persistence/sync-pass.ts': { count: 3, why: 'managed sync' },
  'src/core/persistence/sync-run.ts': { count: 4, why: 'managed sync' },
  'src/core/persistence/sync-waivers.ts': { count: 2, why: 'managed sync' },
  'src/core/persistence/sync-window.ts': { count: 1, why: 'managed sync' },
  'src/core/persistence/terminal-classify.ts': { count: 2, why: 'classifies sync knock-ons' },
  'src/core/persistence/terminal-failures.ts': { count: 2, why: 'managed sync' },
  'src/core/persistence/types.ts': { count: 1, why: 'the public receipt states, where deferred reads as queued' },
  'src/core/persistence/worktree-refresh.ts': { count: 1, why: 'the drain counts released deferred rows through RELEASED_DEFERRED' },
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
