import { describe, test, expect } from 'bun:test';
import { resolveOwnerHolder, DEFAULT_OWNER_HOLDER } from '../src/core/owner-holder.ts';

describe('owner-holder', () => {
  test('DEFAULT_OWNER_HOLDER is self', () => {
    expect(DEFAULT_OWNER_HOLDER).toBe('self');
  });

  test('defaults to self when nothing provided', () => {
    expect(resolveOwnerHolder({})).toBe('self');
  });

  test('null/undefined config falls back to self', () => {
    expect(resolveOwnerHolder({ configValue: null })).toBe('self');
    expect(resolveOwnerHolder({ configValue: undefined })).toBe('self');
  });

  test('uses config value when set and no override', () => {
    expect(resolveOwnerHolder({ configValue: 'people/charlie-example' }))
      .toBe('people/charlie-example');
  });

  test('override beats config and default', () => {
    expect(resolveOwnerHolder({ override: 'world', configValue: 'people/charlie-example' }))
      .toBe('world');
  });
});
