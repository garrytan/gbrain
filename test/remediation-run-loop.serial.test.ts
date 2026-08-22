import { describe, expect, mock, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { BrainHealth } from '../src/core/types.ts';

const attemptedJobs: string[] = [];
const submittedKeys: string[] = [];
// #3626 fixture: rows already holding an idempotency key. The real queue
// returns such a row stamped `coalesced: true` instead of inserting —
// completed/failed rows hold the key forever (only dead/cancelled free it).
const seededRows = new Map<string, { id: number; status: string }>();

mock.module('../src/core/minions/queue.ts', () => ({
  MinionQueue: class {
    async add(name: string, _data?: unknown, opts?: { idempotency_key?: string }) {
      const key = opts?.idempotency_key;
      if (key) submittedKeys.push(key);
      const seeded = key ? seededRows.get(key) : undefined;
      if (seeded) return { id: seeded.id, status: seeded.status, coalesced: true };
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
  // patterns/synthesize import the lease-renewing variant; a module mock
  // replaces the WHOLE module, so it must export every named import its
  // consumers reach for (a missing one is a load-time SyntaxError).
  waitForCompletionRenewing: async (
    _queue: unknown,
    jobId: number,
    opts?: { renew?: () => Promise<void> },
  ) => {
    if (opts?.renew) await opts.renew();
    return { id: jobId, status: 'completed' };
  },
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
    linkable_page_count: 100,
    embed_coverage: 1,
    stale_pages: 1,
    orphan_pages: 0,
    missing_embeddings: 0,
    brain_score: 80,
    dead_links: 1,
    link_coverage: 1,
    entity_page_count: 10,
    timeline_coverage: 1,
    most_connected: [],
    embed_coverage_score: 35,
    link_density_score: 25,
    timeline_coverage_score: 15,
    no_orphans_score: 15,
    no_dead_links_score: 0,
  };
}

describe('runRemediation idempotency-key rotation (#3626)', () => {
  test('completed/failed rows holding the content-hash key rotate to :r:<doctor_run_id>; waiting rows still dedupe', async () => {
    attemptedJobs.length = 0;
    submittedKeys.length = 0;
    seededRows.clear();
    const health = makeHealth();
    const engine = {
      kind: 'postgres',
      getHealth: async () => health,
      getConfig: async (key: string) => (key === 'sync.repo_path' ? '/brain' : null),
    } as BrainEngine;

    // Pass 1 captures the content-hash keys the plan submits.
    await runRemediation(engine, { maxJobs: 4 });
    const baseKeys = [...submittedKeys];
    expect(baseKeys).toHaveLength(3);

    // A prior doctor run left terminal rows (and one in-flight row) holding
    // those keys — the exact #3626 shape: without rotation every later
    // --remediate "runs" as an instant no-op against the old terminal rows.
    seededRows.set(baseKeys[0]!, { id: 901, status: 'completed' });
    seededRows.set(baseKeys[1]!, { id: 902, status: 'failed' });
    seededRows.set(baseKeys[2]!, { id: 903, status: 'waiting' });

    attemptedJobs.length = 0;
    submittedKeys.length = 0;
    const result = await runRemediation(engine, { maxJobs: 4 });

    // Steps 1+2 re-ran for REAL under rotated keys; step 3 deduped onto the
    // in-flight waiting row with no rotated resubmit.
    expect(attemptedJobs).toEqual(['backlinks', 'sync']);
    expect(submittedKeys).toEqual([
      baseKeys[0]!,
      `${baseKeys[0]!}:r:${result.doctor_run_id}`,
      baseKeys[1]!,
      `${baseKeys[1]!}:r:${result.doctor_run_id}`,
      baseKeys[2]!,
    ]);

    const [s1, s2, s3] = result.submitted;
    expect(s1!.deduped_job_id).toBe(901);
    expect(s1!.coalesced).toBeUndefined();
    expect(s1!.job_id).not.toBe(901);
    expect(s1!.status).toBe('completed');
    expect(s2!.deduped_job_id).toBe(902);
    expect(s2!.coalesced).toBeUndefined();
    expect(s3!.coalesced).toBe(true);
    expect(s3!.job_id).toBe(903);
    expect(s3!.deduped_job_id).toBeUndefined();

    seededRows.clear();
  });
});

describe('runRemediation recheck loop guard', () => {
  test('attempts a stable stuck remediation once and continues to later work', async () => {
    attemptedJobs.length = 0;
    submittedKeys.length = 0;
    seededRows.clear();
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
