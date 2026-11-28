/**
 * BrainEngine parity: the "did you mean" text of an unknown source id (src/core/source-resolver.ts `nearestSourceId`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    an unknown `--source` id throws the same "not found" text master throws, byte for byte: it names the one active
 *    source the id is a prefix of, else the nearest active id by edit distance, else nothing. An archived source is
 *    never suggested.
 *  - Regression: the suggestion reads the source list through `listSourceRecords`, which also returns archived rows;
 *    without the active-row filter an archived `notes-old` makes the prefix ambiguous and the suggestion changes.
 *  - Why existing coverage misses it: test/source-suggestion-deadline.test.ts pins the deadline bound on a fake
 *    connection, where no row ever comes back.
 *  - Seam: none. Sources are made and archived through the harness fixtures.
 */
import { expect } from 'bun:test';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { resolveSourceId } from '../../src/core/source-resolver.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const { parityTest } = parityArms(testBackends());

/** Master's text for an unknown source id, with its suggestion when there is one. */
function notFound(id: string, nearest: string | null): string {
  return `Source "${id}" not found or is archived. Available active sources: ` +
    'run `gbrain sources list` to see registered sources, ' +
    `or create/restore "${id}" before retrying.${nearest ? ` Did you mean "${nearest}"?` : ''}`;
}

async function messageFor(engine: BrainEngine, id: string): Promise<string> {
  return resolveSourceId(engine, id, '/nowhere/in/particular', { skipLocalSignals: true }).then(
    (resolved) => `resolved ${resolved}`,
    (error: unknown) => (error as Error).message,
  );
}

parityTest('an unknown source id names the nearest active source and never an archived one', { methods: ['readSourceRow', 'listSourceRecords'] }, async (engine, backend) => {
  await createSource(engine, backend, 'notes-brain');
  await createSource(engine, backend, 'notes-old');
  await archiveSource(engine, backend, 'notes-old');
  await createSource(engine, backend, 'zeta');
  const messages = {
    prefix: await messageFor(engine, 'notes'),
    distance: await messageFor(engine, 'zetta'),
    archived: await messageFor(engine, 'notes-old'),
    none: await messageFor(engine, 'qqqqqqqqqqqq'),
  };
  expect(messages).toEqual({
    prefix: notFound('notes', 'notes-brain'),
    distance: notFound('zetta', 'zeta'),
    archived: notFound('notes-old', null),
    none: notFound('qqqqqqqqqqqq', null),
  });
  return messages;
});
