/**
 * v0.28.1: LongMemEval benchmark harness tests.
 *
 * All tests run hermetically: in-memory PGLite, no DATABASE_URL, no API keys.
 * The end-to-end tests stub the Anthropic client via the `runEvalLongMemEval`
 * `client` opt so the LLM-answer path is exercised without a real API call.
 *
 * Cold connect of a fresh PGLite is ~1-3s per pglite-engine.ts:106-108.
 * Tests share one engine across the harness/reset/speed cases via beforeAll,
 * so the connect cost amortizes across the file.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type Anthropic from '@anthropic-ai/sdk';
import {
  createBenchmarkBrain,
  resetTables,
  withBenchmarkBrain,
} from '../src/eval/longmemeval/harness.ts';
import { haystackToPages, type LongMemEvalQuestion } from '../src/eval/longmemeval/adapter.ts';
import { runEvalLongMemEval, loadResumeSet } from '../src/commands/eval-longmemeval.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { DEFAULT_SOURCE_BOOSTS } from '../src/core/search/source-boost.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ThinkLLMClient } from '../src/core/think/index.ts';

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

const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');

// ---------------------------------------------------------------------------
// Stub MessagesClient. Returns a canned answer and records the prompt the
// caller built so tests can assert on prompt-construction.
// ---------------------------------------------------------------------------

interface StubCall {
  model: string;
  system: string;
  userText: string;
}

function makeStubClient(cannedText: string): { client: ThinkLLMClient; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const client: ThinkLLMClient = {
    async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
      const sys = typeof params.system === 'string'
        ? params.system
        : Array.isArray(params.system)
          ? params.system.map(b => (typeof b === 'string' ? b : (b as any).text ?? '')).join('\n')
          : '';
      const userMsg = params.messages[0];
      const userContent = typeof userMsg.content === 'string'
        ? userMsg.content
        : userMsg.content.map(b => (b.type === 'text' ? b.text : '')).join('\n');
      calls.push({ model: params.model, system: sys, userText: userContent });
      return {
        id: 'stub-msg-id',
        type: 'message',
        role: 'assistant',
        model: params.model,
        content: [{ type: 'text', text: cannedText, citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: null,
        },
        container: null,
      } as unknown as Anthropic.Message;
    },
  };
  return { client, calls };
}

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
  test('p50 < 1500ms under parallel test load (catches order-of-magnitude regressions)', async () => {
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
      `[speed] warm reset+import+search p50=${p50.toFixed(1)}ms p99=${p99.toFixed(1)}ms (n=${trials})\n`,
    );
    // Threshold bumped from 500ms → 1500ms because the original was tight enough
    // to flake under parallel test load (8-way shard process + PGLite WASM
    // contention). Solo run shows p50 ~25ms; under parallel load p50 can reach
    // 600-1200ms transiently. 1500ms still catches order-of-magnitude
    // regressions (a 10x slowdown to 250ms baseline would fail at 2.5s).
    expect(p50).toBeLessThan(1500);
    if (p99 > 3000) {
      process.stderr.write(`[speed] WARN: p99 above 3000ms threshold (informational)\n`);
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
// 8. end-to-end with stubbed LLM
// ---------------------------------------------------------------------------

describe('runEvalLongMemEval: end-to-end with stubbed LLM', () => {
  test('5-question fixture produces 5 valid JSONL lines via --output', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      const { client, calls } = makeStubClient('canned-answer-stub');
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '5', '--output', outPath, '--top-k', '3'],
        { client },
      );
      expect(existsSync(outPath)).toBe(true);
      const raw = readFileSync(outPath, 'utf8');
      const lines = raw.split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(5);
      for (const line of lines) {
        const obj = JSON.parse(line);
        expect(typeof obj.question_id).toBe('string');
        expect(typeof obj.hypothesis).toBe('string');
        expect(obj.hypothesis).toContain('canned-answer-stub');
      }
      // Stub was called for every question with the right system + user shape.
      // Retrieval may legitimately miss on --keyword-only (websearch AND requires
      // every term to appear in one chunk); the harness wiring is what we're
      // pinning here, not retrieval recall. We assert at least one call had a
      // non-empty <chat_session> block to prove the sanitize + render path
      // executed end-to-end.
      expect(calls.length).toBe(5);
      let withSessionsCount = 0;
      for (const c of calls) {
        expect(c.system).toContain('UNTRUSTED');
        expect(c.userText).toContain('Question:');
        expect(c.userText).toContain('Retrieved sessions:');
        if (c.userText.includes('<chat_session')) withSessionsCount++;
      }
      expect(withSessionsCount).toBeGreaterThan(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 9. end-to-end retrieval-only (no LLM)
// ---------------------------------------------------------------------------

describe('runEvalLongMemEval: --retrieval-only path', () => {
  test('5-question fixture produces 5 lines without an LLM client', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      // No client passed: retrieval-only never calls the client, so this works.
      await runEvalLongMemEval([
        FIXTURE_PATH, '--keyword-only', '--retrieval-only',
        '--limit', '5', '--output', outPath, '--top-k', '3',
      ]);
      const raw = readFileSync(outPath, 'utf8');
      const lines = raw.split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(5);
      for (const line of lines) {
        const obj = JSON.parse(line);
        expect(typeof obj.question_id).toBe('string');
        expect(typeof obj.hypothesis).toBe('string');
        // retrieval-only hypotheses include rendered session text
        // (or empty when retrieval missed everything — both are valid).
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 10. JSONL format guard (LF + UTF-8)
// ---------------------------------------------------------------------------

describe('JSONL format guard', () => {
  test('each line ends with \\n, no \\r anywhere, UTF-8 round-trip is byte-equal', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      const { client } = makeStubClient('format-stub');
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '3', '--output', outPath],
        { client },
      );
      const buf = readFileSync(outPath);
      // No CR bytes anywhere.
      for (let i = 0; i < buf.length; i++) {
        expect(buf[i]).not.toBe(0x0d);
      }
      // File ends with a single LF.
      expect(buf[buf.length - 1]).toBe(0x0a);
      const text = buf.toString('utf8');
      // UTF-8 round-trip is byte-equal.
      expect(Buffer.from(text, 'utf8').equals(buf)).toBe(true);
      // Each non-empty line is valid JSON.
      const lines = text.split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(3);
      for (const line of lines) {
        const obj = JSON.parse(line);
        expect(obj.question_id).toBeDefined();
        expect(obj.hypothesis).toBeDefined();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 11. JSONL key contract (additive, never replace)
// ---------------------------------------------------------------------------

describe('JSONL key contract', () => {
  test('every line carries question_id + hypothesis at minimum', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      await runEvalLongMemEval([
        FIXTURE_PATH, '--keyword-only', '--retrieval-only',
        '--limit', '3', '--output', outPath,
      ]);
      const text = readFileSync(outPath, 'utf8');
      const lines = text.split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(3);
      for (const line of lines) {
        const obj = JSON.parse(line);
        expect(Object.keys(obj)).toContain('question_id');
        expect(Object.keys(obj)).toContain('hypothesis');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 12. per-question failure handling
// ---------------------------------------------------------------------------

describe('per-question failure handling', () => {
  test('one broken question does not kill the run; emits error JSONL line', async () => {
    // Build an in-memory fixture with one malformed entry: missing
    // haystack_sessions array entirely. haystackToPages reads that field,
    // so the per-question try/catch must catch the resulting error.
    const tmp = mkdtempSync(join(tmpdir(), 'lme-test-'));
    const fixturePath = join(tmp, 'broken.jsonl');
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      const valid: LongMemEvalQuestion = {
        question_id: 'lme-ok-1',
        question_type: 'single-session-user',
        question: 'apple keyword',
        answer: 'a',
        haystack_dates: ['2025-01-01'],
        answer_session_ids: ['ok-sess'],
        haystack_sessions: [
          { session_id: 'ok-sess', turns: [{ role: 'user', content: 'apple in a session' }] },
        ],
      };
      const broken = {
        question_id: 'lme-broken-1',
        question_type: 'single-session-user',
        question: 'will fail',
        answer: 'a',
        // missing haystack_sessions on purpose
      };
      const { writeFileSync } = await import('fs');
      writeFileSync(
        fixturePath,
        JSON.stringify(valid) + '\n' + JSON.stringify(broken) + '\n' + JSON.stringify(valid) + '\n',
        'utf8',
      );
      await runEvalLongMemEval([
        fixturePath, '--keyword-only', '--retrieval-only', '--output', outPath,
      ]);
      const text = readFileSync(outPath, 'utf8');
      const lines = text.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
      expect(lines.length).toBe(3);
      expect(lines[0].question_id).toBe('lme-ok-1');
      expect(typeof lines[0].hypothesis).toBe('string');
      expect(lines[1].question_id).toBe('lme-broken-1');
      expect(lines[1].hypothesis).toBe('');
      expect(typeof lines[1].error).toBe('string');
      expect(lines[1].error.length).toBeGreaterThan(0);
      expect(lines[2].question_id).toBe('lme-ok-1');
      expect(typeof lines[2].hypothesis).toBe('string');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 13. v0.35.1.0: --resume-from
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

describe('runEvalLongMemEval --resume-from (v0.35.1.0)', () => {
  test('skips already-answered questions and appends to the same output file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-resume-'));
    const outPath = join(tmp, 'hypothesis.jsonl');
    try {
      // Simulate prior run: 2 questions already answered, written to the file
      // with hypothesis set. The fixture has 5 questions total.
      const { writeFileSync } = await import('fs');
      const fixture = readFileSync(FIXTURE_PATH, 'utf8')
        .split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
      writeFileSync(
        outPath,
        [
          JSON.stringify({ question_id: fixture[0].question_id, hypothesis: 'prior-1' }),
          JSON.stringify({ question_id: fixture[1].question_id, hypothesis: 'prior-2' }),
        ].join('\n') + '\n',
        'utf8',
      );

      const { client } = makeStubClient('resumed-answer');
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '5', '--top-k', '3',
         '--output', outPath, '--resume-from', outPath],
        { client },
      );

      const text = readFileSync(outPath, 'utf8');
      const lines = text.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
      // 2 prior rows + 3 new rows = 5 total
      expect(lines.length).toBe(5);
      // First two preserve their prior hypothesis (proves append, not truncate).
      expect(lines[0].hypothesis).toBe('prior-1');
      expect(lines[1].hypothesis).toBe('prior-2');
      // Newly-answered three carry the canned stub.
      for (let i = 2; i < 5; i++) {
        expect(lines[i].hypothesis).toContain('resumed-answer');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  test('all questions already done -> early return, no client calls', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lme-resume-'));
    const outPath = join(tmp, 'all-done.jsonl');
    try {
      const { writeFileSync } = await import('fs');
      const fixture = readFileSync(FIXTURE_PATH, 'utf8')
        .split('\n').filter(l => l.length > 0).map(l => JSON.parse(l)).slice(0, 5);
      writeFileSync(
        outPath,
        fixture.map(q => JSON.stringify({ question_id: q.question_id, hypothesis: 'done' })).join('\n') + '\n',
        'utf8',
      );
      const { client, calls } = makeStubClient('should-not-be-called');
      await runEvalLongMemEval(
        [FIXTURE_PATH, '--keyword-only', '--limit', '5',
         '--output', outPath, '--resume-from', outPath],
        { client },
      );
      // The client must not have been invoked at all — every question was skipped.
      expect(calls.length).toBe(0);
      // The output file is untouched (no new lines appended).
      const lines = readFileSync(outPath, 'utf8').split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(5);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
