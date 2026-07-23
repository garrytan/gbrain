/**
 * E4 — advisor ranking-precision eval.
 *
 * Measures the FEATURE (per the North Star): on synthetic, anonymized brains
 * with KNOWN seeded defects, does the advisor surface the right findings and
 * rank them correctly (critical > warn > info)? This tests the advisor's own
 * logic, not the remediation loop — each fixture injects defects through the
 * exact channels the collectors read (getStats/getHealth, minion_jobs, config),
 * then we score precision = (expected findings surfaced) / (expected total).
 *
 * Runs in the unit shard (under test/) so it's CI-gated; deterministic and
 * zero-API-cost (seeded fake engines), so it belongs with the unit suite rather
 * than a manual harness. Never ships downstream (test/ is not bundled).
 *
 * Synthetic only: no real brain content (anonymized fixtures), per the
 * calibration-corpus rule.
 */
import { describe, test, expect } from 'bun:test';
import { runAdvisor } from '../src/core/advisor/run.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';

interface Fixture {
  name: string;
  engine: Partial<AdvisorContext['engine']>;
  config?: Partial<AdvisorContext['config']>;
  remote?: boolean;
  /** Finding ids (or id prefixes) we expect to surface. */
  expect: string[];
  /** Finding ids that must NOT surface. */
  forbid?: string[];
}

const HEALTHY_STATS = {
  getStats: async () => ({
    page_count: 500, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {},
  }),
  getHealth: async () => ({
    page_count: 500, embed_coverage: 0.99, stale_pages: 0, orphan_pages: 0, missing_embeddings: 0,
    brain_score: 95, dead_links: 0, link_coverage: 1, timeline_coverage: 1, most_connected: [],
    embed_coverage_score: 35, link_density_score: 25, timeline_coverage_score: 15, no_orphans_score: 15, no_dead_links_score: 10,
  }),
  getConfig: async () => null,
  executeRaw: async () => [],
};

const FIXTURES: Fixture[] = [
  {
    name: 'healthy brain → no findings',
    engine: { ...HEALTHY_STATS },
    expect: [],
    forbid: ['low_embed_coverage', 'orphan_pages', 'embeddings_disabled'],
  },
  {
    name: 'degraded recall: low embed coverage + orphans',
    engine: {
      ...HEALTHY_STATS,
      getHealth: async () => ({
        page_count: 500, embed_coverage: 0.3, stale_pages: 0, orphan_pages: 12, missing_embeddings: 350,
        brain_score: 40, dead_links: 2, link_coverage: 0.2, timeline_coverage: 0.2, most_connected: [],
        embed_coverage_score: 10, link_density_score: 5, timeline_coverage_score: 3, no_orphans_score: 2, no_dead_links_score: 8,
      }),
    },
    expect: ['low_embed_coverage', 'orphan_pages', 'dead_links'],
  },
  {
    name: 'stalled worker + stale source',
    engine: {
      ...HEALTHY_STATS,
      executeRaw: (async (sql: string) => {
        if (/minion_jobs/.test(sql)) return [{ name: 'embed-backfill', n: 3 }];
        if (/sources/.test(sql)) return [{ id: 'wiki' }];
        return [];
      }) as AdvisorContext['engine']['executeRaw'],
    },
    expect: ['stalled_job:embed-backfill', 'stale_sync:wiki'],
  },
  {
    name: 'setup smell: embeddings disabled',
    engine: { ...HEALTHY_STATS },
    config: { embedding_disabled: true } as AdvisorContext['config'],
    expect: ['embeddings_disabled'],
  },
];

function ctxFor(fx: Fixture): AdvisorContext {
  return {
    engine: fx.engine as AdvisorContext['engine'],
    config: (fx.config ?? {}) as AdvisorContext['config'],
    version: '0.43.0.0',
    workspace: null,
    skillsDir: null,
    now: new Date('2026-06-16T00:00:00Z'),
    remote: fx.remote ?? false,
  };
}

describe('E4 advisor ranking-precision eval', () => {
  test('every seeded defect is surfaced and severities rank correctly', async () => {
    let expectedTotal = 0;
    let surfaced = 0;
    const SEV: Record<string, number> = { critical: 0, warn: 1, info: 2 };

    for (const fx of FIXTURES) {
      const report = await runAdvisor(ctxFor(fx));
      const ids = report.findings.map((f) => f.id);

      for (const want of fx.expect) {
        expectedTotal++;
        if (ids.some((id) => id === want || id.startsWith(want))) surfaced++;
        else console.error(`  [${fx.name}] MISSED expected finding: ${want}`);
      }
      for (const no of fx.forbid ?? []) {
        expect(ids.find((id) => id === no || id.startsWith(no))).toBeUndefined();
      }
      // Ranking monotonic: severities never increase down the list.
      const sevs = report.findings.map((f) => SEV[f.severity]!);
      for (let i = 1; i < sevs.length; i++) expect(sevs[i]!).toBeGreaterThanOrEqual(sevs[i - 1]!);
    }

    const precision = expectedTotal === 0 ? 1 : surfaced / expectedTotal;
    console.error(`\nE4 advisor ranking precision: ${surfaced}/${expectedTotal} = ${(precision * 100).toFixed(0)}%`);
    expect(precision).toBe(1);
  });

  test('remote advisor drops workspace-dependent findings (A1)', async () => {
    // A brain-pack uninstalled finding is workspace_dependent; over MCP it must
    // not appear even though the collector would fire locally.
    const report = await runAdvisor(ctxFor({ ...FIXTURES[0]!, remote: true }));
    expect(report.findings.every((f) => !f.workspace_dependent)).toBe(true);
  });
});
