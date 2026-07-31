import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { httpResolveIpcSocket } from '../src/commands/serve-http.ts';

describe('serve --http retrieval-reflex IPC ownership', () => {
  test('PGLite with a database path exposes the canonical resolve socket', () => {
    const databasePath = '/tmp/example-brain.pglite';
    expect(httpResolveIpcSocket({ engine: 'pglite', database_path: databasePath })).toBe(
      join(databasePath, '.gbrain-resolve.sock'),
    );
  });

  test('Postgres and incomplete PGLite configuration do not start local IPC', () => {
    expect(httpResolveIpcSocket({ engine: 'postgres', database_url: 'postgres://example' })).toBeNull();
    expect(httpResolveIpcSocket({ engine: 'pglite' })).toBeNull();
    expect(httpResolveIpcSocket(null)).toBeNull();
  });
});
