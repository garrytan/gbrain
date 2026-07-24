import { describe, expect, test } from 'bun:test';
import { normalizeAdminClientSourceScope } from '../src/core/admin-source-scope.ts';

describe('admin register-client source scope normalization', () => {
  const sources = ['default', 'team-a', 'team-b'];

  test('defaults write and read scope to default source', () => {
    expect(normalizeAdminClientSourceScope(undefined, undefined, sources)).toEqual({
      sourceId: 'default',
      federatedRead: ['default'],
    });
  });

  test('accepts snake-case body fields with multiple read sources', () => {
    expect(normalizeAdminClientSourceScope('team-a', ['team-a', 'team-b'], sources)).toEqual({
      sourceId: 'team-a',
      federatedRead: ['team-a', 'team-b'],
    });
  });

  test('accepts comma-separated federated_read for API callers', () => {
    expect(normalizeAdminClientSourceScope('team-a', 'team-b, default,team-b', sources)).toEqual({
      sourceId: 'team-a',
      federatedRead: ['team-b', 'default'],
    });
  });

  test('falls back to selected write source when federated_read is empty', () => {
    expect(normalizeAdminClientSourceScope('team-b', [], sources)).toEqual({
      sourceId: 'team-b',
      federatedRead: ['team-b'],
    });
  });

  test('rejects malformed source ids before registration', () => {
    expect(() => normalizeAdminClientSourceScope('../secret', undefined, sources)).toThrow(/Invalid source_id/);
    expect(() => normalizeAdminClientSourceScope('team-a', ['snake_case'], sources)).toThrow(/Invalid federated_read/);
  });

  test('rejects valid-looking but unregistered source ids', () => {
    expect(() => normalizeAdminClientSourceScope('ghost', undefined, sources)).toThrow(/Unknown source_id/);
    expect(() => normalizeAdminClientSourceScope('team-a', ['ghost'], sources)).toThrow(/Unknown federated_read/);
  });
});
