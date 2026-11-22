import { describe, expect, test } from 'bun:test';
import { makeShareable } from '../src/commands/publish.ts';

describe('makeShareable timeline stripping', () => {
  test('strips Timeline without a preceding --- rule', () => {
    const out = makeShareable('# Test\n\nBody.\n\n## Timeline\n\n- **2026-01-01** | private log entry\n');
    expect(out).not.toContain('private log entry');
    expect(out).not.toContain('## Timeline');
    expect(out).toContain('Body.');
  });

  test('strips Timeline after extra blank lines', () => {
    const out = makeShareable('# Test\n\nBody.\n\n\n\n## Timeline\n\n- entry secret\n');
    expect(out).not.toContain('secret');
  });

  test('still strips Timeline after --- rule', () => {
    const out = makeShareable('# Test\n\nBody.\n\n---\n\n## Timeline\n\n- entry secret\n');
    expect(out).toBe('# Test\n\nBody.');
  });
});
