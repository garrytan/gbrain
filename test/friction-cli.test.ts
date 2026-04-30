/**
 * Friction CLI dispatch tests. Exercises the thin command layer (each
 * subcommand stays ≤ 30 LOC per the DRY contract from the eng review).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runFriction } from '../src/commands/friction.ts';
import { frictionFile, frictionDir } from '../src/core/friction.ts';

const ORIG_HOME = process.env.GBRAIN_HOME;
const ORIG_RUN_ID = process.env.GBRAIN_FRICTION_RUN_ID;
let tmp: string;
let stdoutLines: string[];
let stderrLines: string[];
let origStdoutWrite: typeof process.stdout.write;
let origConsoleLog: typeof console.log;
let origConsoleError: typeof console.error;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'friction-cli-'));
  process.env.GBRAIN_HOME = tmp;
  delete process.env.GBRAIN_FRICTION_RUN_ID;
  stdoutLines = [];
  stderrLines = [];
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origConsoleLog = console.log;
  origConsoleError = console.error;
  process.stdout.write = ((chunk: string) => { stdoutLines.push(String(chunk)); return true; }) as any;
  console.log = (...args: unknown[]) => { stdoutLines.push(args.join(' ') + '\n'); };
  console.error = (...args: unknown[]) => { stderrLines.push(args.join(' ') + '\n'); };
});

afterEach(() => {
  process.env.GBRAIN_HOME = ORIG_HOME;
  if (ORIG_RUN_ID !== undefined) process.env.GBRAIN_FRICTION_RUN_ID = ORIG_RUN_ID;
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write = origStdoutWrite;
  console.log = origConsoleLog;
  console.error = origConsoleError;
});

describe('dispatch', () => {
  test('--help returns 0 and prints subcommand list', () => {
    const code = runFriction(['--help']);
    expect(code).toBe(0);
    expect(stdoutLines.join('')).toContain('Subcommands');
    expect(stdoutLines.join('')).toContain('log');
    expect(stdoutLines.join('')).toContain('render');
    expect(stdoutLines.join('')).toContain('list');
    expect(stdoutLines.join('')).toContain('summary');
  });

  test('unknown subcommand returns 2', () => {
    const code = runFriction(['nonsense']);
    expect(code).toBe(2);
    expect(stderrLines.join('')).toContain('unknown subcommand');
  });
});

describe('log subcommand', () => {
  test('writes a friction entry under GBRAIN_HOME', () => {
    const code = runFriction(['log', '--run-id', 'cli-1', '--phase', 'install', '--message', 'something broke', '--severity', 'error']);
    expect(code).toBe(0);
    const path = frictionFile('cli-1');
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(tmp)).toBe(true);
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('something broke');
  });

  test('missing --phase returns 2 with usage', () => {
    const code = runFriction(['log', '--message', 'foo']);
    expect(code).toBe(2);
    expect(stderrLines.join('')).toContain('usage');
  });

  test('missing --message returns 2 with usage', () => {
    const code = runFriction(['log', '--phase', 'p']);
    expect(code).toBe(2);
    expect(stderrLines.join('')).toContain('usage');
  });

  test('invalid --severity returns 2', () => {
    const code = runFriction(['log', '--run-id', 'cli-2', '--phase', 'p', '--message', 'm', '--severity', 'panicking']);
    expect(code).toBe(2);
    expect(stderrLines.join('')).toContain('invalid --severity');
  });

  test('invalid --kind returns 2', () => {
    const code = runFriction(['log', '--run-id', 'cli-3', '--phase', 'p', '--message', 'm', '--kind', 'bogus']);
    expect(code).toBe(2);
    expect(stderrLines.join('')).toContain('invalid --kind');
  });

  test('--kind delight is recorded', () => {
    runFriction(['log', '--run-id', 'cli-4', '--phase', 'p', '--message', 'great', '--kind', 'delight']);
    const raw = readFileSync(frictionFile('cli-4'), 'utf-8');
    expect(raw).toContain('"kind":"delight"');
  });
});

describe('render subcommand', () => {
  test('renders markdown by default', () => {
    runFriction(['log', '--run-id', 'cli-r', '--phase', 'install', '--message', 'beep', '--severity', 'error']);
    stdoutLines.length = 0;
    const code = runFriction(['render', '--run-id', 'cli-r']);
    expect(code).toBe(0);
    const out = stdoutLines.join('');
    expect(out).toContain('# Friction report');
    expect(out).toContain('## error');
  });

  test('--json emits parseable JSON', () => {
    runFriction(['log', '--run-id', 'cli-r2', '--phase', 'p', '--message', 'beep']);
    stdoutLines.length = 0;
    const code = runFriction(['render', '--run-id', 'cli-r2', '--json']);
    expect(code).toBe(0);
    const out = stdoutLines.join('').trim();
    const parsed = JSON.parse(out);
    expect(parsed.run_id).toBe('cli-r2');
    expect(parsed.entries.length).toBe(1);
  });

  test('missing run-id returns 1 with actionable error', () => {
    const code = runFriction(['render', '--run-id', 'no-such-run']);
    expect(code).toBe(1);
    expect(stderrLines.join('')).toContain('not found');
  });
});

describe('list subcommand', () => {
  test('reports no runs initially', () => {
    const code = runFriction(['list']);
    expect(code).toBe(0);
    expect(stdoutLines.join('')).toContain('no runs');
  });

  test('lists logged runs with counts', () => {
    runFriction(['log', '--run-id', 'a', '--phase', 'p', '--message', 'm', '--severity', 'error']);
    runFriction(['log', '--run-id', 'b', '--phase', 'p', '--message', 'm', '--kind', 'delight']);
    stdoutLines.length = 0;
    const code = runFriction(['list']);
    expect(code).toBe(0);
    const out = stdoutLines.join('');
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  test('--json emits parseable JSON array', () => {
    runFriction(['log', '--run-id', 'jl', '--phase', 'p', '--message', 'm']);
    stdoutLines.length = 0;
    const code = runFriction(['list', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutLines.join('').trim());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].runId).toBe('jl');
  });
});

describe('summary subcommand', () => {
  test('renders friction + delight columns', () => {
    runFriction(['log', '--run-id', 'sum-1', '--phase', 'p', '--message', 'broken thing']);
    runFriction(['log', '--run-id', 'sum-1', '--phase', 'p', '--message', 'nice thing', '--kind', 'delight']);
    stdoutLines.length = 0;
    const code = runFriction(['summary', '--run-id', 'sum-1']);
    expect(code).toBe(0);
    const out = stdoutLines.join('');
    expect(out).toContain('friction (1)');
    expect(out).toContain('delight (1)');
    expect(out).toContain('broken thing');
    expect(out).toContain('nice thing');
  });
});

describe('GBRAIN_FRICTION_RUN_ID fallback (D19)', () => {
  test('log without --run-id uses standalone', () => {
    const code = runFriction(['log', '--phase', 'p', '--message', 'fallback']);
    expect(code).toBe(0);
    const path = frictionFile('standalone');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('fallback');
  });

  test('log honors $GBRAIN_FRICTION_RUN_ID', () => {
    process.env.GBRAIN_FRICTION_RUN_ID = 'env-run';
    try {
      runFriction(['log', '--phase', 'p', '--message', 'env']);
      expect(existsSync(frictionFile('env-run'))).toBe(true);
    } finally {
      delete process.env.GBRAIN_FRICTION_RUN_ID;
    }
  });
});
