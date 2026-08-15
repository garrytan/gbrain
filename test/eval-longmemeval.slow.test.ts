/**
 * v0.28.1: LongMemEval benchmark harness tests.
 *
 * All tests run hermetically: in-memory PGLite, no DATABASE_URL, no API keys.
 *
 * v0.41.10 split: this file now holds the pure / harness-shared half of the
 * surface — describes that don't call `runEvalLongMemEval` and so don't pay
 * the per-call PGLite cold-create cost. End-to-end describes that DO call
 * `runEvalLongMemEval` (and create their own benchmark brain via
 * `withBenchmarkBrain`) live in test/eval-longmemeval-e2e.slow.test.ts.
 * Both files run as separate .slow.test.ts entries so CI's LPT bin-packer
 * (scripts/sharding.ts) can distribute them across different shards.
 *
 * Cold connect of a fresh PGLite is ~1-3s per pglite-engine.ts:106-108.
 * Tests share one engine across the harness/reset/speed cases via beforeAll,
 * so the connect cost amortizes across the file.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createBenchmarkBrain,
  resetTables,
} from '../src/eval/longmemeval/harness.ts';
import { haystackToPages, type LongMemEvalQuestion } from '../src/eval/longmemeval/adapter.ts';
import { loadResumeSet } from '../src/commands/eval-longmemeval.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { DEFAULT_SOURCE_BOOSTS } from '../src/core/search/source-boost.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';

// ---------------------------------------------------------------------------
// Shared engine for the harness/reset/speed cases
// ---------------------------------------------------------------------------

let sharedEngine: PGLiteEngine;

beforeAll(async () => {
  sharedEngine = await createBenchmarkBrain();
});

afterAll(async () => {
  if (sharedEngine) await sharedEngine.disconnect();
});

// ---------------------------------------------------------------------------
// 1. harness lifecycle
// ---------------------------------------------------------------------------

describe('harness lifecycle', () => {
  test('create -> reset -> import -> search -> assert hits', async () => {
    await resetTables(sharedEngine);
    for (let i = 0; i < 5; i++) {
      const slug = `chat/lifecycle-${i}`;
      const content =
        `---\ntype: note\nsession_id: lifecycle-${i}\n---\n\n` +
        `**user:** I bought a chocolate labrador puppy named Biscuit.\n\n` +
        `**assistant:** That's a great choice for a family dog.\n`;
      await importFromContent(sharedEngine, slug, content, { noEmbed: true });
    }
    const results = await sharedEngine.searchKeyword('chocolate labrador', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.slug.startsWith('chat/lifecycle-'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. reset clears all tables
// ---------------------------------------------------------------------------

describe('resetTables clears all tables', () => {
  test('after reset, search returns zero rows and pages count is zero', async () => {
    // Seed some pages first.
    for (let i = 0; i < 3; i++) {
      const slug = `chat/reset-${i}`;
      const content = `---\ntype: note\n---\n\n**user:** seed content reset-${i}\n`;
      await importFromContent(sharedEngine, slug, content, { noEmbed: true });
    }
    const beforeCount = await sharedEngine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM pages`,
    );
    expect(beforeCount[0].c).toBeGreaterThan(0);

    await resetTables(sharedEngine);

    const afterPages = await sharedEngine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM pages`,
    );
    expect(afterPages[0].c).toBe(0);

    const afterChunks = await sharedEngine.executeRaw<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM content_chunks`,
    );
    expect(afterChunks[0].c).toBe(0);

    const searchAfter = await sharedEngine.searchKeyword('seed', { limit: 5 });
    expect(searchAfter.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. schema-migration robustness (table count floor)
// ---------------------------------------------------------------------------

describe('resetTables: schema-migration robustness', () => {
  test('pg_tables enumeration returns at least the schema floor', async () => {
    const rows = await sharedEngine.executeRaw<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    // Floor is 10: pages, content_chunks, links, tags, raw_data, ingest_log,
    // page_versions, timeline_entries — plus several v0.28-shipped tables.
    // If pg_tables discovery breaks (column rename, schema-name change), the
    // count drops and the regression surfaces here.
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const names = rows.map(r => r.tablename);
    expect(names).toContain('pages');
    expect(names).toContain('content_chunks');
  });
});

// ---------------------------------------------------------------------------
// 4. speed (warm) — p50 + p99 across 10 trials
// ---------------------------------------------------------------------------

describe('warm-create speed gate', () => {
  // v0.40.10 flake-hardening: mode-aware ceiling. Solo run on Apple Silicon
  // shows p50 ~25ms; under 8-way shard CPU contention p50 reaches 600-1200ms;
  // GitHub Actions Ubuntu runners are slower yet (CI run #77585655194 hit
  // 17364ms total / ~1736ms/trial). Detect "loaded execution" via `$SHARD`
  // (set by scripts/run-unit-parallel.sh) OR `$CI` (set by every major CI).
  // Loaded ceiling 4000ms still catches >50x algorithmic regressions.
  const LOADED = !!process.env.SHARD || !!process.env.CI;
  const P50_CEILING_MS = LOADED ? 4000 : 1500;
  test(`p50 < ${P50_CEILING_MS}ms under parallel test load (catches order-of-magnitude regressions)`, async () => {
    const trials = 10;
    const samples: number[] = [];
    for (let i = 0; i < trials; i++) {
      const t0 = performance.now();
      await resetTables(sharedEngine);
      for (let j = 0; j < 5; j++) {
        const slug = `chat/speed-${i}-${j}`;
        const content = `---\ntype: note\n---\n\n**user:** speed sample ${i}-${j} keyword apple\n`;
        await importFromContent(sharedEngine, slug, content, { noEmbed: true });
      }
      await sharedEngine.searchKeyword('apple', { limit: 5 });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p99 = samples[Math.floor(samples.length * 0.99)];
    process.stderr.write(
      `[speed] warm reset+import+search p50=${p50.toFixed(1)}ms p99=${p99.toFixed(1)}ms (n=${trials}, ceiling=${P50_CEILING_MS}ms loaded=${LOADED})\n`,
    );
    expect(p50).toBeLessThan(P50_CEILING_MS);
    if (p99 > P50_CEILING_MS * 2) {
      process.stderr.write(`[speed] WARN: p99 above ${P50_CEILING_MS * 2}ms threshold (informational)\n`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. adapter shape
// ---------------------------------------------------------------------------

describe('adapter haystackToPages', () => {
  test('synthetic 3-session question converts to 3 pages with stable slugs + frontmatter', () => {
    const q: LongMemEvalQuestion = {
      question_id: 'q-shape-1',
      question_type: 'single-session-user',
      question: 'q?',
      answer: 'a',
      haystack_dates: ['2025-01-15', '2025-02-01', '2025-03-10'],
      answer_session_ids: ['sess-1'],
      haystack_sessions: [
        { session_id: 'sess-1', turns: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] },
        { session_id: 'sess-2', turns: [{ role: 'user', content: 'q2' }] },
        { session_id: 'sess-3', turns: [{ role: 'user', content: 'q3' }] },
      ],
    };
    const pages = haystackToPages(q);
    expect(pages.length).toBe(3);
    expect(pages[0].slug).toBe('chat/sess-1');
    expect(pages[1].slug).toBe('chat/sess-2');
    expect(pages[2].slug).toBe('chat/sess-3');
    expect(pages[0].content).toContain('type: note');
    expect(pages[0].content).toContain('date: 2025-01-15');
    expect(pages[0].content).toContain('session_id: sess-1');
    expect(pages[0].content).toContain('**user:** hi');
    expect(pages[0].content).toContain('**assistant:** hello');
  });

  test('haystack without dates produces pages with no date frontmatter line', () => {
    const q: LongMemEvalQuestion = {
      question_id: 'q-shape-2',
      question_type: 'multi-session',
      question: 'q?',
      answer: 'a',
      answer_session_ids: [],
      haystack_sessions: [
        { session_id: 'sess-x', turns: [{ role: 'user', content: 'no date here' }] },
      ],
    };
    const pages = haystackToPages(q);
    expect(pages[0].content).toContain('session_id: sess-x');
    expect(pages[0].content).not.toContain('date:');
  });

  // v0.35.1.1 regression: the public LongMemEval _s split uses arrays of
  // turn-arrays for haystack_sessions plus a parallel haystack_session_ids
  // string array. The pre-v0.35.1.1 adapter crashed with `session.turns is
  // undefined` on this shape. Pre-v0.35.1.1 the slug validator also
  // rejected the underscored, mixed-case session_ids the dataset uses.
  test('v0.35.1.1: _s split shape (turn-array + parallel ids) normalizes correctly', () => {
    const q: LongMemEvalQuestion = {
      question_id: 'q-s-1',
      question_type: 'single-session-user',
      question: 'q?',
      answer: 'a',
      haystack_dates: ['2025-01-01', '2025-01-02'],
      answer_session_ids: ['sharegpt_AbC_0'],
      haystack_session_ids: ['sharegpt_AbC_0', 'sess_DEF_1'],
      // No {session_id, turns} — turns directly per the _s shape.
      haystack_sessions: [
        [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
        [{ role: 'user', content: 'bye' }],
      ],
    };
    const pages = haystackToPages(q);
    expect(pages.length).toBe(2);
    // Slugs got lowercased + underscores became hyphens (validator-safe).
    expect(pages[0].slug).toBe('chat/sharegpt-abc-0');
    expect(pages[1].slug).toBe('chat/sess-def-1');
    // Frontmatter keeps the ORIGINAL session_id (no sanitization). The
    // _s ids preserve through the round-trip; only the slug got rewritten.
    expect(pages[0].content).toContain('session_id: sharegpt_AbC_0');
    expect(pages[0].content).toContain('date: 2025-01-01');
    expect(pages[0].content).toContain('**user:** hi');
    expect(pages[1].content).toContain('**user:** bye');
  });

  test('v0.35.1.1: missing haystack_session_ids on _s shape synthesizes ids per question', () => {
    const q: LongMemEvalQuestion = {
      question_id: 'q-s-2',
      question_type: 'single-session-user',
      question: 'q?',
      answer: 'a',
      answer_session_ids: [],
      // _s shape but the parallel ids array is absent. Adapter falls back
      // to a synthesized `lme_<question_id>_<i>` slug.
      haystack_sessions: [
        [{ role: 'user', content: 'turn 1' }],
      ],
    };
    const pages = haystackToPages(q);
    expect(pages.length).toBe(1);
    expect(pages[0].slug).toBe('chat/lme-q-s-2-0');
  });
});

// ---------------------------------------------------------------------------
// 6. source-boost regression guard
// ---------------------------------------------------------------------------

describe('source-boost regression guard', () => {
  test('chat/<session_id> slugs do not prefix-match any DEFAULT_SOURCE_BOOSTS entry (factor stays 1.0)', () => {
    const candidate = 'chat/lme-fixture-1';
    // Longest-prefix-match wins; ELSE branch is 1.0. We just need to assert
    // no key is a prefix of the candidate slug.
    const matched = Object.keys(DEFAULT_SOURCE_BOOSTS).filter(prefix =>
      candidate.startsWith(prefix),
    );
    expect(matched).toEqual([]);
    // Sanity: the existing openclaw/chat/ entry must not match either.
    expect(DEFAULT_SOURCE_BOOSTS['openclaw/chat/']).toBeDefined();
    expect(candidate.startsWith('openclaw/chat/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 13. v0.35.1.0: --resume-from helper (pure file I/O)
// ---------------------------------------------------------------------------

describe('loadResumeSet (v0.35.1.0)', () => {
  test('returns empty set when path does not exist', () => {
    const set = loadResumeSet('/nonexistent/path/never/exists.jsonl');
    expect(set.size).toBe(0);
  });

  test('reads question_ids from a well-formed JSONL', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-resume-'));
    const p = join(tmp, 'partial.jsonl');
    const { writeFileSync } = await import('fs');
    try {
      writeFileSync(
        p,
        [
          JSON.stringify({ question_id: 'a', hypothesis: 'one' }),
          JSON.stringify({ question_id: 'b', hypothesis: 'two' }),
        ].join('\n') + '\n',
        'utf8',
      );
      const set = loadResumeSet(p);
      expect(set.size).toBe(2);
      expect(set.has('a')).toBe(true);
      expect(set.has('b')).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips rows whose hypothesis is empty AND error is set (retry case)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-resume-'));
    const p = join(tmp, 'with-errors.jsonl');
    const { writeFileSync } = await import('fs');
    try {
      writeFileSync(
        p,
        [
          JSON.stringify({ question_id: 'good', hypothesis: 'real-answer' }),
          JSON.stringify({ question_id: 'bad', hypothesis: '', error: 'rate-limit' }),
          JSON.stringify({ question_id: 'recovered', hypothesis: 'second-try', error: 'old-error' }),
        ].join('\n') + '\n',
        'utf8',
      );
      const set = loadResumeSet(p);
      // 'bad' is retried; 'good' and 'recovered' are kept (hypothesis non-empty).
      expect(set.size).toBe(2);
      expect(set.has('good')).toBe(true);
      expect(set.has('bad')).toBe(false);
      expect(set.has('recovered')).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('tolerates a truncated/corrupt final line (SIGKILL recovery case)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-resume-'));
    const p = join(tmp, 'truncated.jsonl');
    const { writeFileSync } = await import('fs');
    try {
      writeFileSync(
        p,
        JSON.stringify({ question_id: 'a', hypothesis: 'one' }) + '\n' +
        '{"question_id":"b","hypothesis":"two-trunc' /* no closing brace, no LF */,
        'utf8',
      );
      const set = loadResumeSet(p);
      // First line counts; second is silently skipped (stderr warn).
      expect(set.size).toBe(1);
      expect(set.has('a')).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// buildByTypeSummary (pure function — no PGLite, no LLM)
