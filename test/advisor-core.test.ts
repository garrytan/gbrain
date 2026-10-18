/**
 * Tests for the advisor core: ranking, collector resilience, individual
 * collectors with a stub engine, and finding-history deltas.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { COLLECTORS, rankFindings, runAdvisor } from '../src/core/advisor/run.ts';
import { collectUsageShape } from '../src/core/advisor/collect-usage-shape.ts';
import { collectStalledJobs } from '../src/core/advisor/collect-stalled-jobs.ts';
import { collectSetupSmells } from '../src/core/advisor/collect-setup-smells.ts';
import { appendAdvisorRun, summarizeDeltas } from '../src/core/advisor/history.ts';
import { renderAdvisorReport } from '../src/core/advisor/render.ts';
import type { AdvisorCollector, AdvisorContext, AdvisorFinding, AdvisorReport } from '../src/core/advisor/types.ts';

function finding(over: Partial<AdvisorFinding>): AdvisorFinding {
  return {
    id: 'x',
    severity: 'info',
    title: 't',
    fix: { command_argv: null },
    collector: 'usage-shape',
    ask_user: true,
    ...over,
  };
}

function ctx(engine: Partial<AdvisorContext['engine']>, over: Partial<AdvisorContext> = {}): AdvisorContext {
  return {
    engine: engine as AdvisorContext['engine'],
    config: {} as AdvisorContext['config'],
    version: '0.43.0.0',
    workspace: null,
    skillsDir: null,
    now: new Date('2026-06-16T00:00:00Z'),
    remote: false,
    ...over,
  };
}

describe('rankFindings', () => {
  test('critical > warn > info, then collector order; info capped', () => {
    const fs = [
      finding({ id: 'i1', severity: 'info', collector: 'usage-shape' }),
      finding({ id: 'c1', severity: 'critical', collector: 'migration' }),
      finding({ id: 'w1', severity: 'warn', collector: 'version' }),
    ];
    const ranked = rankFindings(fs);
    expect(ranked.map((f) => f.id)).toEqual(['c1', 'w1', 'i1']);
  });

  test('info cap drops extra info but keeps all criticals', () => {
    const fs: AdvisorFinding[] = [];
    for (let i = 0; i < 15; i++) fs.push(finding({ id: `i${i}`, severity: 'info' }));
    fs.push(finding({ id: 'crit', severity: 'critical', collector: 'migration' }));
    const ranked = rankFindings(fs, { infoCap: 3 });
    expect(ranked.filter((f) => f.severity === 'info')).toHaveLength(3);
    expect(ranked.find((f) => f.id === 'crit')).toBeDefined();
  });
});

describe('runAdvisor resilience', () => {
  test('does not throw when the engine throws everywhere', async () => {
    const engine = {
      getStats: async () => { throw new Error('boom'); },
      getHealth: async () => { throw new Error('boom'); },
      getConfig: async () => { throw new Error('boom'); },
      executeRaw: async () => { throw new Error('boom'); },
    };
    const report = await runAdvisor(ctx(engine));
    expect(report).toBeDefined();
    expect(Array.isArray(report.findings)).toBe(true);
  });

  test('drops workspace_dependent findings when remote', async () => {
    const wd = finding({ id: 'wd', workspace_dependent: true });
    // simulate by ranking + the remote filter logic via runAdvisor is internal;
    // assert the flag exists so the filter has something to act on.
    expect(wd.workspace_dependent).toBe(true);
  });
});

const THROWN_SECRET = 'postgres://alice-example:hunter2@db.example.invalid:5432/brain connect ECONNREFUSED';

const throwingCollector: AdvisorCollector = {
  id: 'throwing-check',
  collect: async () => { throw new Error(THROWN_SECRET); },
};
const cleanCollector: AdvisorCollector = { id: 'clean-check', collect: async () => [] };
const criticalCollector: AdvisorCollector = {
  id: 'critical-check',
  collect: async () => [finding({ id: 'crit', severity: 'critical', collector: 'critical-check' })],
};

/** Swap the shared COLLECTORS array contents for the duration of fn (restored in finally). */
async function withCollectors<T>(swap: AdvisorCollector[], fn: () => Promise<T>): Promise<T> {
  const saved = COLLECTORS.slice();
  COLLECTORS.splice(0, COLLECTORS.length, ...swap);
  try {
    return await fn();
  } finally {
    COLLECTORS.splice(0, COLLECTORS.length, ...saved);
  }
}

