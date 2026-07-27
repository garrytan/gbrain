/**
 * SkillOpt --bootstrap-from-skill unit tests.
 *
 * Hermetic: tempdir skills/ + a stubbed chatFn (no engine, no LLM, no network).
 * Placeholder skill names only (repo privacy rule).
 *
 * Covers: happy path + deterministic task_ids, round-trip into loadBenchmark +
 * splitBench(1:1:1) (D4), JSONL salvage of a truncated line (D5), min-2-checks
 * task drop (D6), validateChecks filtering, provider-error propagation (codex —
 * not collapsed to bootstrap_empty), bootstrap_empty on no usable tasks,
 * benchmark_exists guard + --force, no_skill_md, fenced output, maxTokens
 * scaling, the sub-15 warning + --split 1:1:1 REVIEW line, and CLI parse +
 * mutual-exclusion via the exported parseFlags.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StructuredAgentError } from '../../src/core/errors.ts';
import { runBootstrapFromSkill } from '../../src/core/skillopt/bootstrap-benchmark.ts';
import { loadBenchmark, splitBench } from '../../src/core/skillopt/benchmark.ts';
import { BOOTSTRAP_PENDING_REVIEW } from '../../src/core/skillopt/types.ts';
import { parseFlags } from '../../src/commands/skillopt.ts';

const SKILL = 'widget-example';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillopt-fromskill-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Create skills/<name>/SKILL.md under tmpDir. Returns the skillsDir. */
function writeSkill(name: string, body = '# Widget Example\n\nProduces a structured report.\n'): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
  return tmpDir;
}

/** Stub chatFn that returns `text` and records the opts it was called with. */
function makeStub(text: string) {
  const calls: any[] = [];
  const chatFn = (async (opts: any) => {
    calls.push(opts);
    return {
      text,
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:model',
      providerId: 'test',
    };
  }) as any;
  return { chatFn, calls };
}

/** Build N JSONL task lines, each with `checksPerTask` valid `contains` checks. */
function jsonlTasks(n: number, checksPerTask = 2): string[] {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const checks = [];
    for (let c = 0; c < checksPerTask; c++) checks.push({ op: 'contains', arg: `tok-${i}-${c}` });
    lines.push(JSON.stringify({ task: `do task ${i}`, checks }));
  }
  return lines;
}

async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const orig = process.stderr.write;
  let buf = '';
  (process.stderr as any).write = (s: any) => { buf += String(s); return true; };
  try { await fn(); } finally { (process.stderr as any).write = orig; }
  return buf;
}

function outputPath(skillsDir: string, name: string): string {
  return path.join(skillsDir, name, 'skillopt-benchmark.jsonl');
}

describe('runBootstrapFromSkill — happy path', () => {
  test('writes 15 rows + sentinel with deterministic contiguous task_ids', async () => {
    const skillsDir = writeSkill(SKILL);
    const { chatFn } = makeStub(jsonlTasks(15).join('\n'));
    const res = await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });

    expect(res.rowsGenerated).toBe(15);
    expect(res.rowsSkipped).toBe(0);

    const content = fs.readFileSync(outputPath(skillsDir, SKILL), 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    // 15 task rows + sentinel.
    expect(lines.length).toBe(16);
    expect(lines[lines.length - 1]).toBe(BOOTSTRAP_PENDING_REVIEW);

    const ids = lines.slice(0, 15).map((l) => JSON.parse(l).task_id);
    expect(ids[0]).toBe(`${SKILL}-001`);
    expect(ids[14]).toBe(`${SKILL}-015`);
    expect(new Set(ids).size).toBe(15); // unique
  });

  test('every written row has a rule judge with the generated checks', async () => {
    const skillsDir = writeSkill(SKILL);
    const { chatFn } = makeStub(jsonlTasks(15).join('\n'));
    await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });
    const first = JSON.parse(fs.readFileSync(outputPath(skillsDir, SKILL), 'utf8').split('\n')[0]!);
    expect(first.judge.kind).toBe('rule');
    expect(first.judge.checks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('runBootstrapFromSkill — round-trip into the consumer (D4)', () => {
  test('generated file loads + splits 1:1:1 with sel >= 5', async () => {
    const skillsDir = writeSkill(SKILL);
    const { chatFn } = makeStub(jsonlTasks(15).join('\n'));
    const res = await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });

    // Simulate the real flow: user reviews + deletes the sentinel line.
    const raw = fs.readFileSync(res.outputPath, 'utf8');
    const stripped = raw.split('\n').filter((l) => l.trim() !== BOOTSTRAP_PENDING_REVIEW).join('\n');
    const reviewedPath = path.join(tmpDir, 'reviewed.jsonl');
    fs.writeFileSync(reviewedPath, stripped, 'utf8');

    const bench = loadBenchmark(reviewedPath);
    const split = splitBench(bench, [1, 1, 1]);
    expect(split.sel.length).toBeGreaterThanOrEqual(5);
    expect(split.train.length + split.sel.length + split.test.length).toBe(15);
  });
});

