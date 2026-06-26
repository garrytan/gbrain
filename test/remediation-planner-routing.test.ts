import { describe, expect, test } from 'bun:test';

describe('remediation planner routing contracts', () => {
  test('planner context reads real sync and extraction freshness owners', async () => {
    const source = await Bun.file(new URL('../src/core/remediation/context.ts', import.meta.url)).text();

    expect(source).toContain('isSourceUnchangedSinceSync');
    expect(source).toContain('countStalePagesForExtraction');
    expect(source).toContain('LINK_EXTRACTOR_VERSION_TS');
  });

  test('empty runnable plan keeps max reachable score at current score', async () => {
    const source = await Bun.file(new URL('../src/core/remediation/plan.ts', import.meta.url)).text();

    expect(source).toContain('maxReachableScoreFromRecommendations(health, filteredRecs)');
    expect(source).not.toContain('maxReachableScore(health, classifications)');
  });

  test('extract jobs route stale work through DB-backed stale extraction', async () => {
    const source = await Bun.file(new URL('../src/commands/jobs.ts', import.meta.url)).text();
    const handlerStart = source.indexOf("worker.register('extract'");
    const handlerEnd = source.indexOf("worker.register('backlinks'", handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    const staleBranch = handler.indexOf('job.data.stale === true');
    const filesystemImport = handler.indexOf('runExtractCore');

    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(staleBranch).toBeGreaterThan(-1);
    expect(filesystemImport).toBeGreaterThan(-1);
    expect(staleBranch).toBeLessThan(filesystemImport);
    expect(handler).toContain('runExtractStaleCore');
    expect(handler).toContain('sourceIdFilter');
  });
});