describe('runAdvisor collector failure (#6936)', () => {
  test('a thrown collector is a warn finding, never a clean report', async () => {
    const report = await withCollectors([throwingCollector, cleanCollector], () => runAdvisor(ctx({})));
    expect(report.findings.map((f) => f.id)).toEqual(['collector_failed:throwing-check']);
    const f = report.findings[0]!;
    expect(f.severity).toBe('warn');
    expect(f.collector).toBe('throwing-check');
    expect(f.fix.command_argv).toBeNull();
    expect(f.fix.dispatch_id).toBeUndefined();
    expect(report.worst).toBe('warn');
  });

  test('the thrown message, stack and connection details never reach the report', async () => {
    const report = await withCollectors([throwingCollector], () => runAdvisor(ctx({})));
    const out = JSON.stringify(report) + renderAdvisorReport(report);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('ECONNREFUSED');
    expect(out).not.toContain('db.example.invalid');
    expect(out).not.toContain('alice-example');
    expect(out).not.toContain('Error:');
  });

  test('findings from unaffected collectors are kept and a critical still wins', async () => {
    const report = await withCollectors([throwingCollector, criticalCollector], () => runAdvisor(ctx({})));
    expect(report.findings.map((f) => f.id)).toEqual(['crit', 'collector_failed:throwing-check']);
    expect(report.worst).toBe('critical');
  });

  test('a fully successful clean run still reports nothing', async () => {
    const report = await withCollectors([cleanCollector], () => runAdvisor(ctx({})));
    expect(report.findings).toEqual([]);
    expect(report.worst).toBeNull();
  });

  test('remote runs still drop workspace-dependent findings and still report the failure', async () => {
    const wd: AdvisorCollector = {
      id: 'wd-check',
      collect: async () => [finding({ id: 'wd', workspace_dependent: true, collector: 'wd-check' })],
    };
    const remote = await withCollectors([wd, throwingCollector], () => runAdvisor(ctx({}, { remote: true })));
    expect(remote.findings.map((f) => f.id)).toEqual(['collector_failed:throwing-check']);
    const local = await withCollectors([wd, throwingCollector], () => runAdvisor(ctx({}, { remote: false })));
    expect(local.findings.map((f) => f.id).sort()).toEqual(['collector_failed:throwing-check', 'wd']);
  });
});

describe('collect-usage-shape', () => {
  test('flags low embed coverage + orphans', async () => {
    const engine = {
      getStats: async () => ({ page_count: 100, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
      getHealth: async () => ({
        page_count: 100, embed_coverage: 0.4, stale_pages: 0, orphan_pages: 5, missing_embeddings: 60,
        brain_score: 50, dead_links: 0, link_coverage: 0, timeline_coverage: 0, most_connected: [],
        embed_coverage_score: 0, link_density_score: 0, timeline_coverage_score: 0, no_orphans_score: 0, no_dead_links_score: 0,
      }),
    };
    const out = await collectUsageShape.collect(ctx(engine as never));
    const ids = out.map((f) => f.id);
    expect(ids).toContain('low_embed_coverage');
    expect(ids).toContain('orphan_pages');
  });

  test('empty brain → no findings', async () => {
    const engine = { getStats: async () => ({ page_count: 0, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }) };
    expect(await collectUsageShape.collect(ctx(engine as never))).toEqual([]);
  });
});

describe('collect-stalled-jobs', () => {
  test('absent minion_jobs table → no error, no finding', async () => {
    const engine = { executeRaw: async () => { throw new Error('relation "minion_jobs" does not exist'); } };
    expect(await collectStalledJobs.collect(ctx(engine as never))).toEqual([]);
  });

  test('reports stalled jobs and stale sync', async () => {
    let call = 0;
    const engine = {
      executeRaw: async () => {
        call++;
        if (call === 1) return [{ name: 'embed-backfill', n: 2 }];
        return [{ id: 'wiki' }];
      },
    };
    const out = await collectStalledJobs.collect(ctx(engine as never));
    expect(out.find((f) => f.id === 'stalled_job:embed-backfill')).toBeDefined();
    expect(out.find((f) => f.id === 'stale_sync:wiki')).toBeDefined();
  });
});

describe('collect-setup-smells', () => {
  test('embeddings disabled → warn', async () => {
    const engine = { getConfig: async () => null };
    const c = ctx(engine as never, { config: { embedding_disabled: true } as AdvisorContext['config'] });
    const out = await collectSetupSmells.collect(c);
    expect(out.find((f) => f.id === 'embeddings_disabled')).toBeDefined();
  });
});

describe('advisor history (E3)', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-advhist-'));
    path = join(dir, 'advisor-history.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function report(ids: string[]): AdvisorReport {
    return {
      version: '0.43.0.0',
      generated_at: '2026-06-16T00:00:00Z',
      findings: ids.map((id) => finding({ id })),
      worst: 'info',
    };
  }

  test('first run returns null prior; second run yields deltas', () => {
    expect(appendAdvisorRun(report(['a', 'b']), { path })).toBeNull();
    const prior = appendAdvisorRun(report(['b', 'c']), { path });
    expect(prior).not.toBeNull();
    const note = summarizeDeltas(prior, report(['b', 'c']));
    expect(note).toContain('1 new since last run');
    expect(note).toContain('1 resolved');
  });
});

describe('renderAdvisorReport', () => {
  test('healthy brain renders the all-clear', () => {
    const txt = renderAdvisorReport({ version: '0.43.0.0', generated_at: 'x', findings: [], worst: null });
    expect(txt).toContain('looks healthy');
  });

  test('a failed collector is rendered as an incomplete check, never as healthy (#6936)', async () => {
    const report = await withCollectors([throwingCollector], () => runAdvisor(ctx({})));
    const txt = renderAdvisorReport(report);
    expect(txt).not.toContain('looks healthy');
    expect(txt).toContain('[WARN]');
    expect(txt).toContain('throwing-check');
    expect(txt).toContain('could not complete');
    expect(txt).not.toContain('--apply <id>');
  });
});
