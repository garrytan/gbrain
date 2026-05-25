import { describe, expect, test } from 'bun:test';
import { resolveIngestSourceId } from '../../src/commands/serve-http.ts';
import type { AuthInfo } from '../../src/core/operations.ts';

describe('POST /ingest source scope resolution', () => {
  const auth: AuthInfo = {
    token: 'test',
    clientId: 'simon-ambient-capture',
    scopes: ['read', 'write'],
    sourceId: 'capture-events',
    allowedSources: ['capture-events'],
  };

  test('defaults writes to the OAuth client source', () => {
    expect(resolveIngestSourceId(auth)).toBe('capture-events');
  });

  test('accepts an explicit source only when it matches the OAuth client source', () => {
    expect(resolveIngestSourceId(auth, 'capture-events')).toBe('capture-events');
  });

  test('rejects source header attempts to write into another source', () => {
    expect(() => resolveIngestSourceId(auth, 'shared')).toThrow(
      'Requested ingest source is outside caller write scope',
    );
  });

  test('legacy auth without source falls back to default, not caller-controlled source', () => {
    const legacyAuth: AuthInfo = {
      token: 'test',
      clientId: 'legacy-client',
      scopes: ['read', 'write'],
    };
    expect(resolveIngestSourceId(legacyAuth)).toBe('default');
    expect(() => resolveIngestSourceId(legacyAuth, 'shared')).toThrow(
      'Requested ingest source is outside caller write scope',
    );
  });
});
