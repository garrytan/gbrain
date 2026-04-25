import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { operationsByName } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('reverify_code_claims operation is registered with CLI hints', () => {
  const op = operationsByName.reverify_code_claims;

  expect(op).toBeDefined();
  expect(op?.cliHints?.name).toBe('reverify-code-claims');
  expect(op?.mutating).toBe(true);
});

test('reverify_code_claims verifies direct claims without writing a trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-op-direct-'));
  const databasePath = join(dir, 'brain.db');
  const repoPath = join(dir, 'repo');
  const engine = new SQLiteEngine();
  const op = operationsByName.reverify_code_claims;

  if (!op) throw new Error('reverify_code_claims operation is missing');

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const report = await op.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      repo_path: repoPath,
      branch_name: 'main',
      claims: [{ path: 'src/example.ts', symbol: 'presentSymbol', branch_name: 'main' }],
    }) as any;

    expect(report.results[0]?.status).toBe('current');
    expect(report.results[0]?.reason).toBe('ok');
    expect(report.written_trace).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reverify_code_claims extracts trace code claims and writes an operational stale marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-op-trace-'));
  const databasePath = join(dir, 'brain.db');
  const repoPath = join(dir, 'repo');
  const engine = new SQLiteEngine();
  const op = operationsByName.reverify_code_claims;

  if (!op) throw new Error('reverify_code_claims operation is missing');

  try {
    mkdirSync(repoPath, { recursive: true });
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.createTaskThread({
      id: 'task-code-claims',
      scope: 'work',
      title: 'Verify code claims',
      goal: 'Do not reuse stale code facts',
      status: 'active',
      repo_path: repoPath,
      branch_name: 'main',
      current_summary: 'Trace contains historical code claim',
    });
    await engine.putRetrievalTrace({
      id: 'trace-code-claim-source',
      task_id: 'task-code-claims',
      scope: 'work',
      route: ['task_resume'],
      source_refs: ['task-thread:task-code-claims'],
      verification: ['code_claim:src/missing.ts:MissingSymbol'],
      outcome: 'historical answer referenced a missing file',
    });

    const report = await op.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      repo_path: repoPath,
      branch_name: 'main',
      trace_id: 'trace-code-claim-source',
    }) as any;

    expect(report.trace_id).toBe('trace-code-claim-source');
    expect(report.results[0]?.status).toBe('stale');
    expect(report.results[0]?.reason).toBe('file_missing');
    expect(report.written_trace?.route).toEqual(['code_claim_reverification']);
    expect(report.written_trace?.source_refs).toEqual(['retrieval_trace:trace-code-claim-source']);
    expect(report.written_trace?.write_outcome).toBe('operational_write');

    const originalTrace = await engine.getRetrievalTrace('trace-code-claim-source');
    expect(originalTrace?.verification).toEqual(['code_claim:src/missing.ts:MissingSymbol']);

    const traces = await engine.listRetrievalTraces('task-code-claims', { limit: 2 });
    expect(traces.map((trace) => trace.id)).toContain('trace-code-claim-source');
    expect(traces.some((trace) => trace.route.includes('code_claim_reverification'))).toBe(true);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reverify_code_claims writes an operational marker for trace-backed unverifiable claims', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-op-trace-unverifiable-'));
  const databasePath = join(dir, 'brain.db');
  const repoPath = join(dir, 'repo');
  const engine = new SQLiteEngine();
  const op = operationsByName.reverify_code_claims;

  if (!op) throw new Error('reverify_code_claims operation is missing');

  try {
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    await engine.createTaskThread({
      id: 'task-code-claims',
      scope: 'work',
      title: 'Verify branch-sensitive code claims',
      goal: 'Do not reuse unverifiable branch facts',
      status: 'active',
      repo_path: repoPath,
      branch_name: null,
      current_summary: 'Trace contains branch-sensitive code claim',
    });
    await engine.putRetrievalTrace({
      id: 'trace-code-claim-source',
      task_id: 'task-code-claims',
      scope: 'work',
      route: ['task_resume'],
      source_refs: ['task-thread:task-code-claims'],
      verification: ['code_claim:src/example.ts:presentSymbol:branch=branch-a'],
      outcome: 'historical answer referenced a branch-specific symbol',
    });

    const report = await op.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      repo_path: repoPath,
      trace_id: 'trace-code-claim-source',
    }) as any;

    expect(report.trace_id).toBe('trace-code-claim-source');
    expect(report.results[0]?.status).toBe('unverifiable');
    expect(report.results[0]?.reason).toBe('branch_unknown');
    expect(report.written_trace?.route).toEqual(['code_claim_reverification']);
    expect(report.written_trace?.source_refs).toEqual(['retrieval_trace:trace-code-claim-source']);
    expect(report.written_trace?.write_outcome).toBe('operational_write');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reverify_code_claims reports pathless symbol claims as unverifiable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-op-symbol-only-'));
  const databasePath = join(dir, 'brain.db');
  const repoPath = join(dir, 'repo');
  const engine = new SQLiteEngine();
  const op = operationsByName.reverify_code_claims;

  if (!op) throw new Error('reverify_code_claims operation is missing');

  try {
    mkdirSync(repoPath, { recursive: true });
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const report = await op.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      repo_path: repoPath,
      claims: [{ symbol: 'MissingSymbol' }],
    }) as any;

    expect(report.results).toEqual([
      expect.objectContaining({
        status: 'unverifiable',
        reason: 'symbol_path_missing',
        claim: { symbol: 'MissingSymbol' },
      }),
    ]);
    expect(report.written_trace).toBeNull();
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reverify_code_claims rejects direct claims combined with trace provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-code-claim-op-mixed-input-'));
  const databasePath = join(dir, 'brain.db');
  const repoPath = join(dir, 'repo');
  const engine = new SQLiteEngine();
  const op = operationsByName.reverify_code_claims;

  if (!op) throw new Error('reverify_code_claims operation is missing');

  try {
    mkdirSync(repoPath, { recursive: true });
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await engine.putRetrievalTrace({
      id: 'trace-code-claim-source',
      task_id: null,
      scope: 'work',
      route: ['task_resume'],
      verification: ['code_claim:src/missing.ts:MissingSymbol'],
      outcome: 'historical answer referenced a missing file',
    });

    await expect(op.handler({
      engine,
      config: {} as any,
      logger: console,
      dryRun: false,
    }, {
      repo_path: repoPath,
      trace_id: 'trace-code-claim-source',
      claims: [{ path: 'src/unrelated.ts' }],
    })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reverify_code_claims rejects missing or non-string repo_path', async () => {
  const engine = new SQLiteEngine();
  const op = operationsByName.reverify_code_claims;

  if (!op) throw new Error('reverify_code_claims operation is missing');

  await expect(op.handler({
    engine,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    claims: [{ path: 'src/example.ts' }],
  })).rejects.toMatchObject({
    code: 'invalid_params',
  });

  await expect(op.handler({
    engine,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    repo_path: 42,
    claims: [{ path: 'src/example.ts' }],
  })).rejects.toMatchObject({
    code: 'invalid_params',
  });
});
