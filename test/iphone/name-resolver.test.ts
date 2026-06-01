import { describe, expect, test } from 'bun:test';
import { buildNameResolver, normalizeHandle } from '../../src/core/iphone/name-resolver.ts';
import type { ContactRecord } from '../../src/core/iphone/types.ts';

const contacts: ContactRecord[] = [
  {
    recordId: 1,
    firstName: 'Alice',
    lastName: 'Example',
    organization: 'acme-example',
    phones: ['+15550000001'],
    emails: ['alice@acme-example.com'],
  },
];

describe('iPhone name resolver', () => {
  test('maps phone and email handles to display names', () => {
    const resolver = buildNameResolver(contacts, { selfName: 'Me' });

    expect(resolver.resolveHandle('+1 (555) 000-0001')).toBe('Alice Example');
    expect(resolver.resolveHandle('ALICE@ACME-EXAMPLE.COM')).toBe('Alice Example');
  });

  test('falls back to the raw handle when no contact matches', () => {
    const resolver = buildNameResolver(contacts);
    expect(resolver.resolveHandle('+15550000999')).toBe('+15550000999');
  });

  test('normalizes handles consistently', () => {
    expect(normalizeHandle('+1 (555) 000-0001')).toBe('+15550000001');
    expect(normalizeHandle('ALICE@ACME-EXAMPLE.COM')).toBe('alice@acme-example.com');
  });
});
