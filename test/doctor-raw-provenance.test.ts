/**
 * #1978 — raw-source persistence guarantee (warn-only v1).
 *
 * `rawProvenanceCheck` flags synthesized/derived pages (dream_generated:true
 * frontmatter or type:synthesis) that carry NO raw trace (raw_trace /
 * raw_source / source_uri frontmatter, attached raw_data row, or
 * synthesis_evidence rows) and NO explicit raw_trace_exempt marker.
 *
 * Runs against real PGLite so the SQL shape (`?|` key-existence operator +
 * NOT EXISTS subqueries) is pinned on an actual engine, not a mock.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { rawProvenanceCheck } from '../src/commands/doctor.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('rawProvenanceCheck (#1978, warn-only v1)', () => {
  test('empty brain → ok', async () => {
    const result = await rawProvenanceCheck(engine as unknown as BrainEngine);
    expect(result.name).toBe('raw_provenance');
    expect(result.status).toBe('ok');
  });

  test('flags only the synthesized page without a trace; every trace/exemption shape passes', async () => {
    // 1. VIOLATION: dream-generated, no trace, no exemption.
    await engine.putPage('wiki/derived/no-trace', {
      type: 'note', title: 'No trace', compiled_truth: 'body', timeline: '',
      frontmatter: { dream_generated: true },
    });
    // 2. OK: dream-generated with raw_source frontmatter.
    await engine.putPage('wiki/derived/with-raw-source', {
      type: 'note', title: 'Has raw_source', compiled_truth: 'body', timeline: '',
      frontmatter: { dream_generated: true, raw_source: '/transcripts/2026-07-01.md' },
    });
    // 3. OK: type:synthesis with explicit exemption.
    await engine.putPage('synthesis/exempt-page', {
      type: 'synthesis', title: 'Exempt', compiled_truth: 'body', timeline: '',
      frontmatter: { raw_trace_exempt: true, raw_trace_exempt_reason: 'test' },
    });
    // 4. OK: hand-authored note — not synthesized, never flagged.
    await engine.putPage('wiki/hand-authored', {
      type: 'note', title: 'Hand authored', compiled_truth: 'body', timeline: '',
      frontmatter: {},
    });
    // 5. OK: dream-generated with an attached raw_data row.
    const withRaw = await engine.putPage('wiki/derived/with-raw-data', {
      type: 'note', title: 'Has raw_data', compiled_truth: 'body', timeline: '',
      frontmatter: { dream_generated: true },
    });
    await engine.executeRaw(
      `INSERT INTO raw_data (page_id, source, data) VALUES ($1, 'test', '{}'::jsonb)`,
      [withRaw.id],
    );

    const result = await rawProvenanceCheck(engine as unknown as BrainEngine);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('1 synthesized page(s)');
    expect(result.message).toContain('wiki/derived/no-trace');
    expect(result.message).not.toContain('with-raw-source');
    expect(result.message).not.toContain('exempt-page');
    expect(result.message).not.toContain('hand-authored');
    expect(result.message).not.toContain('with-raw-data');
  });

  test('stamping an exemption on the violator clears the warning', async () => {
    await engine.executeRaw(
      `UPDATE pages SET frontmatter = frontmatter || '{"raw_trace_exempt": true, "raw_trace_exempt_reason": "reviewed"}'::jsonb
        WHERE slug = 'wiki/derived/no-trace'`,
    );
    const result = await rawProvenanceCheck(engine as unknown as BrainEngine);
    expect(result.status).toBe('ok');
  });

  test('soft-deleted violators are not flagged', async () => {
    await engine.putPage('wiki/derived/deleted-no-trace', {
      type: 'note', title: 'Deleted violator', compiled_truth: 'body', timeline: '',
      frontmatter: { dream_generated: true },
    });
    expect((await rawProvenanceCheck(engine as unknown as BrainEngine)).status).toBe('warn');
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() WHERE slug = 'wiki/derived/deleted-no-trace'`,
    );
    expect((await rawProvenanceCheck(engine as unknown as BrainEngine)).status).toBe('ok');
  });

  test('query failure degrades to warn, never throws', async () => {
    const broken = { executeRaw: async () => { throw new Error('boom'); } } as unknown as BrainEngine;
    const result = await rawProvenanceCheck(broken);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('Could not check');
  });

  test('raw_provenance is categorized as a brain check', () => {
    expect(categorizeCheck('raw_provenance')).toBe('brain');
  });
});
