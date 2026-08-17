/**
 * CLI→MCP gap-closure wave — quarantine_list + cache_stats ops. Pins marker
 * detection, include_flagged, the truncation/lower-bound contract [OV13],
 * source scoping, and the cache-stats knob merge. Exercised via
 * dispatchToolCall against a real PGLite engine (the request-tools pattern).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { QUARANTINE_KEY, CONTENT_FLAG_KEY } from '../src/core/quarantine.ts';

let engine: PGLiteEngine;

const STDIO = { remote: true, transport: 'stdio' as const, sourceId: 'default' };

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Three pages: hidden (quarantine), flagged (content_flag), clean.
  await engine.putPage('junk/hidden-one', {
    type: 'note', title: 'Junk', compiled_truth: 'low value',
    frontmatter: { [QUARANTINE_KEY]: { reason: 'markup_ratio', assessed_at: '2026-08-01' } },
  });
  await engine.putPage('fuzzy/flagged-one', {
    type: 'note', title: 'Fuzzy', compiled_truth: 'maybe junk',
    frontmatter: { [CONTENT_FLAG_KEY]: { reason: 'oversize', assessed_at: '2026-08-02' } },
  });
  await engine.putPage('clean/page-one', { type: 'note', title: 'Clean', compiled_truth: 'fine' });
});

afterAll(async () => {
  await engine.disconnect();
});

describe('quarantine_list op', () => {
  test('lists quarantined pages only by default; flagged pages join with include_flagged', async () => {
    const res = await dispatchToolCall(engine, 'quarantine_list', {}, { ...STDIO });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.schema_version).toBe(1);
    const slugs = body.rows.map((r: { slug: string }) => r.slug);
    expect(slugs).toContain('junk/hidden-one');
    expect(slugs).not.toContain('fuzzy/flagged-one');
    expect(slugs).not.toContain('clean/page-one');
    expect(body.truncated).toBe(false);
    expect(body.scanned).toBeGreaterThanOrEqual(3);

    const withFlagged = parsed(await dispatchToolCall(engine, 'quarantine_list', { include_flagged: true }, { ...STDIO }));
    const flaggedSlugs = withFlagged.rows.map((r: { slug: string; marker: string }) => r.slug);
    expect(flaggedSlugs).toContain('fuzzy/flagged-one');
    const flaggedRow = withFlagged.rows.find((r: { slug: string }) => r.slug === 'fuzzy/flagged-one');
    expect(flaggedRow.marker).toBe('content_flag');
    expect(flaggedRow.reason).toBe('oversize');
  });

  test('OV13: bounded scan sets truncated and count is a lower bound', async () => {
    const body = parsed(await dispatchToolCall(engine, 'quarantine_list', { include_flagged: true, limit: 1 }, { ...STDIO }));
    expect(body.count).toBe(1);
    expect(body.truncated).toBe(true);

    const scanBound = parsed(await dispatchToolCall(engine, 'quarantine_list', { max_scan: 1 }, { ...STDIO }));
    expect(scanBound.scanned).toBeLessThanOrEqual(1);
    expect(scanBound.truncated).toBe(true);
  });

  test('source scoping: a foreign-source scope sees nothing', async () => {
    const body = parsed(await dispatchToolCall(engine, 'quarantine_list', { include_flagged: true }, {
      ...STDIO, sourceId: 'some-other-source',
    }));
    expect(body.count).toBe(0);
  });
});

describe('cache_stats op', () => {
  test('returns resolved knobs + counter shape', async () => {
    const res = await dispatchToolCall(engine, 'cache_stats', {}, { ...STDIO });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.schema_version).toBe(1);
    expect(typeof body.enabled).toBe('boolean');
    expect(body.similarity_threshold).toBeGreaterThan(0);
    expect(body.ttl_seconds).toBeGreaterThan(0);
    expect(typeof body.total_rows).toBe('number');
    expect(typeof body.total_hits).toBe('number');
    expect(typeof body.fresh_rows).toBe('number');
    expect(typeof body.stale_rows).toBe('number');
  });
});
