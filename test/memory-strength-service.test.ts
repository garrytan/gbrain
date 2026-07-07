import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  computeMemoryStrengthReport,
  MEMORY_STRENGTH_FORMULA,
  slugFromRetrievalTraceSourceRef,
  type MemoryStrengthEngine,
} from '../src/core/services/memory-strength-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import type { Page, RetrievalTrace, RetrievalTraceWindowFilters } from '../src/core/types.ts';

const NOW = new Date('2026-07-06T00:00:00.000Z');
const HALF_LIFE_DAYS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

function fixtureTrace(input: {
  id: string;
  route: string[];
  source_refs: string[];
  verification?: string[];
  created_at: string;
}): RetrievalTrace {
  return {
    id: input.id,
    task_id: null,
    scope: 'work',
    route: input.route,
    source_refs: input.source_refs,
    derived_consulted: [],
    verification: input.verification ?? [],
    write_outcome: 'no_durable_write',
    selected_intent: null,
    scope_gate_policy: null,
    scope_gate_reason: null,
    elapsed_ms: null,
    retrieved_token_count: null,
    outcome: 'fixture trace',
    created_at: new Date(input.created_at),
  };
}

function fixturePage(slug: string, title: string, updatedAt: string): Page {
  return {
    id: 0,
    slug,
    type: 'concept',
    title,
    compiled_truth: '',
    timeline: '',
    frontmatter: {},
    created_at: new Date(updatedAt),
    updated_at: new Date(updatedAt),
    compiled_truth_changed_at: new Date(updatedAt),
    timeline_changed_at: new Date(updatedAt),
  };
}

const FIXTURE_TRACES: RetrievalTrace[] = [
  // systems/alpha: 2 confirmed answer-ready reads + 1 probe selection
  fixtureTrace({
    id: 'read-alpha-1',
    route: ['read_context'],
    source_refs: ['page:workspace:default:systems/alpha'],
    verification: ['answer_ready:ready'],
    created_at: '2026-07-04T00:00:00.000Z',
  }),
  fixtureTrace({
    id: 'read-alpha-2',
    route: ['read_context'],
    source_refs: ['compiled_truth:workspace:default:systems/alpha'],
    verification: ['answer_ready:ready'],
    created_at: '2026-07-01T00:00:00.000Z',
  }),
  fixtureTrace({
    id: 'probe-alpha',
    route: ['retrieve_context', 'page'],
    source_refs: ['page:workspace:default:systems/alpha'],
    verification: ['scenario:precision_lookup'],
    created_at: '2026-06-25T00:00:00.000Z',
  }),
  // concepts/beta: probe-only selection, never confirmed by read_context
  fixtureTrace({
    id: 'probe-beta',
    route: ['retrieve_context', 'page'],
    source_refs: ['page:workspace:default:concepts/beta'],
    verification: ['scenario:broad_synthesis'],
    created_at: '2026-06-20T00:00:00.000Z',
  }),
  // people/gamma: one read that surfaced conflicting canonical evidence
  fixtureTrace({
    id: 'read-gamma',
    route: ['read_context'],
    source_refs: ['page:workspace:default:people/gamma'],
    verification: ['answer_ready:not_ready', 'unsupported:conflicting_canonical_evidence'],
    created_at: '2026-06-10T00:00:00.000Z',
  }),
  // outside the 30-day window: must be excluded by the window filter
  fixtureTrace({
    id: 'read-alpha-old',
    route: ['read_context'],
    source_refs: ['page:workspace:default:systems/alpha'],
    verification: ['answer_ready:ready'],
    created_at: '2026-05-01T00:00:00.000Z',
  }),
  // non-retrieval trace (e.g. route planner): ignored entirely
  fixtureTrace({
    id: 'other-route',
    route: [],
    source_refs: ['page:workspace:default:systems/alpha'],
    verification: ['intent:precision_lookup'],
    created_at: '2026-07-05T00:00:00.000Z',
  }),
];

