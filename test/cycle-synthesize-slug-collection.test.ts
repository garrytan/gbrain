/**
 * v0.30.3 codex-mandated test gate C6 — regression for #745.
 *
 * `collectChildPutPageSlugs` reads `input->>'slug'` from
 * `subagent_tool_executions`. Pre-#745 this failed silently when the
 * `input` column held a double-encoded JSONB string (jsonb_typeof='string'
 * containing '"{...}"' instead of jsonb_typeof='object'). The orchestrator
 * collected zero slugs, child jobs finished, queue looked healthy, and
 * the brain wrote nothing — the worst possible on-call shape.
 *
 * #745 added a COALESCE that handles both the proper jsonb-object shape and
 * the double-encoded jsonb-string shape:
 *
 *   COALESCE(input->>'slug', (input #>> '{}')::jsonb->>'slug') AS slug
 *
 * This test seeds both shapes in `subagent_tool_executions` and asserts the
 * function recovers slugs from both.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __testing } from '../src/core/cycle/synthesize.ts';

const { collectChildPutPageSlugs } = __testing;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed minion_jobs parent rows so subagent_tool_executions FK is satisfied.
  // The function only reads tool_executions; minion_jobs just needs to exist.
  const db = (engine as any).db;
  await db.exec(`
    INSERT INTO minion_jobs (id, queue, name, data, status)
    VALUES
      (1001, 'default', 'subagent', '{}'::jsonb, 'completed'),
      (1002, 'default', 'subagent', '{}'::jsonb, 'completed'),
      (1003, 'default', 'subagent', '{}'::jsonb, 'completed')
    ON CONFLICT (id) DO NOTHING;
  `);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('C6: collectChildPutPageSlugs survives double-encoded jsonb (#745)', () => {
  test('recovers slug from properly-stored jsonb object (post-fix)', async () => {
    const db = (engine as any).db;
    // Use raw SQL with jsonb literal to ensure object shape, not string shape.
    await db.query(
      `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, status, input)
       VALUES (1001, 0, 'tool_a', 'brain_put_page', 'complete', $1::jsonb)`,
      [JSON.stringify({ slug: 'wiki/agents/test/normal-shape', body: 'hi' })],
    );
    const refs = await collectChildPutPageSlugs(engine as any, [1001], new Map());
    expect(refs.map((r: { slug: string }) => r.slug)).toContain('wiki/agents/test/normal-shape');
  });

  test('recovers slug from DOUBLE-ENCODED jsonb string (#745 fix)', async () => {
    const db = (engine as any).db;
    // Construct double-encoded shape: input column contains a jsonb STRING
    // (jsonb_typeof='string') whose VALUE is the JSON-encoded object.
    // This is the bug-shape pre-#745: writing JSON.stringify of the object
    // into a jsonb column produced jsonb_typeof='string', not 'object'.
    const doubleEncoded = JSON.stringify(
      JSON.stringify({ slug: 'wiki/agents/test/double-encoded', body: 'hi' }),
    );
    await db.query(
      `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, status, input)
       VALUES (1002, 0, 'tool_b', 'brain_put_page', 'complete', $1::jsonb)`,
      [doubleEncoded],
    );

    // Sanity check: confirm the row IS double-encoded (jsonb_typeof='string').
    const probe = await db.query(
      `SELECT jsonb_typeof(input) AS t FROM subagent_tool_executions WHERE job_id=1002`,
    );
    expect(probe.rows[0].t).toBe('string');

    const refs = await collectChildPutPageSlugs(engine as any, [1002], new Map());
    expect(refs.map((r: { slug: string }) => r.slug)).toContain('wiki/agents/test/double-encoded');
  });

  test('handles MIXED inputs: returns slugs from both shapes in one query', async () => {
    const refs = await collectChildPutPageSlugs(engine as any, [1001, 1002], new Map());
    const slugs = refs.map((r: { slug: string }) => r.slug);
    expect(slugs).toContain('wiki/agents/test/normal-shape');
    expect(slugs).toContain('wiki/agents/test/double-encoded');
  });

  test('skips rows without a slug field gracefully (no throw)', async () => {
    const db = (engine as any).db;
    await db.query(
      `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, status, input)
       VALUES (1003, 0, 'tool_c', 'brain_put_page', 'complete', $1::jsonb)`,
      [JSON.stringify({ unrelated: 'no-slug' })],
    );
    const refs = await collectChildPutPageSlugs(engine as any, [1003], new Map());
    // Function silently drops rows whose slug resolves to null/empty.
    expect(refs.map((r: { slug: string }) => r.slug)).not.toContain('no-slug');
  });
});
