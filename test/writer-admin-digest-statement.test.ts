/**
 * The writer-admin digest has one statement. `gbrain sources writer status` hands out `writerAdminState`'s digest as the
 * reviewed `--expected-state`, and every administrative request checks it against `readWriterAdminState`
 * (engine-sql/writer-admin.ts, via `assertWriterAdminState`). That statement orders sources, bindings and locks in byte
 * order (`COLLATE "C"`), so the digest does not depend on the server's locale. If the status digest came from another
 * copy of the statement that sorts by the database's own collation, a brain on an en_US.utf8 server would refuse a
 * freshly reviewed state as `writer_admin_state_changed` as soon as two source ids sort differently in the two orders
 * (`a-b` and `aa`).
 *
 * Protects: `writerAdminState` and `readWriterAdminState` send the same statement text and parameters.
 * Fails when either goes back to its own copy of the statement.
 * No database: the engine is a recording `executeRaw`. The Postgres case is test/e2e/writer-admin-digest-locale-postgres.test.ts.
 */
import { expect, test } from 'bun:test';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { readWriterAdminState } from '../src/core/engine-sql/writer-admin.ts';

function recorder() {
  const sent: Array<{ text: string; params: unknown[] | undefined }> = [];
  return {
    sent,
    executeRaw: async (text: string, params?: unknown[]) => { sent.push({ text: text.replace(/\s+/g, ' ').trim(), params }); return [{ state: '{}' }]; },
  };
}

test('the status digest and the digest a request checks read the writer topology with one statement', async () => {
  const status = recorder();
  const check = recorder();
  await writerAdminState(status as never);
  await readWriterAdminState(check as never);
  expect(status.sent).toHaveLength(1);
  expect(check.sent).toHaveLength(1);
  expect(status.sent[0]).toEqual(check.sent[0]!);
});