const FIXTURE_PAGES: Page[] = [
  fixturePage('systems/alpha', 'Alpha System', '2026-06-01T00:00:00.000Z'),
  fixturePage('concepts/beta', 'Beta Concept', '2026-06-02T00:00:00.000Z'),
  fixturePage('people/gamma', 'Gamma Person', '2026-06-03T00:00:00.000Z'),
  fixturePage('ideas/delta', 'Delta Idea', '2026-05-15T00:00:00.000Z'),
];

function fakeEngine(traces: RetrievalTrace[] = FIXTURE_TRACES, pages: Page[] = FIXTURE_PAGES): MemoryStrengthEngine {
  return {
    async listRetrievalTracesByWindow(filters: RetrievalTraceWindowFilters) {
      return traces
        .filter((trace) => trace.created_at >= filters.since && trace.created_at < filters.until)
        .slice(0, filters.limit ?? 500);
    },
    async listPages(filters) {
      return pages.slice(0, filters?.limit ?? pages.length);
    },
  };
}

function expectedStrength(base: number, days: number): number {
  return Math.round(base * Math.exp(-days / HALF_LIFE_DAYS) * 1000) / 1000;
}

describe('memory strength service', () => {
  test('computes explainable per-slug terms from read and probe traces', async () => {
    const report = await computeMemoryStrengthReport(fakeEngine(), { now: NOW });

    expect(report.formula).toBe(MEMORY_STRENGTH_FORMULA);
    expect(report.window.window_days).toBe(30);
    expect(report.half_life_days).toBe(HALF_LIFE_DAYS);
    expect(report.window.since).toBe('2026-06-06T00:00:00.000Z');
    expect(report.window.until).toBe('2026-07-06T00:00:00.000Z');
    // the 2026-05-01 trace is outside the window and never scanned
    expect(report.scanned_trace_count).toBe(6);

    const alpha = report.top_strength.find((entry) => entry.slug === 'systems/alpha');
    expect(alpha).toMatchObject({
      confirmed_read_count: 2,
      probe_selected_count: 1,
      answer_ready_count: 2,
      conflict_count: 0,
      last_read_at: '2026-07-04T00:00:00.000Z',
      last_activity_at: '2026-07-04T00:00:00.000Z',
      days_since_last_activity: 2,
    });
    // base = 2*2 + 3*2 + 1*1 = 11, decayed over 2 days
    expect(alpha?.strength_score).toBe(expectedStrength(11, 2));
    expect(alpha?.recency_factor).toBe(Math.round(Math.exp(-2 / HALF_LIFE_DAYS) * 10_000) / 10_000);

    const beta = report.top_strength.find((entry) => entry.slug === 'concepts/beta');
    expect(beta).toMatchObject({
      confirmed_read_count: 0,
      probe_selected_count: 1,
      answer_ready_count: 0,
      conflict_count: 0,
      last_read_at: null,
      days_since_last_activity: 16,
    });
    expect(beta?.strength_score).toBe(expectedStrength(1, 16));

    const gamma = report.top_strength.find((entry) => entry.slug === 'people/gamma');
    expect(gamma).toMatchObject({
      confirmed_read_count: 1,
      probe_selected_count: 0,
      answer_ready_count: 0,
      conflict_count: 1,
      last_read_at: '2026-06-10T00:00:00.000Z',
      days_since_last_activity: 26,
    });
    // base = 2*1 - 4*1 = -2: conflicted reads push strength negative
    expect(gamma?.strength_score).toBe(expectedStrength(-2, 26));
  });

  test('orders top_strength by score, flags fading reads, and lists never-used pages', async () => {
    const report = await computeMemoryStrengthReport(fakeEngine(), { now: NOW });

    expect(report.top_strength.map((entry) => entry.slug)).toEqual([
      'systems/alpha',
      'concepts/beta',
      'people/gamma',
    ]);
    // gamma's last read (06-10) predates the window half boundary (06-21)
    expect(report.fading.map((entry) => entry.slug)).toEqual(['people/gamma']);
    // beta is probe-only, so it never counts as previously read
    expect(report.never_used.map((entry) => entry.slug)).toEqual(['ideas/delta']);
    expect(report.never_used[0]).toMatchObject({ title: 'Delta Idea' });
    expect(report.totals).toEqual({
      pages_with_activity: 3,
      fading: 1,
      never_used: 1,
    });
    expect(report.scanned_page_count).toBe(4);
  });

  test('bounds every list by limit while keeping true totals', async () => {
    const report = await computeMemoryStrengthReport(fakeEngine(), { now: NOW, limit: 1 });

    expect(report.top_strength).toHaveLength(1);
    expect(report.top_strength[0]?.slug).toBe('systems/alpha');
    expect(report.fading).toHaveLength(1);
    expect(report.never_used).toHaveLength(1);
    expect(report.totals).toEqual({
      pages_with_activity: 3,
      fading: 1,
      never_used: 1,
    });
  });

  test('is deterministic for a fixed now', async () => {
    const first = await computeMemoryStrengthReport(fakeEngine(), { now: NOW });
    const second = await computeMemoryStrengthReport(fakeEngine(), { now: NOW.toISOString() });

    expect(second).toEqual(first);
  });

  test('honors a custom window_days for both trace window and fading half-life', async () => {
    const report = await computeMemoryStrengthReport(fakeEngine(), { now: NOW, window_days: 60 });

    expect(report.window.since).toBe('2026-05-07T00:00:00.000Z');
    expect(report.half_life_days).toBe(30);
    // half boundary moves to 06-06, so gamma (06-10) is no longer fading
    expect(report.fading).toEqual([]);
    // the 05-01 trace is still outside even the 60-day window? No: 05-07 < 05-01 is false,
    // so it stays excluded and alpha keeps 2 confirmed reads
    expect(report.top_strength.find((entry) => entry.slug === 'systems/alpha')?.confirmed_read_count).toBe(2);
  });

  test('rejects invalid options', async () => {
    await expect(computeMemoryStrengthReport(fakeEngine(), { window_days: 0 })).rejects.toThrow('window_days');
    await expect(computeMemoryStrengthReport(fakeEngine(), { limit: -1 })).rejects.toThrow('limit');
    await expect(computeMemoryStrengthReport(fakeEngine(), { now: 'not-a-date' })).rejects.toThrow('now');
  });

  test('parses page slugs out of retrieval-trace source refs', () => {
    expect(slugFromRetrievalTraceSourceRef('page:workspace:default:systems/alpha')).toBe('systems/alpha');
    expect(slugFromRetrievalTraceSourceRef('compiled_truth:workspace:default:a:b')).toBe('a:b');
    expect(slugFromRetrievalTraceSourceRef('line_span:workspace:default:systems/alpha:1:10')).toBe('systems/alpha');
    expect(slugFromRetrievalTraceSourceRef('page:workspace:default:systems/alpha@chars:0-100')).toBe('systems/alpha');
    expect(slugFromRetrievalTraceSourceRef('memory_candidate:abc')).toBeUndefined();
  });

  test('computes strength against a real SQLite engine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-memory-strength-'));
    const engine = new SQLiteEngine();
    try {
      await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
      await engine.initSchema();
      await engine.putPage('systems/alpha', {
        type: 'system',
        title: 'Alpha System',
        compiled_truth: 'Alpha compiled truth.',
      });
      await engine.putPage('ideas/delta', {
        type: 'concept',
        title: 'Delta Idea',
        compiled_truth: 'Delta compiled truth.',
      });
      await engine.putRetrievalTrace({
        id: 'trace-alpha-read',
        task_id: null,
        scope: 'work',
        route: ['read_context'],
        source_refs: ['page:workspace:default:systems/alpha'],
        verification: ['answer_ready:ready'],
        outcome: 'read_context returned canonical evidence',
      });

      const report = await computeMemoryStrengthReport(engine, {
        now: new Date(Date.now() + 60_000),
      });

      const alpha = report.top_strength.find((entry) => entry.slug === 'systems/alpha');
      expect(alpha).toMatchObject({
        confirmed_read_count: 1,
        answer_ready_count: 1,
        probe_selected_count: 0,
        conflict_count: 0,
      });
      expect(report.never_used.map((entry) => entry.slug)).toEqual(['ideas/delta']);
      expect(report.totals.never_used).toBe(1);
    } finally {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
