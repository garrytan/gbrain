import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runGbrainIngestSmoke } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM ingest_log');
  await engine.executeRaw('DELETE FROM pages');
});

describe('gbrain jobs smoke --gbrain-ingest', () => {
  test('returns job id, status command, terminal result, and enrichment status', async () => {
    const prior = process.env.GBRAIN_INGEST_ENRICH;
    process.env.GBRAIN_INGEST_ENRICH = '0';
    try {
      const result = await runGbrainIngestSmoke(engine, { timeoutMs: 5_000, pollIntervalMs: 50 });

      expect(result.job_id).toBeGreaterThan(0);
      expect(result.status_command).toBe(`gbrain jobs get ${result.job_id}`);
      expect(result.terminal_status).toBe('completed');
      expect(result.enrichment_status).toBe('skipped');
      expect(result.timed_out).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.GBRAIN_INGEST_ENRICH;
      else process.env.GBRAIN_INGEST_ENRICH = prior;
    }
  });
});