describe('runBootstrapFromSkill — JSONL salvage (D5)', () => {
  test('a truncated final line is skipped; the rest survive', async () => {
    const skillsDir = writeSkill(SKILL);
    const text = [...jsonlTasks(15), '{"task":"oops","checks":[{"op":"contains",'].join('\n'); // truncated
    const { chatFn } = makeStub(text);
    const res = await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });
    expect(res.rowsGenerated).toBe(15);
    expect(res.rowsSkipped).toBe(1);
  });

  test('parses output wrapped in a ```json fence', async () => {
    const skillsDir = writeSkill(SKILL);
    const text = '```json\n' + jsonlTasks(15).join('\n') + '\n```';
    const { chatFn } = makeStub(text);
    const res = await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });
    expect(res.rowsGenerated).toBe(15);
  });
});

describe('runBootstrapFromSkill — min-2-checks drop (D6) + validateChecks', () => {
  test('a task with <2 valid checks is dropped wholesale and counted', async () => {
    const skillsDir = writeSkill(SKILL);
    const lines = jsonlTasks(15); // 15 valid
    lines.push(JSON.stringify({ task: 'thin', checks: [{ op: 'contains', arg: 'only-one' }] })); // 1 check -> dropped
    const { chatFn } = makeStub(lines.join('\n'));
    const res = await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });
    expect(res.rowsGenerated).toBe(15);
    expect(res.rowsSkipped).toBe(1);
  });

  test('bad-op checks are filtered, dropping the task below the 2-check floor', async () => {
    const skillsDir = writeSkill(SKILL);
    const lines = jsonlTasks(15);
    // 1 bad op + 1 good = 1 valid surviving -> task dropped.
    lines.push(JSON.stringify({ task: 'mixed', checks: [{ op: 'bogus', arg: 'x' }, { op: 'contains', arg: 'y' }] }));
    // 1 bad op + 2 good = 2 valid surviving -> task kept.
    lines.push(JSON.stringify({ task: 'survivor', checks: [{ op: 'bogus', arg: 'x' }, { op: 'contains', arg: 'a' }, { op: 'max_chars', arg: 100 }] }));
    const { chatFn } = makeStub(lines.join('\n'));
    const res = await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });
    expect(res.rowsGenerated).toBe(16); // 15 + survivor
    expect(res.rowsSkipped).toBe(1);    // mixed dropped
    // The survivor's surviving checks are exactly the 2 valid ones.
    const rows = fs.readFileSync(outputPath(skillsDir, SKILL), 'utf8').split('\n').filter((l) => l.trim() && l.trim() !== BOOTSTRAP_PENDING_REVIEW);
    const survivor = rows.map((l) => JSON.parse(l)).find((r) => r.task === 'survivor');
    expect(survivor.judge.checks.length).toBe(2);
  });
});

describe('runBootstrapFromSkill — error semantics', () => {
  test('provider/transport error PROPAGATES, not collapsed to bootstrap_empty (codex)', async () => {
    const skillsDir = writeSkill(SKILL);
    const boom = new Error('provider down: 503');
    const chatFn = (async () => { throw boom; }) as any;
    await expect(
      runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn }),
    ).rejects.toThrow('provider down: 503');
    // No file written.
    expect(fs.existsSync(outputPath(skillsDir, SKILL))).toBe(false);
  });

  test('no usable tasks -> bootstrap_empty', async () => {
    const skillsDir = writeSkill(SKILL);
    const { chatFn } = makeStub('here are some thoughts but no json at all');
    try {
      await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredAgentError);
      expect((err as StructuredAgentError).envelope.code).toBe('bootstrap_empty');
    }
  });

  test('benchmark_exists without --force; --force overwrites', async () => {
    const skillsDir = writeSkill(SKILL);
    fs.writeFileSync(outputPath(skillsDir, SKILL), 'preexisting\n', 'utf8');
    const { chatFn } = makeStub(jsonlTasks(15).join('\n'));
    try {
      await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as StructuredAgentError).envelope.code).toBe('benchmark_exists');
    }
    const res = await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn, force: true });
    expect(res.rowsGenerated).toBe(15);
  });

  test('no SKILL.md -> no_skill_md', async () => {
    const skillsDir = tmpDir; // skill dir not created
    fs.mkdirSync(path.join(skillsDir, SKILL), { recursive: true });
    const { chatFn } = makeStub(jsonlTasks(15).join('\n'));
    try {
      await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as StructuredAgentError).envelope.code).toBe('no_skill_md');
    }
  });
});

