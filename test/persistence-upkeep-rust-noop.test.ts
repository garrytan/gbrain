/**
 * The queue vacuum on a Rust brain (persistence/journal.ts `vacuumPersistenceQueues`): a named no-op with no store work.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: only a PGLite engine vacuums its persistence queues (single-process, no autovacuum); every other engine,
 *    Postgres and Rust alike, answers 0 and sends nothing, so a Rust brain's answer is the Postgres one byte for byte.
 *  - Regression: the step reads pg_class and runs VACUUM through executeRaw; an engine without SQL must never reach it.
 *  - Seam: stand-in engines whose every member throws, so any call the step made would fail the case.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { vacuumPersistenceQueues } from '../src/core/persistence/journal.ts';

const refusing = (kind: string) => new Proxy({ kind } as Record<string, unknown>, {
  get: (target, prop) => (prop === 'kind' ? target.kind : prop === 'then' ? undefined : () => { throw new Error(`unexpected call ${String(prop)}`); }),
}) as unknown as BrainEngine;

test('a Rust brain and a Postgres brain skip the queue vacuum and answer 0 without a store call', async () => {
  expect({ rust: await vacuumPersistenceQueues(refusing('rust')), postgres: await vacuumPersistenceQueues(refusing('postgres')) })
    .toEqual({ rust: 0, postgres: 0 });
});
