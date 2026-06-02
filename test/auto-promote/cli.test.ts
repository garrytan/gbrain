import { describe, it, expect } from 'bun:test';
import { parseAutoPromoteArgs } from '../../src/commands/auto-promote.ts';

describe('auto-promote CLI args', () => {
  it('defaults to dry-run unless --apply', () => {
    expect(parseAutoPromoteArgs([]).dry_run).toBe(true);
    expect(parseAutoPromoteArgs(['--apply']).dry_run).toBe(false);
    expect(parseAutoPromoteArgs(['--dry-run']).dry_run).toBe(true);
  });
  it('reads scope and limit', () => {
    const a = parseAutoPromoteArgs(['--scope-id', 'personal:me', '--limit', '50']);
    expect(a.scope_id).toBe('personal:me');
    expect(a.limit).toBe(50);
  });
});
