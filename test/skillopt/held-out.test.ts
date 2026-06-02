/**
 * SkillOpt held-out test set scaffold tests (F11).
 *
 * Covers: load/parse, capture infra opt-in, gate math (candidate vs baseline).
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withEnv } from '../helpers/with-env.ts';
import {
  appendCapture,
  capturePath,
  capturesDir,
  loadHeldOut,
  runHeldOutGate,
} from '../../src/core/skillopt/held-out.ts';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-heldout-'));
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('F11 held-out path helpers', () => {
  test('capturesDir honors GBRAIN_HOME', async () => {
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      const dir = capturesDir();
      expect(dir).toBe(path.join(tmp, '.gbrain', 'skillopt-captures'));
    });
  });

  test('capturePath returns per-skill-per-run JSONL path', async () => {
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      const p = capturePath('my-skill', 'run-123');
      expect(p).toBe(path.join(tmp, '.gbrain', 'skillopt-captures', 'my-skill', 'run-123.jsonl'));
    });
  });
});

describe('F11 appendCapture', () => {
  test('writes a JSONL row + mkdir as needed', async () => {
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      appendCapture('test-skill', 'run-1', {
        ts: new Date().toISOString(),
        skill_name: 'test-skill',
        task: 'do X',
        final_text: 'Y',
        tool_calls: [{ name: 'search' }],
      });
      const p = capturePath('test-skill', 'run-1');
      expect(fs.existsSync(p)).toBe(true);
      const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const row = JSON.parse(lines[0]!);
      expect(row.skill_name).toBe('test-skill');
    });
  });

  test('two appends produce two lines', async () => {
    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      appendCapture('test-skill', 'run-1', {
        ts: '2026-05-27T12:00:00Z', skill_name: 'test-skill', task: 'a', final_text: 'A', tool_calls: [],
      });
      appendCapture('test-skill', 'run-1', {
        ts: '2026-05-27T12:01:00Z', skill_name: 'test-skill', task: 'b', final_text: 'B', tool_calls: [],
      });
      const p = capturePath('test-skill', 'run-1');
      expect(fs.readFileSync(p, 'utf8').trim().split('\n')).toHaveLength(2);
    });
  });
});

describe('F11 loadHeldOut', () => {
  test('parses JSONL using benchmark loader contract', () => {
    const p = path.join(tmp, 'held.jsonl');
    fs.writeFileSync(p,
      JSON.stringify({ task_id: 'h1', task: 'do x', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'x' }] } }) + '\n' +
      JSON.stringify({ task_id: 'h2', task: 'do y', judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'y' }] } }) + '\n'
    );
    const tasks = loadHeldOut(p);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.task_id).toBe('h1');
  });

  test('throws on missing file', () => {
    expect(() => loadHeldOut(path.join(tmp, 'nope.jsonl'))).toThrow();
  });
});

describe('F11 runHeldOutGate vacuous case', () => {
  test('empty held-out tasks passes vacuously with warn', async () => {
    // We don't need a real engine for the empty-case branch.
    const result = await runHeldOutGate({
      engine: {} as never,
      candidateSkillText: 'x',
      baselineSkillText: 'x',
      heldOutTasks: [],
      targetModel: 'm',
      judgeModel: 'm',
    });
    expect(result.passed).toBe(true);
    expect(result.baselineScore).toBe(0);
    expect(result.candidateScore).toBe(0);
  });
});
