import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runEval } from '../src/commands/eval.ts';

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    rmSync(tempPaths.pop()!, { recursive: true, force: true });
  }
});

describe('eval CLI runner', () => {
  test('persists a context fixture run and assertion summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-cli-'));
    tempPaths.push(dir);
    const fixturePath = join(dir, 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify({
      id: 'context-fixture',
      mode: 'injected_candidates',
      cases: [
        { id: 'case-pass', passed: true, expected: { selector: 'a' }, actual: { selector: 'a' } },
        { id: 'case-fail', passed: false, expected: { selector: 'b' }, actual: { selector: null } },
      ],
    }));
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => { logs.push(String(line)); };
    try {
      await runEval(fakeEvalEngine(), ['context', '--fixture', fixturePath, '--json']);
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(logs.join('\n'));
    expect(output.run.fixture_id).toBe('context-fixture');
    expect(output.run.status).toBe('failed');
    expect(output.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(output.assertions).toHaveLength(2);
  });
});

function fakeEvalEngine(): any {
  return {
    async putContextEvalRun(input: any) {
      return {
        id: input.id ?? 'run-1',
        ...input,
        started_at: input.started_at ?? new Date(),
        completed_at: input.completed_at ?? null,
        created_at: new Date(),
        updated_at: new Date(),
      };
    },
    async putContextEvalAssertion(input: any) {
      return {
        id: input.id ?? `assertion-${input.case_id}`,
        ...input,
        score: input.score ?? null,
        expected: input.expected ?? null,
        actual: input.actual ?? null,
        message: input.message ?? null,
        retrieval_trace_id: input.retrieval_trace_id ?? null,
        metadata: input.metadata ?? {},
        created_at: new Date(),
      };
    },
  };
}
