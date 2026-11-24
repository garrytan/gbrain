/**
 * BrainEngine parity: the connector sync attempt stamp (`recordConnectorSyncAttempt`, SQL in
 * engine-sql/connector-attempts.ts), which src/core/persistence/connector-state.ts used to run through
 * `engine.executeRaw`, and the unmanaged connector cursor (src/core/connectors/db-cursor.ts: `writeConnectorDbCursor`,
 * SQL in engine-sql/connector-db-cursor.ts, read back through readOpCheckpointRecord). Every connector sync stamps the
 * attempt first; the meetings, slack, apple-contacts and imessage kinds keep their cursor in the cursor row.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the first attempt on a source writes the seed state row under connectorStateKey(source, incarnation)
 *    and returns true; a second attempt keeps the stamp and every other field; a row with no stamp gets the attempt's
 *    time in its first record and keeps its other fields; an unknown source returns false and writes nothing. The
 *    stored record reads back as the same JSON text, keys in jsonb order, on every arm. The autopilot gate
 *    (attemptedConnectorSourceIds) is not part of this case. A cursor write creates the row, a rewrite takes the new
 *    state and last run (a JSON null last run included), and a record with no last_run key keeps the stored one.
 *  - Regression: an engine that refuses the stamp as raw SQL (the Rust engine did, so every connector sync stopped
 *    before it started), overwrites an existing stamp, drops the row's other fields, keys the row differently, or
 *    writes a row for a missing source.
 *  - Why existing coverage misses it: test/connector-*.test.ts run on PGLite only.
 *  - Seam: none. The caller's own function over the typed member; the row reads back through readOpCheckpointRecord.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { CONNECTOR_STATE_OP, connectorStateKey, recordConnectorSyncAttempt } from '../../src/core/persistence/connector-state.ts';
import { CONNECTOR_DB_CURSOR_OP, readConnectorDbCursor, writeConnectorDbCursor } from '../../src/core/connectors/db-cursor.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { createSource, parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const incarnationOf = async (engine: BrainEngine, id: string) => String((await engine.readSourceState(id))!.incarnation);

/** The stored state row as JSON text, or null. */
async function stored(engine: BrainEngine, sourceId: string): Promise<string | null> {
  const row = await engine.readOpCheckpointRecord(CONNECTOR_STATE_OP, connectorStateKey(sourceId, await incarnationOf(engine, sourceId)));
  return row ? JSON.stringify(row.completed_keys) : null;
}

describe('engine parity: connector sync attempts', () => {
  parityTest('the first attempt stamps the state row, a later one keeps the stamp, and an unknown source returns false',
    { methods: ['recordConnectorSyncAttempt', 'readOpCheckpointRecord', 'writeOpCheckpointRecord', 'readSourceState'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'gh-example', { kind: 'github' });
      await createSource(engine, backend, 'mt-example', { kind: 'meetings' });
      const steps: Record<string, unknown> = {};
      steps.first = await recordConnectorSyncAttempt(engine, 'gh-example', '2026-01-01T00:00:00.000Z');
      steps.firstRow = await stored(engine, 'gh-example');
      steps.second = await recordConnectorSyncAttempt(engine, 'gh-example', '2026-02-01T00:00:00.000Z');
      steps.secondRow = await stored(engine, 'gh-example');
      // A state row a lease holder wrote before any attempt: the stamp goes into its first record, the rest stays.
      const key = connectorStateKey('mt-example', await incarnationOf(engine, 'mt-example'));
      await engine.writeOpCheckpointRecord(CONNECTOR_STATE_OP, key, [{ version: 1, account: { kind: 'meetings', id: 'acct-1' }, first_attempt_at: null, pending: ['m-1'] }]);
      steps.unstamped = await recordConnectorSyncAttempt(engine, 'mt-example', '2026-03-01T00:00:00.000Z');
      steps.unstampedRow = await stored(engine, 'mt-example');
      steps.unknown = await recordConnectorSyncAttempt(engine, 'missing-example', '2026-04-01T00:00:00.000Z');
      steps.unknownRow = await engine.readOpCheckpointRecord(CONNECTOR_STATE_OP, connectorStateKey('missing-example', '1'));

      const seed = '[{"account":null,"pending":[],"version":1,"last_run":null,"pinned_at":null,"last_failure":null,"purged_items":[],'
        + '"resumed_from":null,"account_mismatch":null,"first_attempt_at":"2026-01-01T00:00:00.000Z","upgrade_recovery":"none",'
        + '"continuity_unverified":false}]';
      expect(steps).toEqual({
        first: true, firstRow: seed,
        second: true, secondRow: seed,
        unstamped: true,
        unstampedRow: '[{"account":{"id":"acct-1","kind":"meetings"},"pending":["m-1"],"version":1,"first_attempt_at":"2026-03-01T00:00:00.000Z"}]',
        unknown: false, unknownRow: null,
      });
      return steps;
    });

  parityTest('the connector cursor row is created, rewritten, and keeps its last run only when the record has no last_run key',
    { methods: ['writeConnectorDbCursor', 'readOpCheckpointRecord'] },
    async (engine) => {
      const key = 'cursor-key-example';
      const run = { run_id: 'run-1', finished_at: '2026-01-01T00:00:00.000Z', counts: { added: 2 } };
      const text = async () => JSON.stringify((await engine.readOpCheckpointRecord(CONNECTOR_DB_CURSOR_OP, key))?.completed_keys ?? null);
      const steps: Record<string, unknown> = {};
      await writeConnectorDbCursor(engine, key, { since: 'a', seen: { m1: { path: 'x.md' } } }, run);
      steps.created = await text();
      steps.read = await readConnectorDbCursor(engine, key);
      await engine.writeConnectorDbCursor(key, [{ version: 1, state: { since: 'b' } }]);
      steps.kept = await text();
      await writeConnectorDbCursor(engine, key, { since: 'c' });
      steps.nulled = await text();
      steps.missing = await readConnectorDbCursor(engine, 'missing-cursor-example');
      expect(steps).toEqual({
        created: '[{"state":{"seen":{"m1":{"path":"x.md"}},"since":"a"},"version":1,"last_run":{"counts":{"added":2},"run_id":"run-1","finished_at":"2026-01-01T00:00:00.000Z"}}]',
        read: { state: { seen: { m1: { path: 'x.md' } }, since: 'a' }, lastRun: { counts: { added: 2 }, run_id: 'run-1', finished_at: '2026-01-01T00:00:00.000Z' } },
        kept: '[{"state":{"since":"b"},"version":1,"last_run":{"counts":{"added":2},"run_id":"run-1","finished_at":"2026-01-01T00:00:00.000Z"}}]',
        nulled: '[{"state":{"since":"c"},"version":1,"last_run":null}]',
        missing: { state: null, lastRun: null },
      });
      return steps;
    });
});
