// test/remediation-run-d7-refresh.serial.test.ts
//
// Pins the D7-recheck half of the extraction-lag gate fix: runRemediation
// loads RecommendationContext ONCE before the step loop, and the per-step
// recheck (D7) must REFRESH ctx.extractionLagPages alongside getHealth.
// Without the refresh, a completed sync/extract step keeps re-firing off
// the frozen initial count — the plan never converges and the loop burns
// steps until maxJobs.
//
// SERIAL (R2): uses top-level mock.module for the minion queue +
// wait-for-completion so no real worker is needed — mocks leak across
// files in a shard process, so this file must run in its own process.

import { describe, expect, mock, test } from 'bun:test';

// The fake brain: sync.repo clears the extraction lag when it "runs"
// (today's sync materializes link/timeline edges; extract.all is the
// explicit re-materializer). The frozen-ctx bug makes runRemediation
// ignore that and resubmit sync.repo on every D7 recheck.
let extractionLag = 25;
const submittedJobs: string[] = [];

mock.module('../src/core/minions/queue.ts', () => ({
  MinionQueue: class {
    constructor(_engine: unknown) {}
    async add(job: string): Promise<{ id: number }> {
      submittedJobs.push(job);
      if (job === 'sync' || job === 'extract') extractionLag = 0;
      return { id: submittedJobs.length };
    }
  },
}));

mock.module('../src/core/minions/wait-for-completion.ts', () => ({
  waitForCompletion: async () => ({ status: 'completed' }),
}));

const health = () => ({
  page_count: 100,
  embed_coverage: 1.0,
  stale_pages: 0, // legacy proxy stays 0 — the real counter drives the gate
  orphan_pages: 0,
  missing_embeddings: 0,
  brain_score: 70,
  dead_links: 0,
  link_coverage: 1.0,
  timeline_coverage: 1.0,
  most_connected: [],
  embed_coverage_score: 35,
  link_density_score: 25,
  timeline_coverage_score: 15,
  no_orphans_score: 15,
  no_dead_links_score: 10,
});

const fakeEngine = {
  kind: 'pglite' as const,
  getHealth: async () => health(),
  getConfig: async (key: string) =>
    key === 'sync.repo_path' ? '/tmp/brain-example' : null,
  countStalePagesForExtraction: async () => extractionLag,
};

describe('runRemediation D7 recheck — extraction-lag gate refresh', () => {
  test('a completed materializer step clears the gate; the pipeline is not resubmitted', async () => {
    const { runRemediation } = await import('../src/core/remediation/run.ts');
    const result = await runRemediation(
      // Only the methods the orchestrator touches are needed.
      fakeEngine as never,
      { targetScore: 0, maxJobs: 6 },
    );
    // Frozen-ctx bug: extractionLagPages stays 25 forever, so every D7
    // recheck re-introduces the sync/extract pipeline and the loop burns
    // all 6 maxJobs. With the refresh, the plan converges after the first
    // completed step: no step id is ever submitted twice.
    const ids = result.submitted.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(submittedJobs.length).toBeLessThan(3);
    expect(extractionLag).toBe(0);
  });
});
