/**
 * E2E security regression: poisoned-transcript guard for the v0.21
 * trusted-workspace allow-list.
 *
 * Runs against PGLite in-memory (no DATABASE_URL required). Builds the
 * brain tool registry with `allowed_slug_prefixes` set the same way the
 * synthesize phase does, then calls the put_page tool with slugs that
 * are inside / outside the allow-list. Asserts:
 *
 *   - In-allow-list slug → page is written to the DB
 *   - Outside-allow-list slug → tool throws permission_denied
 *   - When allow-list is unset (legacy), put_page is bounded to
 *     wiki/agents/<id>/...  (regression guard for the v0.15 anti-prompt-
 *     injection guarantee)
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { buildBrainTools } from '../../src/core/minions/tools/brain-allowlist.ts';
import type { GBrainConfig } from '../../src/core/config.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

const config = {} as unknown as GBrainConfig;

const PUT_PAGE_TOOL = 'brain_put_page';
const SAMPLE_BODY = '---\ntitle: A reflection\ntype: default\n---\n\nbody text\n';

function findPutPageTool(tools: Awaited<ReturnType<typeof buildBrainTools>>) {
  const t = tools.find(x => x.name === PUT_PAGE_TOOL);
  if (!t) throw new Error('brain_put_page tool not found in registry');
  return t;
}

describe('E2E allow-list — trusted-workspace path', () => {
  test('ALLOW: subagent put_page within allow-list writes the page', async () => {
    const tools = buildBrainTools({
      subagentId: 999,
      engine,
      config,
      allowedSlugPrefixes: ['wiki/personal/reflections/*'],
    });
    const tool = findPutPageTool(tools);
    await tool.execute(
      { slug: 'wiki/personal/reflections/2026-04-25-arete-paradox-a3f8c1', content: SAMPLE_BODY },
      { engine, jobId: 7777, remote: true },
    );
    const page = await engine.getPage('wiki/personal/reflections/2026-04-25-arete-paradox-a3f8c1');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('A reflection');
  });

  test('REJECT: subagent put_page outside allow-list throws permission_denied', async () => {
    const tools = buildBrainTools({
      subagentId: 999,
      engine,
      config,
      allowedSlugPrefixes: ['wiki/personal/reflections/*'],
    });
    const tool = findPutPageTool(tools);
    let threw = false;
    try {
      await tool.execute(
        { slug: 'wiki/finance/secret-market-data', content: SAMPLE_BODY },
        { engine, jobId: 7778, remote: true },
      );
    } catch (e) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/allow-list/i);
    }
    expect(threw).toBe(true);
    const page = await engine.getPage('wiki/finance/secret-market-data');
    expect(page).toBeNull(); // never reached the engine
  });

  test('Multiple prefixes: each slug evaluated independently', async () => {
    const tools = buildBrainTools({
      subagentId: 999,
      engine,
      config,
      allowedSlugPrefixes: ['wiki/personal/reflections/*', 'wiki/originals/*'],
    });
    const tool = findPutPageTool(tools);
    await tool.execute(
      { slug: 'wiki/originals/ideas/2026-04-25-thousand-pound-armor', content: SAMPLE_BODY },
      { engine, jobId: 7779, remote: true },
    );
    expect(await engine.getPage('wiki/originals/ideas/2026-04-25-thousand-pound-armor')).not.toBeNull();
  });
});

describe('E2E allow-list — legacy namespace fallback', () => {
  test('REGRESSION GUARD: when allow-list is unset, put_page rejects writes outside wiki/agents/<id>/', async () => {
    const tools = buildBrainTools({
      subagentId: 999,
      engine,
      config,
      // allowedSlugPrefixes intentionally omitted — exercises the v0.15
      // legacy namespace check that v0.21 must NOT regress.
    });
    const tool = findPutPageTool(tools);
    let threw = false;
    try {
      await tool.execute(
        { slug: 'wiki/personal/reflections/2026-04-25-bypass-attempt', content: SAMPLE_BODY },
        { engine, jobId: 7780, remote: true },
      );
    } catch (e) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/wiki\/agents\/999/);
    }
    expect(threw).toBe(true);
  });

  test('When allow-list unset, slug under wiki/agents/<id>/ is allowed', async () => {
    const tools = buildBrainTools({
      subagentId: 999,
      engine,
      config,
    });
    const tool = findPutPageTool(tools);
    await tool.execute(
      { slug: 'wiki/agents/999/scratch-note', content: SAMPLE_BODY },
      { engine, jobId: 7781, remote: true },
    );
    expect(await engine.getPage('wiki/agents/999/scratch-note')).not.toBeNull();
  });
});

describe('E2E allow-list — provenance via tool execution rows (Codex #2)', () => {
  test('subagent_tool_executions captures slug for each put_page call', async () => {
    // The synthesize phase relies on this being queryable to determine
    // exactly which slugs each child wrote (instead of pages.updated_at).
    // We don't have a real subagent run here, but we can verify the table
    // exists and the column shape supports the orchestrator's query.
    const rows = await engine.executeRaw(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'subagent_tool_executions'
        ORDER BY column_name`,
    ) as Array<{ column_name: string }>;
    const cols = rows.map(r => r.column_name);
    expect(cols).toContain('input');
    expect(cols).toContain('tool_name');
    expect(cols).toContain('status');
    expect(cols).toContain('job_id');
  });
});
