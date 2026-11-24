/**
 * Parallel import workers open their own Postgres engines (src/commands/import.ts runImport and
 * src/commands/sync/imports.ts), connected to the configured database_url. That is right only when the brain itself is
 * a Postgres brain. A Rust brain (or PGLite) with DATABASE_URL in the environment must import on its own engine, never
 * through Postgres workers: those would write the pages into a different database, and the sync would block every file
 * as an UNKNOWN import error (engine-parity sync-run on the Rust arm with DATABASE_URL set).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: an import or sync on a non-Postgres brain never fans out to Postgres worker engines.
 * 2. Fails when: the worker choice keys on `engine.kind === 'pglite'` alone (a Rust brain then takes the Postgres branch).
 * 3. Existing coverage: test/engine-parity/sync-run.test.ts covers it end to end only when DATABASE_URL is set while
 *    the Rust arm runs; this pins the decision itself, with no addon or database.
 * 4. Seams: none; a pure function over the engine kind and the configured URL.
 */
import { describe, expect, test } from 'bun:test';
import { usesPostgresImportWorkers } from '../src/core/sync-concurrency.ts';

describe('parallel import workers follow the brain engine', () => {
  test('only a Postgres brain with a database_url imports through Postgres worker engines', () => {
    const url = 'postgres://user@127.0.0.1:5432/brain';
    expect(usesPostgresImportWorkers('postgres', url)).toBe(true);
    expect(usesPostgresImportWorkers('postgres', undefined)).toBe(false);
    expect(usesPostgresImportWorkers('pglite', url)).toBe(false);
    expect(usesPostgresImportWorkers('rust', url)).toBe(false);
    expect(usesPostgresImportWorkers('rust', undefined)).toBe(false);
  });
});
