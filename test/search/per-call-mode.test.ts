/**
 * T4/D5 — per-call mode gate: local/trusted callers may select a mode; remote
 * callers can't (no tokenmax cost escalation); unknown modes reject loudly.
 */

import { describe, test, expect } from 'bun:test';
import { resolvePerCallMode, OperationError } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';

function ctx(remote: boolean | undefined): OperationContext {
  return { remote } as unknown as OperationContext;
}

describe('resolvePerCallMode', () => {
  test('local caller (remote===false) gets a valid mode', () => {
    expect(resolvePerCallMode(ctx(false), 'tokenmax')).toBe('tokenmax');
    expect(resolvePerCallMode(ctx(false), 'conservative')).toBe('conservative');
  });
  test('local caller + unknown mode → loud reject', () => {
    expect(() => resolvePerCallMode(ctx(false), 'thorough')).toThrow(OperationError);
    expect(() => resolvePerCallMode(ctx(false), 'NUKE')).toThrow(/Unknown search mode/);
  });
  test('remote caller (remote===true) → mode ignored (no escalation)', () => {
    expect(resolvePerCallMode(ctx(true), 'tokenmax')).toBeUndefined();
  });
  test('remote caller (remote===undefined, treated as remote) → ignored', () => {
    expect(resolvePerCallMode(ctx(undefined), 'tokenmax')).toBeUndefined();
  });
  test('no mode passed → undefined (use configured)', () => {
    expect(resolvePerCallMode(ctx(false), undefined)).toBeUndefined();
    expect(resolvePerCallMode(ctx(false), '')).toBeUndefined();
  });
});
