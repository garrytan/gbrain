/**
 * v0.28: integration test that proves the per-token takes-holder allow-list
 * filters server-side through the dispatch layer (Codex P0 #3 fix
 * verification). PGLite-only; no DATABASE_URL required.
 *
 * Threads:
 *   1. Auth wires `permissions.takes_holders` from `access_tokens` → AuthResult
 *   2. HTTP transport passes `auth.takesHoldersAllowList` to dispatchToolCall
 *   3. dispatch.ts threads it into OperationContext.takesHoldersAllowList
 *   4. takes_list / takes_search ops pass it to engine.listTakes / .searchTakes
 *   5. engine SQL applies `AND holder = ANY($allowList)`
 *
 * This test exercises step 3-5 directly through dispatchToolCall.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;
let alicePageId: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const alice = await engine.putPage('people/alice-example', {
    title: 'Alice', type: 'person', compiled_truth: '## Takes\n',
  });
  alicePageId = alice.id;
  // Seed three takes by three holders. Public fact, garry's bet, brain's hunch.
  await engine.addTakesBatch([
    { page_id: alicePageId, row_num: 1, claim: 'CEO of Acme', kind: 'fact', holder: 'world', weight: 1.0 },
    { page_id: alicePageId, row_num: 2, claim: 'Strong technical founder', kind: 'take', holder: 'garry', weight: 0.85 },
    { page_id: alicePageId, row_num: 3, claim: 'Seemed burned out in last OH', kind: 'hunch', holder: 'brain', weight: 0.4 },
  ]);
});

afterAll(async () => {
  await engine.disconnect();
});

function parseResult(result: { content: Array<{ text: string }>; isError?: boolean }): unknown {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

describe('per-token takes-holder allow-list — takes_list', () => {
  test('default (no allow-list, local CLI) returns all holders', async () => {
    const result = await dispatchToolCall(engine, 'takes_list', { page_slug: 'people/alice-example' }, {
      remote: false, // Local CLI: no allow-list applied.
    });
    const takes = parseResult(result) as Array<{ holder: string; claim: string }>;
    const holders = takes.map(t => t.holder).sort();
    expect(holders).toEqual(['brain', 'garry', 'world']);
  });

  test('allow-list ["world"] (default-deny token) returns ONLY world holders', async () => {
    const result = await dispatchToolCall(engine, 'takes_list', { page_slug: 'people/alice-example' }, {
      remote: true,
      takesHoldersAllowList: ['world'],
    });
    const takes = parseResult(result) as Array<{ holder: string; claim: string }>;
    expect(takes).toHaveLength(1);
    expect(takes[0].holder).toBe('world');
    expect(takes[0].claim).toBe('CEO of Acme');
  });

  test('allow-list ["world", "garry"] returns world + garry, hides brain hunches', async () => {
    const result = await dispatchToolCall(engine, 'takes_list', { page_slug: 'people/alice-example' }, {
      remote: true,
      takesHoldersAllowList: ['world', 'garry'],
    });
    const takes = parseResult(result) as Array<{ holder: string }>;
    const holders = takes.map(t => t.holder).sort();
    expect(holders).toEqual(['garry', 'world']);
  });

  test('allow-list with no overlap returns empty (no fallback to default)', async () => {
    const result = await dispatchToolCall(engine, 'takes_list', { page_slug: 'people/alice-example' }, {
      remote: true,
      takesHoldersAllowList: ['nonexistent-holder'],
    });
    const takes = parseResult(result) as unknown[];
    expect(takes).toHaveLength(0);
  });
});

describe('per-token takes-holder allow-list — takes_search', () => {
  test('allow-list ["world"] filters search hits to public claims only', async () => {
    const result = await dispatchToolCall(engine, 'takes_search', { query: 'founder' }, {
      remote: true,
      takesHoldersAllowList: ['world'],
    });
    const hits = parseResult(result) as Array<{ holder: string; claim: string }>;
    expect(hits.every(h => h.holder === 'world')).toBe(true);
  });

  test('no allow-list (local) sees all holders in search', async () => {
    const result = await dispatchToolCall(engine, 'takes_search', { query: 'founder' }, {
      remote: false,
    });
    const hits = parseResult(result) as Array<{ holder: string }>;
    // 'Strong technical founder' (garry) should match
    expect(hits.some(h => h.holder === 'garry')).toBe(true);
  });
});

describe('think op — read-only on remote callers (Lane D landed)', () => {
  test('remote save/take is forced read-only via remote_persisted_blocked flag', async () => {
    // Without ANTHROPIC_API_KEY, runThink returns gather-only result with NO_ANTHROPIC_API_KEY warning.
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await dispatchToolCall(engine, 'think', { question: 'q', save: true, take: true }, {
        remote: true,
        takesHoldersAllowList: ['world', 'garry', 'brain'],
      });
      const env = parseResult(result) as {
        remote_persisted_blocked: boolean;
        saved_slug: string | null;
        warnings: string[];
      };
      // Codex P1 #7: remote save/take is silently disabled.
      expect(env.remote_persisted_blocked).toBe(true);
      expect(env.saved_slug).toBeNull();
      // Without API key, gather succeeds but synthesis is skipped.
      expect(env.warnings).toContain('NO_ANTHROPIC_API_KEY');
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  test('local-CLI think runs full pipeline (gather-only without API key)', async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await dispatchToolCall(engine, 'think', { question: 'q', save: true }, {
        remote: false,
      });
      const env = parseResult(result) as {
        warnings: string[];
        remote_persisted_blocked: boolean;
      };
      expect(env.remote_persisted_blocked).toBe(false);
      // Without API key, returns gather-only + warning. With key, would actually synthesize.
      expect(env.warnings).toContain('NO_ANTHROPIC_API_KEY');
    } finally {
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });
});
