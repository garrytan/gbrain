import { describe, expect, test } from 'bun:test';
import { opAllowedForBoundClient, operations } from '../src/core/operations.ts';

describe('OAuth bound_tools HTTP enforcement', () => {
  const mcpOperations = operations.filter(op => !op.localOnly);
  const filterBound = (boundTools: string[] | undefined) => mcpOperations.filter(op =>
    opAllowedForBoundClient({ boundTools }, op),
  );
  const allowed = (name: string, boundTools: string[] | undefined) =>
    opAllowedForBoundClient({ boundTools }, operations.find(op => op.name === name)!);

  test('a binding exposes exactly its listed tools', () => {
    const visible = filterBound(['create_page', 'get_page']);

    expect(visible.map(op => op.name).sort()).toEqual(['create_page', 'get_page']);
    expect(visible.some(op => op.name === 'put_page')).toBe(false);
  });

  test('an empty binding denies every tool', () => {
    expect(filterBound([])).toEqual([]);
    expect(allowed('get_page', [])).toBe(false);
  });

  test('an absent binding preserves the existing MCP surface', () => {
    expect(filterBound(undefined)).toEqual(mcpOperations);
    expect(allowed('put_page', undefined)).toBe(true);
  });

  test('call authorization is exact and independent from OAuth write scope', () => {
    const binding = ['create_page', 'get_page'];
    expect(allowed('create_page', binding)).toBe(true);
    expect(allowed('get_page', binding)).toBe(true);
    expect(allowed('put_page', binding)).toBe(false);
  });
});
