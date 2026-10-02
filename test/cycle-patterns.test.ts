/**
 * Unit tests for the patterns phase (v0.21).
 *
 * Driven through `runPhasePatterns` and its `__testing` helpers on one
 * in-memory PGLite brain. Paths that would reach a real subagent stop at a
 * cheap gate instead: `dryRun`, the provider probe (`no_provider`), or a
 * near deadline (`insufficient_cycle_budget`, checked after the probe and
 * the allow-list load). Child outcomes, the evidence watermark, source
 * scoping and the budget clamp have their own files
 * (test/cycle-patterns-*.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { __testing, runPhasePatterns } from '../src/core/cycle/patterns.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // resetPgliteState truncates `config`, including the `version` row that
  // MinionQueue.ensureSchema checks before a submission.
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

async function seed(slugs: string[], ageMinutes = 0): Promise<void> {
  for (const slug of slugs) {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, updated_at)
       VALUES ($1, 'note', $1, 'reflection body', NOW() - ($2 || ' minutes')::interval)`,
      [slug, String(ageMinutes)],
    );
  }
}

const reflections = (n: number, prefix = 'wiki/personal/reflections') =>
  Array.from({ length: n }, (_, i) => `${prefix}/r-${i}`);

function noKeys<T>(fn: () => Promise<T>, extra: Record<string, string | undefined> = {}) {
  return withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, ...extra }, fn);
}

describe('patterns reflection gathering', () => {
  test('reflection excerpts never split a UTF-16 surrogate pair', async () => {
    const rocket = '\uD83D\uDE80';
    const compiledTruth = `${'a'.repeat(599)}${rocket}tail`;
    const fake = {
      executeRaw: async () => [{
        slug: 'wiki/personal/reflections/example',
        title: 'Example',
        compiled_truth: compiledTruth,
      }],
    } as unknown as BrainEngine;

    const [reflection] = await __testing.gatherReflections(fake, 30);

    expect(reflection.excerpt.isWellFormed()).toBe(true);
    expect(reflection.excerpt.endsWith(rocket)).toBe(false);
    expect(reflection.excerpt.length).toBe(599);
  });

  test('scoped to <prefix>/, newest first, capped at 100, bounded by lookback', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, updated_at)
       SELECT 'wiki/personal/reflections/r-' || lpad(g::text, 3, '0'), 'note', 'R', 'body',
              NOW() - (g || ' minutes')::interval
         FROM generate_series(0, 100) g`,
    );
    await seed(['wiki/personal/reflections-archive/newest', 'wiki/personal/other/newest']);

    const rows = await __testing.gatherReflections(engine, 30, 'wiki/personal/reflections', 'default');
    expect(rows).toHaveLength(100);
    expect(rows[0]!.slug).toBe('wiki/personal/reflections/r-000');
    expect(rows[99]!.slug).toBe('wiki/personal/reflections/r-099');
    expect(rows.every(r => r.slug.startsWith('wiki/personal/reflections/'))).toBe(true);


    await seed(['journal/old/x'], 40 * 24 * 60);
    expect(await __testing.gatherReflections(engine, 30, 'journal/old', 'default')).toHaveLength(0);
    expect(await __testing.gatherReflections(engine, 60, 'journal/old', 'default')).toHaveLength(1);
  });
});

describe('patterns config knobs (dry-run)', () => {
  test('min_evidence: 2 reflections skip by default (needs 3) and run at min_evidence=2', async () => {
    await seed(reflections(2));
    const skipped = await runPhasePatterns(engine, { brainDir: '/tmp', dryRun: true });
    expect(skipped.status).toBe('skipped');
    expect(skipped.details.reason).toBe('insufficient_evidence');

    await engine.setConfig('dream.patterns.min_evidence', '2');
    const ran = await runPhasePatterns(engine, { brainDir: '/tmp', dryRun: true });
    expect(ran.status).toBe('ok');
    expect(ran.details.reflections_considered).toBe(2);
  });

  test('lookback_days narrows the window', async () => {
    await seed(reflections(3), 5 * 24 * 60);
    const wide = await runPhasePatterns(engine, { brainDir: '/tmp', dryRun: true });
    expect(wide.details.reflections_considered).toBe(3);
    await engine.setConfig('dream.patterns.lookback_days', '1');
    const narrow = await runPhasePatterns(engine, { brainDir: '/tmp', dryRun: true });
    expect(narrow.details.reason).toBe('insufficient_evidence');
  });

  test('source_slug_prefix points the phase at another reflection tree', async () => {
    await seed(reflections(3, 'journal/entries'));
    const def = await runPhasePatterns(engine, { brainDir: '/tmp', dryRun: true });
    expect(def.details.reason).toBe('insufficient_evidence');
    await engine.setConfig('dream.patterns.source_slug_prefix', 'journal/entries');
    const custom = await runPhasePatterns(engine, { brainDir: '/tmp', dryRun: true });
    expect(custom.status).toBe('ok');
    expect(custom.details.reflections_considered).toBe(3);
  });
});

describe('patterns provider gate (PR #2279)', () => {
  // A near deadline makes a probe-passing run stop at insufficient_cycle_budget
  // before any subagent is submitted.
  const nearDeadline = () => Date.now() + 1_000;

  test('the default Anthropic model with no key skips as no_provider', async () => {
    await seed(reflections(3));
    const r = await noKeys(() => runPhasePatterns(engine, { brainDir: '/tmp', dryRun: false, deadlineAtMs: nearDeadline() }));
    expect(r.status).toBe('skipped');
    expect(r.details.reason).toBe('no_provider');
  });

  test('a non-Anthropic model passes the gate with no ANTHROPIC_API_KEY', async () => {
    await seed(reflections(3));
    await engine.setConfig('models.dream.patterns', 'openai:gpt-5.4');
    const r = await noKeys(
      () => runPhasePatterns(engine, { brainDir: '/tmp', dryRun: false, deadlineAtMs: nearDeadline() }),
      { OPENAI_API_KEY: 'sk-test' },
    );
    expect(r.details.reason).toBe('insufficient_cycle_budget');
  });

  test('a bare model id is normalized to its provider before probing', async () => {
    await seed(reflections(3));
    await engine.setConfig('models.dream.patterns', 'claude-sonnet-4-6');
    const r = await noKeys(
      () => runPhasePatterns(engine, { brainDir: '/tmp', dryRun: false, deadlineAtMs: nearDeadline() }),
      { ANTHROPIC_API_KEY: 'sk-ant-test' },
    );
    expect(r.details.reason).toBe('insufficient_cycle_budget');
  });
});

describe('patterns subagent submission', () => {
  test('job carries filing-rule + configured output allow-list and prompt prefixes; no raw_data', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-submit-'));
    try {
      await seed(reflections(3));
      await engine.setConfig('dream.patterns.output_slug_prefix', 'journal/themes');
      // Fake key with fetch stubbed offline: the inline drain's provider call
      // fails at once and the child dead-letters, with no network access.
      const offline = spyOn(globalThis, 'fetch').mockImplementation((async () => { throw new Error('offline'); }) as never);
      let result;
      try {
        result = await noKeys(
          () => runPhasePatterns(engine, { brainDir, dryRun: false }),
          { ANTHROPIC_API_KEY: 'sk-ant-test' },
        );
      } finally {
        offline.mockRestore();
      }
      expect(result.details.child_outcome).toBeDefined();
      const [job] = await engine.executeRaw<{ data: any }>(
        `SELECT data FROM minion_jobs WHERE name = 'subagent' ORDER BY id DESC LIMIT 1`,
      );
      const data = typeof job!.data === 'string' ? JSON.parse(job!.data) : job!.data;
      expect(data.allowed_slug_prefixes).toContain('wiki/personal/patterns/*');
      expect(data.allowed_slug_prefixes).toContain('journal/themes/*');
      expect(data.prompt).toContain('journal/themes/<topic-slug>');
      expect(data.prompt).toContain('[[wiki/personal/reflections/r-0]]');
      const [raw] = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM raw_data');
      expect(raw!.n).toBe(0);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('patterns private-queue keepalive wiring', () => {
  test('the post-drain wait renews the private-queue lease through the shared throttled factory', () => {
    // test-reads-source-ok[structural]: the lease only lapses after a >10-minute post-drain wait with a live child, which no unit harness reaches; the invariant is that patterns reuses queue.makeThrottledLeaseRenewer + waitForCompletionRenewing instead of an inline closure that drifts from synthesize's (library behavior: test/wait-for-completion.test.ts, test/queue-child-done.test.ts).
    const src = readFileSync(new URL('../src/core/cycle/patterns.ts', import.meta.url), 'utf8');
    expect(src).toContain('queue.makeThrottledLeaseRenewer(');
    expect(src).toMatch(/waitForCompletionRenewing\(queue, job\.id, \{[\s\S]*?renew: renewPrivateQueueLease/);
  });
});

describe('patterns reverse-write', () => {
  test('writes the page back as markdown that round-trips title, type, tags and body', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-rw-'));
    try {
      await engine.putPage('wiki/personal/patterns/focus', {
        type: 'note', title: 'Focus', compiled_truth: 'Recurring focus theme.', timeline: '', frontmatter: {},
      });
      await engine.addTag('wiki/personal/patterns/focus', 'theme');
      const n = await __testing.reverseWriteRefs(engine, brainDir, [{ slug: 'wiki/personal/patterns/focus', source_id: 'default' }]);
      expect(n).toBe(1);
      const parsed = parseMarkdown(readFileSync(join(brainDir, 'wiki/personal/patterns/focus.md'), 'utf8'));
      expect(parsed.title).toBe('Focus');
      expect(parsed.type).toBe('note');
      expect(parsed.tags).toEqual(['theme']);
      expect(parsed.compiled_truth.trim()).toBe('Recurring focus theme.');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  });
});
