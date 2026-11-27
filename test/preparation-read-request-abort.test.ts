/**
 * Typed reads that replaced `executeRaw` run through `PostgresEngine.preparationRead`. Master's `executeRaw` refused an
 * aborted request before EVERY statement (GBRA-156), so a two-statement read whose request ends between the statements
 * sent only the first. Without a read deadline (or with `lock`), `preparationRead` must keep that per-statement check,
 * as its deadline branch already does.
 *
 * Protects:
 * - `readAccessTokenWriteGrant` (a column probe, then the grant row): a request that aborts during the probe rejects
 *   with its AbortError and sends exactly one statement, with and without `lock` (no `FOR SHARE` row lock taken);
 * - a request that is never aborted still sends both statements.
 * Fails when the no-deadline branch of `preparationRead` hands its reader an executor without the abort check.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

const TOKEN = '00000000-0000-0000-0000-000000000001';

function engineAbortingOnProbe(controller: AbortController | null) {
  const fake = makeFakeSql(stmt => {
    if (stmt.text.includes('pg_attribute')) { controller?.abort(new Error('client went away')); return [{ attname: 'id' }]; }
    return [];
  });
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return { fake, engine };
}

for (const lock of [false, true]) {
  test(`readAccessTokenWriteGrant (lock=${lock}) sends no second statement after the request aborts`, async () => {
    const controller = new AbortController();
    const { fake, engine } = engineAbortingOnProbe(controller);
    const error = await withRequestSignal(controller.signal, () => engine.readAccessTokenWriteGrant(TOKEN, { lock })).then(() => null, (e: unknown) => e);
    expect((error as Error | null)?.name).toBe('AbortError');
    expect(fake.statements()).toHaveLength(1);
  });
}

test('readAccessTokenWriteGrant outside an aborted request still sends both statements', async () => {
  const { fake, engine } = engineAbortingOnProbe(null);
  expect(await engine.readAccessTokenWriteGrant(TOKEN)).toBeNull();
  expect(fake.statements()).toHaveLength(2);
});
