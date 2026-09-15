import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeRecommendations } from '../src/core/brain-score-recommendations.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
const repoPath = mkdtempSync(join(tmpdir(), 'stale-recommendation-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('repo-a', 'repo-a'), ('repo-b', 'repo-b')");
}, 60_000);

afterAll(async () => {
  await engine?.disconnect();
  rmSync(repoPath, { recursive: true, force: true });
});

describe('DB extraction recommendations (#5112)', () => {
  test('the recommended handler stamps DB-only pages in the selected source and converges', async () => {
    for (const sourceId of ['repo-a', 'repo-b']) {
      for (const slug of ['atoms/example', 'extracts/example', 'notes/example']) {
        await engine.putPage(slug, { title: slug, type: 'note', compiled_truth: 'A synthetic note.', timeline: '' }, { sourceId });
      }
    }
    const context = { sourceId: 'repo-a', repoPath, embeddingProviderConfigured: false };
    const before = await engine.getHealth({ sourceId: 'repo-a' });
    expect(before.stale_pages).toBe(3);
    const recommendations = computeRecommendations(before, context);
    expect(recommendations.map(r => r.id)).toEqual(['extract.stale']);
    const recommendation = recommendations[0];
    expect(recommendation.params).toEqual({ stale: true, sourceId: 'repo-a' });
    expect(recommendation.depends_on).toEqual([]);
    expect(computeRecommendations(before, { ...context, repoPath: undefined }).map(r => r.id)).toEqual(['extract.stale']);

    const handlers = new Map<string, (job: MinionJobContext) => Promise<unknown>>();
    await registerBuiltinHandlers({ register: (name: string, handler: (job: MinionJobContext) => Promise<unknown>) => handlers.set(name, handler) } as never, engine);
    await handlers.get(recommendation.job)!({ id: 1, data: recommendation.params } as MinionJobContext);
    const after = await engine.getHealth({ sourceId: 'repo-a' });
    expect(after.stale_pages).toBe(0);
    expect(computeRecommendations(after, context)).toEqual([]);
    expect((await engine.getHealth({ sourceId: 'repo-b' })).stale_pages).toBe(3);
  }, 60_000);
});
