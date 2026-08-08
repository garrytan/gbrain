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
import { NON_DEFAULT_FANOUT_PHASES } from '../src/commands/autopilot-fanout.ts';
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
    // A cheap allowed phase keeps the test focused; brain_dir is stamped from opts.brainDir
    // regardless of which phases run, so it still proves the binding.
    const result = await handler({
      data: { source_id: 'repo-a', phases: ['lint'] },
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
      // Even a replayed/spoofed fallback flag is ignored for non-default.
      data: {
        source_id: 'db-only',
        use_default_repo_path: true,
        phases: ['lint'],
      },
      signal: undefined,
    });

    expect(result.report.brain_dir).toBeNull();
    expect(result.report.brain_dir).not.toBe('/some/global/brain/checkout');
  });

  test('default source with NULL local_path uses only configured legacy global repo', async () => {
    const globalDir = mkdtempSync(join(tmpdir(), 'gbrain-default-global-'));
    const spoofedPayloadDir = mkdtempSync(join(tmpdir(), 'gbrain-default-spoof-'));
    await engine.setConfig('sync.repo_path', globalDir);
    await engine.executeRaw(
      `UPDATE sources SET local_path = NULL WHERE id = 'default'`,
    );

    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle')!;
    const result = await handler({
      data: {
        source_id: 'default',
        // Claim-time fallback must ignore this queue-controlled path and read
        // sync.repo_path from the engine config plane.
        repoPath: spoofedPayloadDir,
        phases: ['lint'],
      },
      signal: undefined,
    });

    expect(result.report.brain_dir).toBe(globalDir);
    expect(result.report.brain_dir).not.toBe(spoofedPayloadDir);
  });

  test('non-default replay with only unsafe phases is rejected before runCycle', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-replay-source-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('replay-src', 'Replay', $1, '{}'::jsonb, false, now())`,
      [sourceDir],
    );

    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle')!;
    const result = await handler({
      data: {
        source_id: 'replay-src',
        phases: ['consolidate', 'conversation_facts_backfill'],
      },
      signal: undefined,
    });

    expect(result.status).toBe('skipped');
    expect(result.report.reason).toBe('no_allowed_phases');
    expect(result.report.source_id).toBe('replay-src');
  });

  test('source replay with an explicit empty phase list skips instead of defaulting to ALL_PHASES', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-empty-source-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('empty-src', 'Empty', $1, '{}'::jsonb, false, now())`,
      [sourceDir],
    );

    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle')!;
    const result = await handler({
      data: { source_id: 'empty-src', phases: [] },
      signal: undefined,
    });

    expect(result.status).toBe('skipped');
    expect(result.report).toEqual({
      reason: 'no_allowed_phases',
      source_id: 'empty-src',
    });
  });

  test('source replay with only invalid phase names skips instead of defaulting to ALL_PHASES', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-invalid-source-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('invalid-src', 'Invalid', $1, '{}'::jsonb, false, now())`,
      [sourceDir],
    );

    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle')!;
    const result = await handler({
      data: { source_id: 'invalid-src', phases: ['NOT_A_PHASE'] },
      signal: undefined,
    });

    expect(result.status).toBe('skipped');
    expect(result.report.reason).toBe('no_allowed_phases');
    expect(result.report.source_id).toBe('invalid-src');
  });

  test('source replay with omitted phases defaults only to the audited allowlist', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('missing-phases-src', 'Missing phases', NULL, '{}'::jsonb, false, now())`,
      [],
    );

    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle')!;
    const result = await handler({
      data: { source_id: 'missing-phases-src' },
      signal: undefined,
    });

    expect(result.report.phases.map((phase: { phase: string }) => phase.phase))
      .toEqual(NON_DEFAULT_FANOUT_PHASES);
  });

  test('source replay with a non-array phases payload is rejected', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-malformed-source-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('malformed-src', 'Malformed', $1, '{}'::jsonb, false, now())`,
      [sourceDir],
    );

    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle')!;
    const result = await handler({
      data: { source_id: 'malformed-src', phases: 'lint' },
      signal: undefined,
    });

    expect(result.status).toBe('skipped');
    expect(result.report.reason).toBe('no_allowed_phases');
    expect(result.report.source_id).toBe('malformed-src');
  });

  test('non-default replay clamps mixed safe+unsafe payload to the audited allowlist', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-clamp-source-'));
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived, created_at)
       VALUES ('clamp-src', 'Clamp', $1, '{}'::jsonb, false, now())`,
      [sourceDir],
    );

    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle')!;
    const result = await handler({
      data: {
        source_id: 'clamp-src',
        phases: ['lint', 'consolidate', 'schema-suggest'],
      },
      signal: undefined,
    });

    expect(result.report.phases.map((phase: { phase: string }) => phase.phase)).toEqual(['lint']);
  });

  test('default replay rejects global phases while retaining allowed non-global work', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-default-clamp-'));
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
      [sourceDir],
    );

    const handlers = await captureHandlers();
    const handler = handlers.get('autopilot-cycle')!;
    const result = await handler({
      data: {
        source_id: 'default',
        phases: ['lint', 'resolve_symbol_edges'],
      },
      signal: undefined,
    });

    expect(result.report.phases.map((phase: { phase: string }) => phase.phase)).toEqual(['lint']);
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