describe('runBootstrapFromSkill — prompt shape + maxTokens scaling', () => {
  test('system prompt names JSONL + the declared-tools-only rule; body is passed', async () => {
    const skillsDir = writeSkill(SKILL, '# Widget\n\ntools:\n  - search\n\nProduces stuff.\n');
    const { chatFn, calls } = makeStub(jsonlTasks(15).join('\n'));
    await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });
    expect(calls.length).toBe(1);
    expect(calls[0].system).toContain('JSONL');
    expect(calls[0].system).toContain('frontmatter');
    expect(calls[0].system.toLowerCase()).toContain('do not invent tool names');
    expect(calls[0].messages[0].content).toContain('Produces stuff.');
  });

  test('maxTokens = 4000 at default count, 8000 at the 50 cap', async () => {
    const dirA = writeSkill('alpha-example');
    const stubA = makeStub(jsonlTasks(15).join('\n'));
    await runBootstrapFromSkill({ skillsDir: dirA, skillName: 'alpha-example', optimizerModel: 'test:m', chatFn: stubA.chatFn });
    expect(stubA.calls[0].maxTokens).toBe(4000); // 15*220=3300 -> max(4000,..)=4000

    const dirB = writeSkill('beta-example');
    const stubB = makeStub(jsonlTasks(15).join('\n'));
    await runBootstrapFromSkill({ skillsDir: dirB, skillName: 'beta-example', optimizerModel: 'test:m', taskCount: 50, chatFn: stubB.chatFn });
    expect(stubB.calls[0].maxTokens).toBe(8000); // 50*220=11000 -> min(8000,..)=8000
  });
});

describe('runBootstrapFromSkill — stderr guidance', () => {
  test('REVIEW line includes the --split 1:1:1 next command (D4)', async () => {
    const skillsDir = writeSkill(SKILL);
    const { chatFn } = makeStub(jsonlTasks(15).join('\n'));
    const err = await captureStderr(async () => {
      await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });
    });
    expect(err).toContain(`gbrain skillopt ${SKILL} --bootstrap-reviewed --split 1:1:1`);
    expect(err).toContain('STRENGTHEN');
  });

  test('warns when fewer than 15 tasks are generated', async () => {
    const skillsDir = writeSkill(SKILL);
    const { chatFn } = makeStub(jsonlTasks(8).join('\n'));
    const err = await captureStderr(async () => {
      const res = await runBootstrapFromSkill({ skillsDir, skillName: SKILL, optimizerModel: 'test:m', chatFn });
      expect(res.rowsGenerated).toBe(8);
    });
    expect(err).toContain('only 8 task');
    expect(err).toContain('d_sel_too_small');
  });
});

describe('parseFlags — --bootstrap-from-skill CLI surface', () => {
  test('parses the flag + --bootstrap-tasks', () => {
    const p = parseFlags([SKILL, '--bootstrap-from-skill', '--bootstrap-tasks', '20']);
    expect(p.bootstrapFromSkill).toBe(true);
    expect(p.bootstrapTasks).toBe(20);
  });

  test('--bootstrap-tasks caps at 50', () => {
    expect(() => parseFlags([SKILL, '--bootstrap-from-skill', '--bootstrap-tasks', '99'])).toThrow(/max is 50/);
  });

  test('--bootstrap-tasks without --bootstrap-from-skill is rejected', () => {
    expect(() => parseFlags([SKILL, '--bootstrap-tasks', '20'])).toThrow(/requires --bootstrap-from-skill/);
  });

  test('mutual exclusion: routing / benchmark / all / target-models / resume', () => {
    expect(() => parseFlags([SKILL, '--bootstrap-from-skill', '--bootstrap-from-routing'])).toThrow(/mutually exclusive/);
    expect(() => parseFlags([SKILL, '--bootstrap-from-skill', '--benchmark', 'x.jsonl'])).toThrow(/mutually exclusive/);
    expect(() => parseFlags([SKILL, '--bootstrap-from-skill', '--all'])).toThrow(/mutually exclusive/);
    expect(() => parseFlags([SKILL, '--bootstrap-from-skill', '--target-models', 'a,b'])).toThrow(/mutually exclusive/);
    expect(() => parseFlags([SKILL, '--bootstrap-from-skill', '--resume', 'run-1'])).toThrow(/mutually exclusive/);
  });

  test('--background is rejected by the unknown-flag guard (pre-existing CLI behavior)', () => {
    expect(() => parseFlags([SKILL, '--bootstrap-from-skill', '--background'])).toThrow(/unknown flag/);
  });
});
