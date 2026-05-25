/**
 * v0.38 autopilot-cycle handler — source_id validation + archive recheck.
 *
 * Covers the codex r1 P1-5 finding: archived-source recheck must happen
 * before lock acquisition (handler entry, not deep in runPhaseSync).
 * Also covers codex r2 P1-B (source_id validation at primitive layer).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' }); // in-memory
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Targeted DELETE preserves the `config.version` key that
  // MinionQueue.ensureSchema requires (full resetPgliteState wipes it).
  // Same pattern as test/minions.test.ts.
  await engine.executeRaw('DELETE FROM minion_jobs').catch(() => {});
  await engine.executeRaw('DELETE FROM gbrain_cycle_locks').catch(() => {});
  await engine.executeRaw(`DELETE FROM sources WHERE id <> 'default'`).catch(() => {});
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-handler-'));
});

async function seedSource(id: string, opts: { archived?: boolean } = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, NOW())
     ON CONFLICT (id) DO UPDATE SET archived = EXCLUDED.archived`,
    [id, id, brainDir, opts.archived === true],
  );
}

/**
 * Invoke the autopilot-cycle handler directly by reaching into the worker's
 * handler registry. Bypasses the queue lifecycle entirely — we're testing
 * the handler's logic (source_id validation + archive recheck + pull
 * threading), not queue mechanics.
 */
async function runHandlerOnce(jobData: Record<string, unknown>): Promise<{ partial: boolean; status: string; report: any }> {
  const worker = new MinionWorker(engine, { concurrency: 1 });
  await registerBuiltinHandlers(worker, engine);
  const handler = (worker as unknown as { handlers: Map<string, (j: any) => Promise<any>> }).handlers.get('autopilot-cycle');
  if (!handler) throw new Error('autopilot-cycle handler not registered');
  return handler({
    id: 1,
    name: 'autopilot-cycle',
    data: jobData,
    signal: new AbortController().signal,
  }) as Promise<{ partial: boolean; status: string; report: any }>;
}

describe('autopilot-cycle handler source_id validation + archive recheck', () => {
  test('missing source_id (legacy caller) runs cycle normally', async () => {
    const result = await runHandlerOnce({ repoPath: brainDir, phases: ['lint'] });
    // status is whatever runCycle decided; just ensure handler didn't reject
    expect(['ok', 'clean', 'partial', 'failed', 'skipped']).toContain(result.status);
  });

  test('valid source_id + existing source runs cycle', async () => {
    await seedSource('alpha');
    const result = await runHandlerOnce({ repoPath: brainDir, source_id: 'alpha', phases: ['lint'] });
    expect(['ok', 'clean']).toContain(result.status);
  });

  test('source_id pointing at non-existent source returns skipped', async () => {
    const result = await runHandlerOnce({ repoPath: brainDir, source_id: 'no-such-source', phases: ['lint'] });
    expect(result.status).toBe('skipped');
    expect(result.report.reason).toBe('source_not_found');
  });

  test('source_id pointing at archived source returns skipped (codex P1-5)', async () => {
    await seedSource('archived-src', { archived: true });
    const result = await runHandlerOnce({ repoPath: brainDir, source_id: 'archived-src', phases: ['lint'] });
    expect(result.status).toBe('skipped');
    expect(result.report.reason).toBe('source_archived');
  });

  test('malformed source_id (regex fail) throws (codex P1-B)', async () => {
    await expect(
      runHandlerOnce({ repoPath: brainDir, source_id: 'BAD ID', phases: ['lint'] }),
    ).rejects.toThrow(/invalid source_id/);
  });

  test('non-string source_id throws', async () => {
    await expect(
      runHandlerOnce({ repoPath: brainDir, source_id: 42, phases: ['lint'] }),
    ).rejects.toThrow(/not a string/);
  });

  test('explicit pull: false overrides default pull: true', async () => {
    // Behavior check via lack-of-throw + return shape — no actual pull
    // is invoked because the phase set is just ['lint'].
    await seedSource('echo');
    const result = await runHandlerOnce({ repoPath: brainDir, source_id: 'echo', pull: false, phases: ['lint'] });
    expect(['ok', 'clean']).toContain(result.status);
  });
});
