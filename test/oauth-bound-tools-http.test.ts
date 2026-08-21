import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import {
  filterMcpOperationsByToolBinding,
  isMcpToolAllowedByBinding,
} from '../src/commands/serve-http.ts';

describe('OAuth bound_tools HTTP enforcement', () => {
  const mcpOperations = operations.filter(op => !op.localOnly);

  test('a binding exposes exactly its listed tools', () => {
    const visible = filterMcpOperationsByToolBinding(
      mcpOperations,
      ['create_page', 'get_page'],
    );

    expect(visible.map(op => op.name).sort()).toEqual(['create_page', 'get_page']);
    expect(visible.some(op => op.name === 'put_page')).toBe(false);
  });

  test('an empty binding denies every tool', () => {
    expect(filterMcpOperationsByToolBinding(mcpOperations, [])).toEqual([]);
    expect(isMcpToolAllowedByBinding('get_page', [])).toBe(false);
  });

  test('an absent binding preserves the existing MCP surface', () => {
    expect(filterMcpOperationsByToolBinding(mcpOperations, undefined)).toEqual(mcpOperations);
    expect(isMcpToolAllowedByBinding('put_page', undefined)).toBe(true);
  });

  test('call authorization is exact and independent from OAuth write scope', () => {
    const binding = ['create_page', 'get_page'];
    expect(isMcpToolAllowedByBinding('create_page', binding)).toBe(true);
    expect(isMcpToolAllowedByBinding('get_page', binding)).toBe(true);
    expect(isMcpToolAllowedByBinding('put_page', binding)).toBe(false);
  });
});