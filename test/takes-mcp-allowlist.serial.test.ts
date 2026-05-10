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
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

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

// ---------------------------------------------------------------------------
// Page-body channel: get_page / get_versions must respect the same allow-list.
// Take rows are stored in TWO places per the extract-takes contract: the
// `takes` table (filtered by the SQL `holder = ANY($allowList)` clause) and
// inline in `pages.compiled_truth` between TAKES_FENCE markers as a markdown
// table. Without a strip on the page-CRUD path, a `world`-only token reading
// `get_page <slug>` recovers every non-`world` claim verbatim from the body.
// ---------------------------------------------------------------------------

describe('per-token takes-holder allow-list — get_page body channel', () => {
  const SLUG = 'people/bob-example';
  const FENCE_BODY =
    '## Takes\n\n' +
    `${TAKES_FENCE_BEGIN}\n` +
    '\n| # | claim | kind | who | weight | since | source |\n' +
    '|---|---|---|---|---|---|---|\n' +
    '| 1 | CEO of Widget | fact | world | 1.0 | 2017-01 | Crustdata |\n' +
    '| 2 | Strong technical founder | take | garry | 0.85 | 2026-04-29 | OH |\n' +
    '| 3 | Seemed burned out in last OH | hunch | brain | 0.4 | 2026-05-01 | private |\n\n' +
    `${TAKES_FENCE_END}\n` +
    '\nFooter content stays.\n';

  beforeAll(async () => {
    await engine.putPage(SLUG, { title: 'Bob', type: 'person', compiled_truth: FENCE_BODY });
  });

  test('remote token with allow-list strips fence from compiled_truth', async () => {
    const result = await dispatchToolCall(engine, 'get_page', { slug: SLUG }, {
      remote: true,
      takesHoldersAllowList: ['world'],
    });
    const page = parseResult(result) as { compiled_truth: string };
    expect(page.compiled_truth).not.toContain(TAKES_FENCE_BEGIN);
    expect(page.compiled_truth).not.toContain(TAKES_FENCE_END);
    expect(page.compiled_truth).not.toContain('Strong technical founder');
    expect(page.compiled_truth).not.toContain('Seemed burned out');
    expect(page.compiled_truth).not.toContain('| garry |');
    expect(page.compiled_truth).not.toContain('| brain |');
    // Surrounding body kept intact.
    expect(page.compiled_truth).toContain('Footer content stays.');
  });

  test('local CLI (no allow-list) preserves the fence — backwards compatibility', async () => {
    const result = await dispatchToolCall(engine, 'get_page', { slug: SLUG }, {
      remote: false,
    });
    const page = parseResult(result) as { compiled_truth: string };
    expect(page.compiled_truth).toContain(TAKES_FENCE_BEGIN);
    expect(page.compiled_truth).toContain('Seemed burned out');
  });

  test('fuzzy resolution path also strips for remote token', async () => {
    const result = await dispatchToolCall(engine, 'get_page', { slug: 'people/bob-example', fuzzy: true }, {
      remote: true,
      takesHoldersAllowList: ['world', 'garry'],
    });
    const page = parseResult(result) as { compiled_truth: string };
    // Allow-list does not yet re-render filtered rows; whole fence is stripped.
    // Pinned so future re-rendering work is an additive change, not a silent
    // semantic flip.
    expect(page.compiled_truth).not.toContain(TAKES_FENCE_BEGIN);
    expect(page.compiled_truth).not.toContain('Strong technical founder');
  });
});

describe('per-token takes-holder allow-list — get_versions body channel', () => {
  const SLUG = 'people/carol-example';
  const FENCE_BODY =
    `${TAKES_FENCE_BEGIN}\n| # | claim | kind | who |\n|---|---|---|---|\n| 1 | private hunch | hunch | brain |\n${TAKES_FENCE_END}\n`;

  beforeAll(async () => {
    await engine.putPage(SLUG, { title: 'Carol', type: 'person', compiled_truth: FENCE_BODY });
    await engine.createVersion(SLUG); // snapshot now has the fence
  });

  test('remote token with allow-list strips fence from every snapshot', async () => {
    const result = await dispatchToolCall(engine, 'get_versions', { slug: SLUG }, {
      remote: true,
      takesHoldersAllowList: ['world'],
    });
    const versions = parseResult(result) as Array<{ compiled_truth: string }>;
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect(v.compiled_truth).not.toContain(TAKES_FENCE_BEGIN);
      expect(v.compiled_truth).not.toContain('private hunch');
    }
  });

  test('local CLI sees historical takes in snapshots', async () => {
    const result = await dispatchToolCall(engine, 'get_versions', { slug: SLUG }, {
      remote: false,
    });
    const versions = parseResult(result) as Array<{ compiled_truth: string }>;
    expect(versions.some(v => v.compiled_truth.includes('private hunch'))).toBe(true);
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
