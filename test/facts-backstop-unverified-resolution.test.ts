/**
 * facts/backstop.ts — unverified-resolution context annotation.
 *
 * `resolveEntitySlugWithSource`'s `prefix_expansion` branch resolves a bare
 * single-token name ("Victor") to the ONLY existing `<dir>/<token>-*` page
 * purely because it's the sole candidate sharing that token — not because
 * anything confirms the mention refers to that same person or company.
 * Unlike `fallback_slugify` (an invented slug, blocked from spawning a
 * canonical stub page by the #4108 stub guard), prefix_expansion always
 * targets an already-existing, already-curated page, so a false match here
 * silently corrupts real content instead of an obviously-empty stub.
 *
 * Observed in the wild 2026-09-03: a Back-to-School-Night meeting
 * transcript's bare "Victor" (a classmate mentioned by first name only)
 * resolved onto an unrelated pre-existing `people/victor-*` page and wrote
 * a fact about him that wasn't his, with no signal anything was off.
 *
 * These tests pin that `runFactsBackstop` stamps the fact's context cell
 * with a visible caution note when (and only when) the entity resolved via
 * prefix_expansion — the fact is still written (dropping it would re-lose
 * real facts the way the daily-enrich.ts died-job bug did), but the
 * uncertainty is no longer indistinguishable from a confirmed fact.
 *
 * Real PGLite engine (in-memory, no DATABASE_URL). LLM is stubbed via
 * __setChatTransportForTests. No sources.local_path configured, so writes
 * take the legacy DB-only bucket — sufficient to exercise the annotation,
 * which is applied identically on both the legacy and fence-write paths.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import type { FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import {
  __setChatTransportForTests,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Sole `people/victor-*` page — the only candidate prefix_expansion has
  // to pick from for a bare "Victor" mention, whether or not it's the
  // right one.
  await engine.putPage('people/victor-example', {
    type: 'person',
    title: 'Victor Example',
    compiled_truth: '# Victor Example',
    frontmatter: {},
  }, { sourceId: 'default' });
});

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
});

const LONG_BODY = 'this is a real meeting note longer than 80 chars '.repeat(3);

function chatStub(facts: Array<{ fact: string; kind: string; notability?: string; entity?: string | null }>) {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({
      facts: facts.map(f => ({
        fact: f.fact,
        kind: f.kind,
        entity: f.entity ?? null,
        confidence: 1.0,
        notability: f.notability,
      })),
    }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub',
    providerId: 'test',
  }));
}

function makeCtx(overrides: Partial<FactsBackstopCtx> = {}): FactsBackstopCtx {
  return {
    engine,
    sourceId: 'default',
    sessionId: null,
    source: 'mcp:put_page',
    ...overrides,
  };
}

const meetingPage = (slug = 'meetings/test-' + Math.random().toString(36).slice(2, 9)) => ({
  slug,
  type: 'meeting' as const,
  compiled_truth: LONG_BODY,
  frontmatter: {} as Record<string, unknown>,
});

async function contextFor(id: number): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (engine as any).db.query('SELECT context FROM facts WHERE id = $1', [id]);
  return rows.rows[0]?.context ?? null;
}

describe('runFactsBackstop — unverified prefix_expansion resolution', () => {
  test('bare-name entity resolved via prefix_expansion gets a caution note in context', async () => {
    chatStub([
      { fact: 'Victor prefers design and tech over performing', kind: 'preference', notability: 'medium', entity: 'Victor' },
    ]);
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode !== 'inline') return;
    expect(r.inserted).toBe(1);

    const context = await contextFor(r.fact_ids[0]);
    expect(context).toContain('unverified');
    expect(context).toContain('prefix expansion');
  });

  test('exact-slug entity is NOT annotated', async () => {
    chatStub([
      { fact: 'Victor Example hosted an event', kind: 'event', notability: 'medium', entity: 'people/victor-example' },
    ]);
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode !== 'inline') return;
    expect(r.inserted).toBe(1);

    const context = await contextFor(r.fact_ids[0]);
    // No sourceSlug is set on this ctx, so an unflagged resolution's
    // context is null (unchanged pre-existing behavior) — assert against
    // '' rather than null so `.not.toContain` doesn't choke on null.
    expect(context ?? '').not.toContain('unverified');
  });

  test('multi-word fuzzy title match is NOT annotated (only bare-name prefix_expansion is)', async () => {
    chatStub([
      { fact: 'Victor Example hosted an event', kind: 'event', notability: 'medium', entity: 'Victor Example' },
    ]);
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode !== 'inline') return;
    expect(r.inserted).toBe(1);

    const context = await contextFor(r.fact_ids[0]);
    // No sourceSlug is set on this ctx, so an unflagged resolution's
    // context is null (unchanged pre-existing behavior) — assert against
    // '' rather than null so `.not.toContain` doesn't choke on null.
    expect(context ?? '').not.toContain('unverified');
  });
});
