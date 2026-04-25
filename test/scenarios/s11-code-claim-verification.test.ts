/**
 * Scenario S11 — Code claim verification gates staleness.
 *
 * Falsifies L4: "Reconfirm file paths, symbols, tests, and branch-sensitive
 * claims before repeating them. If verification fails, drop the claim's
 * authority for the current answer while preserving the historical
 * operational record."
 *
 * The scenario verifies that historical code claims remain preserved as trace
 * evidence, but must be rechecked against the current repo and branch before
 * they can influence task resume output.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { buildTaskResumeCard } from '../../src/core/services/task-memory-service.ts';

describe('S11 — code claim verification gates staleness', () => {
  test('reverify_code_claims marks stale file/symbol claims from a prior trace without deleting the historical record', async () => {
    await withScenarioBrain(async ({ engine, repoPath }) => {
      await seedTaskWithCodeClaimTrace(engine, {
        repoPath,
        branchName: 'main',
        verification: ['code_claim:src/missing.ts:MissingSymbol'],
      });

      const op = operationsByName.reverify_code_claims;
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

      expect(report.results[0]?.status).toBe('stale');
      expect(report.results[0]?.reason).toBe('file_missing');
      expect(report.written_trace?.route).toEqual(['code_claim_reverification']);
      expect(report.written_trace?.source_refs).toEqual(['retrieval_trace:trace-code-claim-source']);

      const originalTrace = await engine.getRetrievalTrace('trace-code-claim-source');
      expect(originalTrace?.verification).toEqual(['code_claim:src/missing.ts:MissingSymbol']);
    });
  });

  test('resume on branch B explicitly reports code-claim freshness when the trace originated on branch A', async () => {
    await withScenarioBrain(async ({ engine, repoPath }) => {
      mkdirSync(join(repoPath, 'src'), { recursive: true });
      writeFileSync(join(repoPath, 'src/example.ts'), 'export function presentSymbol() { return true; }\n');

      await seedTaskWithCodeClaimTrace(engine, {
        repoPath,
        branchName: 'branch-b',
        verification: ['code_claim:src/example.ts:presentSymbol:branch=branch-a'],
      });

      const resume = await buildTaskResumeCard(engine, 'task-code-claims');

      expect(resume.code_claim_verification[0]?.status).toBe('stale');
      expect(resume.code_claim_verification[0]?.reason).toBe('branch_mismatch');
      expect(resume.code_claim_verification[0]?.claim.source_trace_id).toBe('trace-code-claim-source');
      expect(resume.latest_trace_route).toEqual(['task_resume']);
    });
  });

  test('resume does not repeat stale working-set code paths as present-tense facts', async () => {
    await withScenarioBrain(async ({ engine, repoPath }) => {
      mkdirSync(join(repoPath, 'src'), { recursive: true });
      writeFileSync(join(repoPath, 'src/current.ts'), 'export function currentSymbol() { return true; }\n');

      await seedTaskWithCodeClaimTrace(engine, {
        repoPath,
        branchName: 'main',
        currentSummary: 'Use src/current.ts and remove obsolete src/missing.ts.',
        activePaths: ['src/current.ts', 'src/missing.ts'],
        activeSymbols: ['currentSymbol', 'missingSymbol'],
        verification: ['code_claim:src/current.ts:currentSymbol'],
      });

      const resume = await buildTaskResumeCard(engine, 'task-code-claims');

      expect(resume.active_paths).toEqual(['src/current.ts']);
      expect(resume.active_symbols).toEqual(['currentSymbol']);
      expect(resume.current_summary).not.toContain('src/missing.ts');
      expect(resume.code_claim_verification).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: 'stale',
          reason: 'file_missing',
          claim: expect.objectContaining({ path: 'src/missing.ts' }),
        }),
        expect.objectContaining({
          status: 'stale',
          reason: 'symbol_missing',
          claim: expect.objectContaining({ path: 'src/current.ts', symbol: 'missingSymbol' }),
        }),
      ]));
    });
  });
});

async function withScenarioBrain(
  run: (input: { engine: SQLiteEngine; repoPath: string }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-s11-code-claims-'));
  const databasePath = join(dir, 'brain.db');
  const repoPath = join(dir, 'repo');
  const engine = new SQLiteEngine();

  try {
    mkdirSync(repoPath, { recursive: true });
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await run({ engine, repoPath });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function seedTaskWithCodeClaimTrace(
  engine: SQLiteEngine,
  input: {
    repoPath: string;
    branchName: string;
    verification: string[];
    currentSummary?: string;
    activePaths?: string[];
    activeSymbols?: string[];
  },
): Promise<void> {
  await engine.createTaskThread({
    id: 'task-code-claims',
    scope: 'work',
    title: 'Verify code claims',
    goal: 'Do not reuse stale code facts',
    status: 'active',
    repo_path: input.repoPath,
    branch_name: input.branchName,
    current_summary: input.currentSummary ?? 'Trace contains historical code claim',
  });
  if (input.activePaths || input.activeSymbols) {
    await engine.upsertTaskWorkingSet({
      task_id: 'task-code-claims',
      active_paths: input.activePaths ?? [],
      active_symbols: input.activeSymbols ?? [],
      blockers: [],
      open_questions: [],
      next_steps: [],
      verification_notes: [],
      last_verified_at: new Date('2026-04-25T00:00:00.000Z'),
    });
  }
  await engine.putRetrievalTrace({
    id: 'trace-code-claim-source',
    task_id: 'task-code-claims',
    scope: 'work',
    route: ['task_resume'],
    source_refs: ['task-thread:task-code-claims'],
    verification: input.verification,
    outcome: 'historical answer referenced code',
  });
}
