/**
 * issue #2227/#2194 (TODOS:634, codex #8) — a per-source `autopilot-cycle`
 * binds its filesystem phases to the SOURCE's own checkout (`local_path`),
 * never the global brain's `sync.repo_path`.
 *
 * Pre-fix the handler fed `repoPath` (the global checkout) into runCycle even
 * when `source_id` was set, so FS phases (sync/lint/extract) ran against the
 * wrong tree while DB freshness was stamped for `source_id` — mixed scope.
 * That made the failure-cooldown and freshness gates attribute work to the
 * wrong source, the prerequisite codex flagged before the storm-breaker could
 * be trusted.
 *
 * Drives the REAL handler captured from registerBuiltinHandlers (not a
 * source-grep) so a reintroduced repoPath fallthrough fails here. PGLite
 * in-memory. The report's `brain_dir` mirrors the cycle's effective brainDir
 * (cycle.ts:2324), so it's the observable proxy for "which checkout did FS
 * phases bind to".
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function captureHandlers(): Promise<Map<string, (job: any) => Promise<any>>> {
  const handlers = new Map<string, (job: any) => Promise<any>>();
  const fakeWorker = { register(name: string, fn: (job: any) => Promise<any>) { handlers.set(name, fn); } };
  await registerBuiltinHandlers(fakeWorker as never, engine);
  return handlers;
}

describe('autopilot-cycle handler — per-source checkout binding (#2227/#2194)', () => {
  test('source_id with local_path → brainDir is the SOURCE checkout, not the global repo', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-src-'));
    // A DIFFERENT global checkout must NOT win for a per-source job.
    await engine.setConfig('sync.repo_path', '/some/global/brain/checkout');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('repo-a', 'Repo A', $1, '{}'::jsonb, false, now())`,
      [sourceDir],
    );

    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle')!;
    // DB-only phase keeps the test cheap; brain_dir is stamped from opts.brainDir
    // regardless of which phases run, so it still proves the binding.
    const result = await handler({
      data: { source_id: 'repo-a', phases: ['resolve_symbol_edges'] },
      signal: undefined,
    });

    expect(result.report.brain_dir).toBe(sourceDir);
    expect(result.report.brain_dir).not.toBe('/some/global/brain/checkout');
  });

  test('source_id with NULL local_path → brainDir is null (FS phases skip), never the global repo', async () => {
    // The mixed-scope bug: a pure-DB source must NOT fall through to repoPath.
    await engine.setConfig('sync.repo_path', '/some/global/brain/checkout');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('db-only', 'DB Only', NULL, '{}'::jsonb, false, now())`,
      [],
    );

    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle')!;
    const result = await handler({
      data: { source_id: 'db-only', phases: ['resolve_symbol_edges'] },
      signal: undefined,
    });

    expect(result.report.brain_dir).toBeNull();
    expect(result.report.brain_dir).not.toBe('/some/global/brain/checkout');
  });

  test('legacy (no source_id) keeps the global repoPath — back-compat', async () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'gbrain-global-'));
    await engine.setConfig('sync.repo_path', globalDir);

    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle')!;
    const result = await handler({
      data: { phases: ['resolve_symbol_edges'] },
      signal: undefined,
    });

    expect(result.report.brain_dir).toBe(globalDir);
  });
});
