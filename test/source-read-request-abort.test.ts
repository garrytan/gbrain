/**
 * `getSource` replaced a raw `executeRaw` source lookup in the write-through resolver (core/write-through.ts), the
 * sync connector (commands/sync/connector.ts) and the incremental-sync preflight (commands/sync/preflight.ts, after its
 * git steps). `executeRaw` refused an already-aborted request before sending SQL (GBRA-156); the typed member must
 * keep that on Postgres, as PGLite and the Rust engine do.
 *
 * Protects:
 * - an aborted request calling `getSource` rejects with the request's AbortError and sends no statement (the member the
 *   preflight at preflight.ts:406 calls; its caller sits behind git steps, so the member itself is what is pinned);
 * - `resolvePageWriteTarget` and `runConnectorSync` under an aborted request send no SQL at all;
 * - a request that is not aborted still reads the source row.
 * Fails when `PostgresEngine.getSource` stops checking the request signal before its statement.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { resolvePageWriteTarget } from '../src/core/write-through.ts';
import { runConnectorSync } from '../src/commands/sync/connector.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error('client went away'));
  return controller.signal;
}

function fakeEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return { fake, engine: engine as unknown as BrainEngine };
}

test('getSource inside an aborted request is refused and sends no statement', async () => {
  const { fake, engine } = fakeEngine();
  const error = await withRequestSignal(aborted(), () => engine.getSource('default')).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements()).toHaveLength(0);
});

test('resolvePageWriteTarget inside an aborted request sends no SQL', async () => {
  const { fake, engine } = fakeEngine();
  const error = await withRequestSignal(aborted(), () => resolvePageWriteTarget(engine, 'notes/a', 'default')).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements()).toHaveLength(0);
});

test('runConnectorSync inside an aborted request sends no SQL', async () => {
  const { fake, engine } = fakeEngine();
  const opts = { sourceId: 'default' } as SyncOpts;
  const error = await withRequestSignal(aborted(), () => runConnectorSync(engine, opts, false)).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements()).toHaveLength(0);
});

test('getSource outside an aborted request still sends its one statement', async () => {
  const { fake, engine } = fakeEngine();
  await engine.getSource('default');
  expect(fake.statements()).toHaveLength(1);
});
