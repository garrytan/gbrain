import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runEval } from '../src/commands/eval.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

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

  test('real CLI preserves eval fixture flags through direct command dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-cli-real-'));
    tempPaths.push(dir);
    const dbPath = join(dir, 'brain.db');
    const configPath = join(dir, 'config.json');
    const fixturePath = join(dir, 'fixture.json');
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: dbPath });
    await engine.initSchema();
    await engine.disconnect();
    writeFileSync(configPath, JSON.stringify({ engine: 'sqlite', database_path: dbPath }));
    writeFileSync(fixturePath, JSON.stringify({
      id: 'real-cli-context-fixture',
      mode: 'injected_candidates',
      cases: [
        { id: 'case-pass', expected: { selector: 'a' }, actual: { selector: 'a' } },
      ],
    }));

    const output = execFileSync('bun', ['src/cli.ts', 'eval', 'context', '--fixture', fixturePath, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, MBRAIN_CONFIG_PATH: configPath },
    });
    const parsed = JSON.parse(output);

    expect(parsed.run.fixture_id).toBe('real-cli-context-fixture');
    expect(parsed.run.status).toBe('passed');
    expect(parsed.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
  });

  test('compares base and head eval reports without consuming --compare as a value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-compare-'));
    tempPaths.push(dir);
    const basePath = join(dir, 'base.json');
    const headPath = join(dir, 'head.json');
    writeFileSync(basePath, JSON.stringify({ metrics: { total: 2, passed: 1, failed: 1, pass_rate: 0.5 } }));
    writeFileSync(headPath, JSON.stringify({ metrics: { total: 2, passed: 2, failed: 0, pass_rate: 1 } }));
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => { logs.push(String(line)); };
    try {
      await runEval(fakeEvalEngine(), ['context', '--compare', basePath, headPath, '--json']);
    } finally {
      console.log = originalLog;
    }

    const output = JSON.parse(logs.join('\n'));
    expect(output.delta).toMatchObject({ total: 0, passed: 1, failed: -1, pass_rate: 0.5 });
  });

  test('does not default missing fixture outcomes to pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-missing-outcome-'));
    tempPaths.push(dir);
    const fixturePath = join(dir, 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify({
      id: 'missing-outcome',
      mode: 'injected_candidates',
      cases: [{ id: 'case-missing' }],
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
    expect(output.run.status).toBe('failed');
    expect(output.summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
  });

  test('live_retrieve fixtures run retrieve_context and read_context with linked traces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-eval-live-'));
    tempPaths.push(dir);
    const fixturePath = join(dir, 'fixture.json');
    const dbPath = join(dir, 'brain.db');
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: dbPath });
    await engine.initSchema();
    try {
      await importFromContent(engine, 'concepts/live-eval', [
        '---',
        'type: concept',
        'title: Live Eval',
        '---',
        '# Compiled Truth',
        'Live eval canonical evidence.',
        '[Source: User, direct message, 2026-06-29 12:00 KST]',
      ].join('\n'), { path: 'concepts/live-eval.md' });
      writeFileSync(fixturePath, JSON.stringify({
        id: 'live-context-fixture',
        mode: 'live_retrieve',
        cases: [{
          id: 'live-case',
          query: 'live eval',
          selectors: [{ kind: 'compiled_truth', slug: 'concepts/live-eval' }],
          expected: {
            answer_ready: true,
            authority_class: 'canonical_read',
            read_selector_ids: ['compiled_truth:workspace:default:concepts/live-eval'],
          },
        }],
      }));
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (line?: unknown) => { logs.push(String(line)); };
      try {
        await runEval(engine, ['context', '--fixture', fixturePath, '--json']);
      } finally {
        console.log = originalLog;
      }

      const output = JSON.parse(logs.join('\n'));
      expect(output.run.status).toBe('passed');
      expect(typeof output.assertions[0].retrieval_trace_id).toBe('string');
      expect(output.assertions[0].actual.trace_ids).toHaveLength(2);
    } finally {
      await engine.disconnect();
    }
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
