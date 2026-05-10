/**
 * v0.30.3 codex-mandated test gate C4 — takes-fence redaction on read ops.
 *
 * #728 (garagon) added takes-fence stripping to `get_page` and `get_versions`
 * when the calling token carries an allow-list (i.e., it's an MCP-bound
 * token, not a trusted local CLI caller). Pre-#728 these handlers were raw
 * passthroughs — hidden takes leaked through reads while search-fence
 * blocked them. The worst privacy regression: silent leak with no alerting.
 *
 * Codex C4: Lane 4 (#757 + #728) is the high-risk merge surface for this
 * privacy invariant. Pin behavior at the seam where conflict resolution
 * lives so a future bad merge fails loudly.
 *
 * Three invariants:
 *   1. Local CLI caller (no allow-list) sees the full takes fence through
 *      get_page and get_versions.
 *   2. MCP-bound caller (allow-list set) sees `compiled_truth` with the
 *      fence stripped.
 *   3. The strip applies regardless of allow-list contents — even an
 *      allow-list of `['garry', 'brain', 'world']` (i.e., everything) still
 *      strips, because the allow-list's PRESENCE signals an MCP-bound
 *      caller. This is the key insight: the allow-list is identity, not
 *      filter scope, for read-op redaction.
 *
 * Serial test: shares engine state across cases, mutates module-level engine.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;

const PAGE_SLUG = 'people/alice-c4';

const PAGE_BODY_WITH_FENCE = `# Alice (C4 fixture)

Public-facing summary.

## Takes

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | CEO of Acme | fact | world | 1.0 | 2017-01 | Crustdata |
| 2 | Strong technical founder | take | garry | 0.85 | 2026-04 | OH |
| 3 | Seemed burned out | hunch | brain | 0.4 | 2026-04 | OH |
${TAKES_FENCE_END}

## Notes

Other content below the fence.
`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage(PAGE_SLUG, {
    title: 'Alice (C4 fixture)',
    type: 'person',
    compiled_truth: PAGE_BODY_WITH_FENCE,
  });
});

afterAll(async () => {
  await engine.disconnect();
});

function parseResult(result: { content: Array<{ text: string }>; isError?: boolean }): unknown {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

describe('C4: get_page takes-fence redaction (#728)', () => {
  test('local CLI caller (no allow-list) sees full fence', async () => {
    const result = await dispatchToolCall(engine, 'get_page', { slug: PAGE_SLUG }, {
      remote: false,
    });
    const page = parseResult(result) as { compiled_truth: string };
    expect(page.compiled_truth).toContain(TAKES_FENCE_BEGIN);
    expect(page.compiled_truth).toContain(TAKES_FENCE_END);
    expect(page.compiled_truth).toContain('Seemed burned out');
  });

  test('MCP caller with narrow allow-list (["world"]) sees fence STRIPPED', async () => {
    const result = await dispatchToolCall(engine, 'get_page', { slug: PAGE_SLUG }, {
      remote: true,
      takesHoldersAllowList: ['world'],
    });
    const page = parseResult(result) as { compiled_truth: string };
    expect(page.compiled_truth).not.toContain(TAKES_FENCE_BEGIN);
    expect(page.compiled_truth).not.toContain(TAKES_FENCE_END);
    expect(page.compiled_truth).not.toContain('Seemed burned out');
    // Public summary survives — only the fence is removed.
    expect(page.compiled_truth).toContain('Public-facing summary');
    expect(page.compiled_truth).toContain('Other content below the fence');
  });

  test('MCP caller with permissive allow-list (everything) STILL strips fence (presence = identity)', async () => {
    // Critical invariant: the ALLOW-LIST PRESENCE flags the caller as
    // MCP-bound. The contents of the allow-list don't loosen the redaction —
    // even ['world','garry','brain'] still strips, because takes_list /
    // takes_search are the typed surfaces for take inspection. get_page is
    // not an authorized take-reading channel.
    const result = await dispatchToolCall(engine, 'get_page', { slug: PAGE_SLUG }, {
      remote: true,
      takesHoldersAllowList: ['world', 'garry', 'brain'],
    });
    const page = parseResult(result) as { compiled_truth: string };
    expect(page.compiled_truth).not.toContain(TAKES_FENCE_BEGIN);
    expect(page.compiled_truth).not.toContain('Seemed burned out');
  });
});

describe('C4: get_versions takes-fence redaction (#728)', () => {
  // Seed page_versions directly via SQL so the test doesn't depend on the
  // putPage versioning policy. The contract under test is the redaction
  // pass at read-time, not the write-side version-creation policy.
  test('MCP caller (allow-list set) sees fence STRIPPED when versions exist', async () => {
    const db = (engine as any).db;
    const pageRow = await db.query(`SELECT id FROM pages WHERE slug = $1`, [PAGE_SLUG]);
    const pageId = pageRow.rows[0].id;
    await db.query(
      `INSERT INTO page_versions (page_id, compiled_truth, frontmatter)
       VALUES ($1, $2, '{}'::jsonb)`,
      [pageId, PAGE_BODY_WITH_FENCE],
    );

    const result = await dispatchToolCall(engine, 'get_versions', { slug: PAGE_SLUG }, {
      remote: true,
      takesHoldersAllowList: ['world'],
    });
    const versions = parseResult(result) as Array<{ compiled_truth: string }>;
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect(v.compiled_truth).not.toContain(TAKES_FENCE_BEGIN);
      expect(v.compiled_truth).not.toContain('Seemed burned out');
    }
  });

  test('local CLI caller (no allow-list) sees full fence on every version', async () => {
    const result = await dispatchToolCall(engine, 'get_versions', { slug: PAGE_SLUG }, {
      remote: false,
    });
    const versions = parseResult(result) as Array<{ compiled_truth: string }>;
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0].compiled_truth).toContain(TAKES_FENCE_BEGIN);
    expect(versions[0].compiled_truth).toContain('Seemed burned out');
  });
});
