import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    rmSync(tempPaths.pop()!, { recursive: true, force: true });
  }
});

describe('context eval ledger engines', () => {
  for (const createEngine of [createSqliteEngine, createPgliteEngine]) {
    test(`${createEngine.name} persists eval runs, assertions, and trace-linked corrections`, async () => {
      const engine = await createEngine();
      try {
        const trace = await engine.putRetrievalTrace({
          id: `trace-${createEngine.name}`,
          task_id: null,
          scope: 'work',
          route: ['retrieve_context', 'read_context'],
          source_refs: ['fixture:source'],
          derived_consulted: [],
          verification: ['fixture:verification'],
          write_outcome: 'no_durable_write',
          selected_intent: 'precision_lookup',
          scope_gate_policy: 'allow',
          scope_gate_reason: 'fixture',
          outcome: 'fixture trace',
        });

        const run = await engine.putContextEvalRun({
          id: `run-${createEngine.name}`,
          fixture_id: 'self-service-context-fixture',
          fixture_mode: 'injected_candidates',
          status: 'failed',
          model_id: 'gpt-test',
          skill_surface_hash: 'hash-surface',
          agent_rules_version: '0.5.12',
          git_sha: 'abc123',
          retrieval_trace_ids: [trace.id],
          metrics: { total: 2, passed: 1, failed: 1, pass_rate: 0.5 },
          metadata: { fixture_path: 'fixture.json' },
          completed_at: new Date('2026-06-29T00:00:00.000Z'),
        });
        expect(run.metrics).toMatchObject({ total: 2, failed: 1 });
        expect(run.retrieval_trace_ids).toEqual([trace.id]);

        const assertion = await engine.putContextEvalAssertion({
          id: `assertion-${createEngine.name}`,
          run_id: run.id,
          case_id: 'case-1',
          assertion_kind: 'required_read_selected',
          passed: false,
          score: 0,
          expected: { selector: 'systems/mbrain' },
          actual: { selector: null },
          message: 'selector was missed',
          retrieval_trace_id: trace.id,
          metadata: { severity: 'high' },
        });
        expect(assertion.passed).toBe(false);
        expect(assertion.expected).toEqual({ selector: 'systems/mbrain' });

        const correction = await engine.createContextEvalCorrection({
          id: `correction-${createEngine.name}`,
          trace_id: trace.id,
          run_id: run.id,
          case_id: assertion.case_id,
          reason: 'Trace missed the canonical system selector.',
          proposed_assertion_id: assertion.id,
          metadata: { source: 'test' },
        });
        expect(correction).toMatchObject({
          trace_id: trace.id,
          run_id: run.id,
          case_id: 'case-1',
          proposed_assertion_id: assertion.id,
        });

        expect(await engine.getContextEvalRun(run.id)).toMatchObject({ id: run.id });
        expect(await engine.listContextEvalRuns({ fixture_id: 'self-service-context-fixture' })).toHaveLength(1);
        expect(await engine.listContextEvalAssertions({ run_id: run.id, passed: false })).toHaveLength(1);
      } finally {
        await engine.disconnect();
      }
    });
  }
});

async function createSqliteEngine(): Promise<BrainEngine> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-eval-sqlite-'));
  tempPaths.push(dir);
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  return engine;
}

async function createPgliteEngine(): Promise<BrainEngine> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-context-eval-pglite-'));
  tempPaths.push(dir);
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dir });
  await engine.initSchema();
  return engine;
}
