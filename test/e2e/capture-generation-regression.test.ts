/**
 * v0.40.3.0 — capture-generation regression (D3 + codex #5 strengthened)
 *
 * The v0.38 ingestion cathedral added a new write path to pages via the
 * `ingest_capture` Minion handler. The v0.40.3.0 cache-invalidation gate
 * relies on pages.generation being bumped by EVERY write path, via the
 * BEFORE INSERT OR UPDATE trigger on pages.
 *
 * This file pins that the new v0.38 capture write path correctly bumps
 * generation through TWO scenarios:
 *
 *   1. INSERT path (codex #4): ingest_capture with a fresh slug → page
 *      is created with generation = MAX(generation) + 1 so any cache
 *      row stored before the new page existed has its bookmark fire.
 *
 *   2. UPDATE path: ingest_capture with an existing slug + new content
 *      → trigger fires on content-column DISTINCT FROM and bumps
 *      generation. Cache rows referencing the page invalidate via
 *      Layer 2 (per-page snapshot).
 *
 * IRON-RULE: regression test mandated by the eng-review D3 + codex #5
 * strengthening pass.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { makeIngestCaptureHandler } from '../../src/core/minions/handlers/ingest-capture.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';
import type { IngestionEvent } from '../../src/core/ingestion/types.ts';
import { createHash } from 'node:crypto';

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function buildEvent(content: string, sourceUri: string): IngestionEvent {
  return {
    source_id: 'test-src',
    source_kind: 'capture-cli',
    source_uri: sourceUri,
    received_at: new Date().toISOString(),
    content_type: 'text/markdown',
    content,
    content_hash: sha256Hex(content),
  };
}

/**
 * Minimal MinionJobContext for the handler. The handler only reads
 * `job.data`; other fields can be undefined/no-op for this test.
 */
function buildJobCtx(data: Record<string, unknown>): MinionJobContext {
  return {
    data,
    job: { id: 1, name: 'ingest_capture', status: 'active' } as never,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => { /* no-op */ },
    onHeartbeat: undefined,
    readInbox: undefined,
  } as unknown as MinionJobContext;
}

describe('capture-generation regression (D3 + codex #5)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  async function readGeneration(slug: string): Promise<number | null> {
    const rows = await engine.executeRaw<{ generation: number | null }>(
      `SELECT generation FROM pages WHERE slug = $1`,
      [slug],
    );
    return rows[0]?.generation ?? null;
  }

  async function readMaxGeneration(): Promise<number> {
    const rows = await engine.executeRaw<{ v: number }>(
      `SELECT COALESCE(MAX(generation), 0)::bigint AS v FROM pages`,
    );
    return Number(rows[0]?.v ?? 0);
  }

  test('INSERT path (codex #4): new slug from ingest_capture bumps MAX(generation)', async () => {
    // Seed an unrelated page so MAX starts at a known >0 value.
    await engine.putPage('test/baseline', {
      type: 'note',
      title: 'baseline',
      compiled_truth: 'baseline body',
      timeline: '',
      frontmatter: {},
    });
    const baselineMax = await readMaxGeneration();
    expect(baselineMax).toBeGreaterThan(0);

    // Capture creates a NEW page via ingest_capture (INSERT path).
    const handler = makeIngestCaptureHandler(engine);
    const event = buildEvent('# A new captured note\n\nbody.', 'mcp://capture/test-1');
    const newSlug = 'test/capture-new';
    const ctx = buildJobCtx({ event, slug: newSlug, noEmbed: true });
    const result = await handler(ctx);
    expect(result.status).toBe('imported');

    // The new page exists with generation = MAX(previous) + 1.
    const newGen = await readGeneration(newSlug);
    expect(newGen).not.toBeNull();
    expect(newGen).toBeGreaterThan(baselineMax);

    // MAX(generation) strictly increased — bookmark gate would fire for
    // any cache row stored before this insert. This is the codex #4
    // INSERT coverage assertion.
    const newMax = await readMaxGeneration();
    expect(newMax).toBeGreaterThan(baselineMax);
  });

  test('UPDATE path: ingest_capture on existing slug + new content bumps generation', async () => {
    // Seed via ingest_capture (initial INSERT).
    const handler = makeIngestCaptureHandler(engine);
    const v1Event = buildEvent('# Captured v1\n\noriginal body.', 'mcp://capture/u1');
    const slug = 'test/capture-update';
    await handler(buildJobCtx({ event: v1Event, slug, noEmbed: true }));
    const v1Gen = await readGeneration(slug);
    expect(v1Gen).not.toBeNull();

    // Capture an UPDATE: same slug, NEW content (different hash → trigger fires).
    const v2Event = buildEvent('# Captured v2 — modified\n\nupdated body.', 'mcp://capture/u1');
    await handler(buildJobCtx({ event: v2Event, slug, noEmbed: true }));

    // generation must have incremented because compiled_truth IS DISTINCT FROM
    // OR content_hash IS DISTINCT FROM the previous value.
    const v2Gen = await readGeneration(slug);
    expect(v2Gen).not.toBeNull();
    expect(v2Gen!).toBeGreaterThan(v1Gen!);
  });

  test('idempotent UPDATE: capture with same content does NOT bump generation', async () => {
    // Same-content re-capture should be a no-op (trigger short-circuits
    // on IS DISTINCT FROM). This protects cache freshness on re-runs.
    const handler = makeIngestCaptureHandler(engine);
    const event = buildEvent('# Same content', 'mcp://capture/idem');
    const slug = 'test/capture-idem';

    await handler(buildJobCtx({ event, slug, noEmbed: true }));
    const firstGen = await readGeneration(slug);

    await handler(buildJobCtx({ event, slug, noEmbed: true }));
    const secondGen = await readGeneration(slug);

    // Trigger sees content_hash IS NOT DISTINCT FROM → no bump.
    expect(secondGen).toBe(firstGen);
  });
});
