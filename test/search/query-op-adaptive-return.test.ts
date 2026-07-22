/**
 * Pins the agent-facing surface for adaptive return-sizing on the `query` op.
 *
 * The feature is useless to an agent unless the MCP/op tool schema exposes the
 * param AND its description teaches WHEN to reach for it. This test guards both
 * so a future refactor can't silently drop the agent instruction.
 */

import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../../src/core/operations.ts';

describe('query op — adaptive_return agent surface', () => {
  const query = operationsByName['query'];

  test('query op exists', () => {
    expect(query).toBeDefined();
  });

  test('adaptive_return is a boolean param on query', () => {
    const param = query.params?.adaptive_return as { type?: string; description?: string } | undefined;
    expect(param).toBeDefined();
    expect(param?.type).toBe('boolean');
  });

  test('description teaches the agent WHEN to use it (single-answer vs breadth)', () => {
    const desc = (query.params?.adaptive_return as { description?: string })?.description ?? '';
    // Must instruct the agent on both directions of the decision.
    expect(desc.toLowerCase()).toContain('true when');
    expect(desc.toLowerCase()).toContain('breadth');
    // Must reassure the safety contract so the agent isn't afraid to use it.
    expect(desc.toLowerCase()).toContain('never returns empty');
  });
});
