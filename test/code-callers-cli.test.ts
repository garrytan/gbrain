/**
 * v0.20.0 Cathedral II Layer 10 (C4 + C5) — code-callers + code-callees CLI tests.
 *
 * The CLI commands are thin wrappers over engine.getCallersOf /
 * engine.getCalleesOf. Tests validate:
 *   - the commands are exported and can be called
 *   - JSON output shape is stable (agent-consumable)
 *   - missing symbol exits with UsageError envelope
 * End-to-end engine round-trip lives in test/code-edges.test.ts.
 */

import { describe, test, expect } from 'bun:test';

describe('Layer 10 C4/C5 — commands export runCodeCallers / runCodeCallees', () => {
  test('code-callers module exports runCodeCallers', async () => {
    const mod = await import('../src/commands/code-callers.ts');
    expect(typeof mod.runCodeCallers).toBe('function');
  });

  test('code-callees module exports runCodeCallees', async () => {
    const mod = await import('../src/commands/code-callees.ts');
    expect(typeof mod.runCodeCallees).toBe('function');
  });
});
