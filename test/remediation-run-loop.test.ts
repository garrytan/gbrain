import { describe, expect, mock, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { BrainHealth } from '../src/core/types.ts';

const attemptedJobs: string[] = [];

mock.module('../src/core/minions/queue.ts', () => ({
  MinionQueue: class {
    async add(name: string) {
      attemptedJobs.push(name);
      return { id: attemptedJobs.length };
    }
  },
}));

mock.module('../src/core/minions/wait-for-completion.ts', () => ({
  waitForCompletion: async (_queue: unknown, jobId: number) => ({
    id: jobId,
    status: 'completed',
  }),
}));

mock.module('../src/core/remediation-checkpoint.ts', () => ({
  computePlanHash: (ids: string[]) => [...ids].sort().join('|'),
  saveRemediationCheckpoint: () => undefined,
  loadRemediationCheckpoint: () => null,
  listRemediationCheckpoints: () => [],
  clearRemediationCheckpoint: () => undefined,
}));

mock.module('../src/core/ai/gateway.ts', () => ({
  getEmbeddingModel: () => 'ollama:nomic-embed-text',
  getEmbeddingDimensions: () => 768,
  withBudgetTracker: async (_tracker: unknown, fn: () => Promise<void>) => fn(),
}));

const { runRemediation } = await import('../src/core/remediation/run.ts');

function makeHealth(): BrainHealth {
  return {
    page_count: 100,
    embed_coverage: 1,
    stale_pages: 1,
    orphan_pages: 0,
    missing_embeddings: 0,
    brain_score: 80,
    dead_links: 1,
    link_coverage: 1,
    timeline_coverage: 1,
    most_connected: [],
    embed_coverage_score: 35,
    link_density_score: 25,
    timeline_coverage_score: 15,
    no_orphans_score: 15,
    no_dead_links_score: 0,
  };
}

describe('runRemediation recheck loop guard', () => {
  test('attempts a stable stuck remediation once and continues to later work', async () => {
    attemptedJobs.length = 0;
    const health = makeHealth();
    const engine = {
      kind: 'postgres',
      getHealth: async () => health,
      getConfig: async (key: string) => key === 'sync.repo_path' ? '/brain' : null,
    } as BrainEngine;

    const result = await runRemediation(engine, { maxJobs: 4 });

    expect(attemptedJobs.filter((name) => name === 'backlinks')).toHaveLength(1);
    expect(attemptedJobs).toEqual(['backlinks', 'sync', 'extract']);
    expect(result.submitted.map((step) => step.id)).toEqual([
      'backlinks.fix',
      'sync.repo',
      'extract.all',
    ]);
  });
});
