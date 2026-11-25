/**
 * A transaction callback may run more than once: on a Rust brain in multi-user mode a commit that loses a conflict
 * keeps nothing and the engine runs the callback again from a fresh snapshot (docs/designs/rust-engine/multi-user-server.md,
 * "Skip guarantees"). A caller that keeps a count or a flag outside the callback must start each run from the same
 * state. Each case drives the real caller on a stub engine whose `transaction(fn)` runs `fn` twice and keeps only the
 * second run, as a lost optimistic commit does, and checks the caller reports the second run only.
 */
import { describe, expect, test } from 'bun:test';
import { restampSource } from '../src/core/access/policy.ts';
import { insertBackupRows } from '../src/core/secret-store/store.ts';
import { deleteOrphanConnectorCheckpoints } from '../src/core/persistence/connector-checkpoint-migration.ts';

/** A stub engine: `members` answer by name; `transaction(fn)` runs fn on the engine twice, keeping the second result. */
function rerunningEngine(members: Record<string, (...args: never[]) => unknown>): never {
  const engine: Record<string, unknown> = { ...members };
  engine.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    await fn(engine); // the run that loses its commit: its writes are dropped, the callback is not told
    return fn(engine);
  };
  return engine as never;
}

describe('a transaction callback that runs again counts only its last run', () => {
  test('restampSource counts the pages the final pass restamped once', async () => {
    const engine = rerunningEngine({
      readAccessStateUnreadable: async () => false,
      restampAccessWindow: async () => ({ last: null, scanned: 0, changed: 0 }),
      lockAccessPolicy: async () => undefined,
      finishAccessRestamp: async () => 3,
    });
    expect((await restampSource(engine, 'default')).pages_restamped).toBe(3);
  });

  test('insertBackupRows counts each restored entry once', async () => {
    const engine = rerunningEngine({
      insertBackupSecretEntry: async () => true,
      readBackupEntryHold: async () => null,
      insertBackupSecretOccurrence: async () => true,
      deleteUnreferencedSecretEntry: async () => false,
    });
    const entry = { id: 'entry-1', source_id: 'default', value_mac: 'mac' } as never;
    const occurrence = { entry_id: 'entry-1', commit_sha: 'abc', slug: null } as never;
    expect(await insertBackupRows(engine, [entry], [occurrence])).toEqual({ entries: 1, occurrences: 1, skipped_no_page: 0 });
  });

  test('deleteOrphanConnectorCheckpoints counts each removed row once', async () => {
    const engine = rerunningEngine({
      listConnectorSources: async () => [],
      deleteOrphanConnectorCheckpoint: async () => true,
    });
    const rows = [{ op: 'managed-connector' }, { op: 'retry' }] as never;
    expect(await deleteOrphanConnectorCheckpoints(engine, rows)).toEqual({ checkpoints: 1, retries: 1 });
  });
});
