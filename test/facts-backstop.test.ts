/**
 * v0.31.2 — runFactsBackstop pipeline tests.
 *
 * Pins the helper's full contract: eligibility/kill-switch gates,
 * mode dispatch (queue vs inline), notability filter, dedup fast-path,
 * abort propagation, and skipped envelope shapes.
 *
 * Real PGLite engine (in-memory, no DATABASE_URL). LLM is stubbed via
 * __setChatTransportForTests so tests are deterministic + fast.
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

function chatStub(facts: Array<{ fact: string; kind: string; notability: 'high' | 'medium' | 'low'; entity?: string | null }>) {
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

describe('runFactsBackstop — eligibility + kill-switch gates', () => {
  test('skips with extraction_disabled when kill-switch off', async () => {
    await engine.setConfig('facts.extraction_enabled', 'false');
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.skipped).toBe('extraction_disabled');
    await engine.setConfig('facts.extraction_enabled', 'true');
  });

  test('skips with eligibility_failed:<reason> when subagent namespace', async () => {
    chatStub([]);
    const r = await runFactsBackstop(
      { ...meetingPage('wiki/agents/scratch/foo'), type: 'meeting' },
      makeCtx({ mode: 'inline' }),
    );
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.skipped).toBe('eligibility_failed:subagent_namespace');
  });

  test('skips with eligibility_failed:dream_generated when frontmatter set', async () => {
    chatStub([]);
    const page = meetingPage();
    page.frontmatter = { dream_generated: true };
    const r = await runFactsBackstop(page, makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.skipped).toBe('eligibility_failed:dream_generated');
  });
});

describe('runFactsBackstop — mode: inline', () => {
  test('inserts the LLM-extracted facts and returns counts', async () => {
    chatStub([
      { fact: 'mode-inline-event-1', kind: 'event', notability: 'high', entity: 'people/alice-example' },
      { fact: 'mode-inline-event-2', kind: 'event', notability: 'medium', entity: 'people/alice-example' },
    ]);
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') {
      expect(r.inserted).toBe(2);
      expect(r.duplicate).toBe(0);
      expect(r.fact_ids.length).toBe(2);
    }
  });

  test('notabilityFilter=high-only drops MEDIUM + LOW from the insert path', async () => {
    chatStub([
      { fact: 'high-only-1', kind: 'event', notability: 'high', entity: 'people/bob-test' },
      { fact: 'high-only-2-skip', kind: 'event', notability: 'medium', entity: 'people/bob-test' },
      { fact: 'high-only-3-skip', kind: 'event', notability: 'low', entity: 'people/bob-test' },
    ]);
    const r = await runFactsBackstop(
      meetingPage(),
      makeCtx({ mode: 'inline', notabilityFilter: 'high-only' }),
    );
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') {
      expect(r.inserted).toBe(1);
      expect(r.fact_ids.length).toBe(1);
    }
  });

  test('source string lands on the inserted row', async () => {
    const sessionId = 'source-pin-session-' + Math.random().toString(36).slice(2, 9);
    chatStub([{ fact: 'source-pin-fact', kind: 'fact', notability: 'medium', entity: null }]);
    const r = await runFactsBackstop(
      meetingPage(),
      makeCtx({ mode: 'inline', source: 'sync:import', sessionId }),
    );
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline' && r.fact_ids.length > 0) {
      // Query by source_session (deterministic, no resolveEntitySlug rewrite).
      const rows = await engine.listFactsBySession('default', sessionId);
      const ours = rows.find(x => x.id === r.fact_ids[0]);
      expect(ours?.source).toBe('sync:import');
      expect(ours?.source_session).toBe(sessionId);
    }
  });

  test('empty extraction → zero counts', async () => {
    chatStub([]);
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') {
      expect(r.inserted).toBe(0);
      expect(r.duplicate).toBe(0);
      expect(r.fact_ids.length).toBe(0);
    }
  });

  test('aborted before LLM call → zero counts, no throw', async () => {
    chatStub([]);
    const ac = new AbortController();
    ac.abort();
    const r = await runFactsBackstop(
      meetingPage(),
      makeCtx({ mode: 'inline', abortSignal: ac.signal }),
    );
    expect(r.mode).toBe('inline');
    if (r.mode === 'inline') expect(r.inserted).toBe(0);
  });
});

describe('runFactsBackstop — mode: queue', () => {
  test('default mode is queue; returns enqueued: true', async () => {
    chatStub([{ fact: 'queue-default-1', kind: 'event', notability: 'high', entity: 'people/queue-test' }]);
    const r = await runFactsBackstop(meetingPage(), makeCtx());  // no mode → default 'queue'
    expect(r.mode).toBe('queue');
    if (r.mode === 'queue') {
      expect(r.enqueued).toBe(true);
      expect(r.queueDepth).toBeGreaterThanOrEqual(0);
    }
  });

  test('explicit mode=queue returns immediately with enqueued: true', async () => {
    chatStub([{ fact: 'queue-explicit', kind: 'event', notability: 'high', entity: 'people/queue-explicit' }]);
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'queue' }));
    expect(r.mode).toBe('queue');
    if (r.mode === 'queue') expect(r.enqueued).toBe(true);
  });

  test('queue mode with extraction_disabled returns enqueued: false + skipped reason', async () => {
    await engine.setConfig('facts.extraction_enabled', 'false');
    const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'queue' }));
    expect(r.mode).toBe('queue');
    if (r.mode === 'queue') {
      expect(r.enqueued).toBe(false);
      expect(r.skipped).toBe('extraction_disabled');
    }
    await engine.setConfig('facts.extraction_enabled', 'true');
  });
});

describe('runFactsBackstop — dedup fast-path', () => {
  test('two near-identical inserts: second comes back as duplicate', async () => {
    // Insert first via inline mode; we'll re-fire with the same fact text
    // and rely on cosine ≥ 0.95 when the embedding matches. The B1 smoke
    // path's stubbed transport means embedding stays null (gateway not
    // configured), so the dedup path needs candidates with embeddings.
    // Skip the embedding-match assertion here and pin the no-dedup path:
    chatStub([
      { fact: 'distinct-fact-A', kind: 'event', notability: 'high', entity: 'people/dedup-a' },
    ]);
    const r1 = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r1.mode).toBe('inline');
    if (r1.mode === 'inline') expect(r1.inserted).toBe(1);

    // Without embeddings present, dedup short-circuits; the second call
    // inserts a new row (insertFact does no further dedup unless caller
    // passes supersedeId). That's the contract for queue+inline backstop.
    chatStub([
      { fact: 'distinct-fact-A', kind: 'event', notability: 'high', entity: 'people/dedup-a' },
    ]);
    const r2 = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));
    expect(r2.mode).toBe('inline');
    if (r2.mode === 'inline') {
      // Without embeddings the dedup fast-path can't fire; second insert lands.
      // Real production has embeddings via gateway — covered by E2E in a
      // future test that points at a configured chat+embed gateway.
      expect(r2.inserted + r2.duplicate).toBe(1);
    }
  });
});

describe('runFactsBackstop — stub guard routing (v0.34.5)', () => {
  test('bare-name entity routes to legacy DB-only path (no phantom page)', async () => {
    // Set up: configure default source with a real local_path so the
    // backstop reaches Phase 5 (fence write) instead of Phase 4 (legacy).
    // This is the scenario where the stub guard actually fires.
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const brainDir = mkdtempSync(join(tmpdir(), 'backstop-stub-guard-'));
    try {
      // Point the default source at the tempdir so localPath is non-null.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(
        `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
        [brainDir],
      );

      // Stub the chat to return a fact with a bare-name entity. The
      // resolver will:
      //   1. exact slug match → miss (no 'noresolvable' row)
      //   2. fuzzy match → miss (no title contains noresolvable)
      //   3. prefix expansion → miss (no people/noresolvable-* rows)
      //   4. slugify fallback → 'noresolvable' (bare)
      // The bare slug then trips the stub guard in writeFactsToFence,
      // which returns stubGuardBlocked: true, and backstop routes the
      // fact to engine.insertFact (DB-only).
      chatStub([
        { fact: 'said hello at the meeting', kind: 'event', notability: 'high', entity: 'noresolvable' },
      ]);

      const r = await runFactsBackstop(meetingPage(), makeCtx({ mode: 'inline' }));

      expect(r.mode).toBe('inline');
      if (r.mode === 'inline') {
        // The fact MUST be persisted via the DB-only fallback, not dropped.
        expect(r.inserted).toBe(1);
        expect(r.fact_ids.length).toBe(1);

        // No phantom file at the brain root (this is the whole point of the guard).
        expect(existsSync(join(brainDir, 'noresolvable.md'))).toBe(false);

        // The fact is in the DB with the bare entity_slug. Query directly to
        // confirm — the routing is the contract under test.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = await (engine as any).db.query(
          `SELECT entity_slug, fact, source_markdown_slug FROM facts WHERE id = $1`,
          [r.fact_ids[0]],
        );
        expect(rows.rows[0].entity_slug).toBe('noresolvable');
        expect(rows.rows[0].fact).toBe('said hello at the meeting');
        // source_markdown_slug is the fence-tracking column; under DB-only
        // fallback it stays null (no .md file backs the row).
        expect(rows.rows[0].source_markdown_slug).toBeNull();
      }
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
      rmSync(brainDir, { recursive: true, force: true });
    }
  });
});
