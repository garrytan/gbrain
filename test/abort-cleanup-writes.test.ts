/**
 * A cleanup write that was never an `executeRaw` call must still land after the request that owns it was cancelled.
 *
 * Protects:
 * - `setBodyStagingState(id, 'aborted')`, which every body-staging abort path calls from its catch block behind
 *   `.catch(() => undefined)`, sends its UPDATE for a cancelled request (the member ran on the plain `engineSql`
 *   before the typed-member move and must keep doing so; a refusal here would leave the staging open until expiry);
 * - a member that replaced an `executeRaw` call (`getTrustProposal`) still refuses the cancelled request and sends nothing.
 * Fails when the plain `engineSql` getter refuses a cancelled request, or a moved member stops refusing.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
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

test('the staging abort mark is sent for a cancelled request', async () => {
  const { fake, engine } = fakeEngine();
  await withRequestSignal(aborted(), () => engine.setBodyStagingState('stage-1', 'aborted'));
  expect(fake.statements()).toHaveLength(1);
});

test('a moved member still refuses a cancelled request and sends nothing', async () => {
  const { fake, engine } = fakeEngine();
  const error = await withRequestSignal(aborted(), () => engine.getTrustProposal(1)).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements()).toHaveLength(0);
});