// ---------------------------------------------------------------------------

describe('buildByTypeSummary (pure function)', () => {
  test('populated buckets produce sorted keys + rate math', async () => {
    const { buildByTypeSummary } = await import('../src/commands/eval-longmemeval.ts');
    const summary = buildByTypeSummary({
      'multi-session': { hit: 10, total: 10 },
      'single-session-user': { hit: 18, total: 19 },
    });
    expect(summary.kind).toBe('by_type_summary');
    expect(summary.schema_version).toBe(1);
    // Sorted alphabetically.
    expect(Object.keys(summary.recall_by_type)).toEqual(['multi-session', 'single-session-user']);
    expect(summary.recall_by_type['multi-session'].rate).toBeCloseTo(1.0, 5);
    expect(summary.recall_by_type['single-session-user'].rate).toBeCloseTo(18 / 19, 5);
    expect(summary.aggregate.hit).toBe(28);
    expect(summary.aggregate.total).toBe(29);
    expect(summary.aggregate.rate).toBeCloseTo(28 / 29, 5);
  });

  test('empty bucket map produces rate:null aggregate, not NaN', async () => {
    const { buildByTypeSummary } = await import('../src/commands/eval-longmemeval.ts');
    const summary = buildByTypeSummary({});
    expect(summary.recall_by_type).toEqual({});
    expect(summary.aggregate.hit).toBe(0);
    expect(summary.aggregate.total).toBe(0);
    expect(summary.aggregate.rate).toBeNull();
  });
});
