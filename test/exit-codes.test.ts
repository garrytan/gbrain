/**
 * Agent operator contract v1 exit table (docs/designs/AGENT_OPERATOR_WAVE.md
 * A3). Exit 3 means confirmation_required and nothing else: every literal
 * `exit(3)`, `setCliExitVerdict(3)`, `exitCode = 3` and exported exit-code
 * constant equal to 3 in src/ must be listed here, so an unlisted one fails.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as exitCodes from '../src/core/exit-codes.ts';
import { exitCodeForCode } from '../src/core/error-catalogue.ts';

const ROOT = join(import.meta.dir, '..');

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...srcFiles(full));
    else if (e.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The only sanctioned exit-3 sites: the constant itself. */
const ALLOWED_EXIT_3: ReadonlySet<string> = new Set([
  'src/core/exit-codes.ts: CONFIRMATION_REQUIRED_EXIT_CODE',
]);

describe('exit code table', () => {
  test('the published values', () => {
    expect(exitCodes.OK_EXIT_CODE).toBe(0);
    expect(exitCodes.FAILED_EXIT_CODE).toBe(1);
    expect(exitCodes.USAGE_EXIT_CODE).toBe(2);
    expect(exitCodes.CONFIRMATION_REQUIRED_EXIT_CODE).toBe(3);
    expect(exitCodes.PENDING_WRITE_EXIT_CODE).toBe(10);
    expect(exitCodes.BUDGET_STOP_EXIT_CODE).toBe(11);
    expect(exitCodes.MIGRATIONS_RUNNING_EXIT_CODE).toBe(75);
    expect(exitCodes.TIMEOUT_EXIT_CODE).toBe(124);
    expect(exitCodes.INTERRUPTED_EXIT_CODE).toBe(130);
  });

  test('every constant is distinct', () => {
    const values = Object.values(exitCodes).filter(v => typeof v === 'number');
    expect(new Set(values).size).toBe(values.length);
  });

  test('registry codes map onto the table', () => {
    expect(exitCodeForCode('confirmation_required')).toBe(3);
    expect(exitCodeForCode('invalid_params')).toBe(2);
    expect(exitCodeForCode('unknown_flag')).toBe(2);
    expect(exitCodeForCode('write_pending')).toBe(10);
    expect(exitCodeForCode('timeout')).toBe(124);
    expect(exitCodeForCode('interrupted')).toBe(130);
    expect(exitCodeForCode('internal_error')).toBe(1);
    expect(exitCodeForCode('approval_required')).toBe(1);
  });

  test('no exit 3 in src/ outside confirmation_required', () => {
    const offenders: string[] = [];
    const patterns: RegExp[] = [
      /\bexit\(\s*3\s*\)/,
      /setCliExitVerdict\(\s*3\s*\)/,
      /\bexitCode\s*=\s*3\b/,
      /flushThenExit\(\s*3\s*[,)]/,
    ];
    for (const file of srcFiles(join(ROOT, 'src'))) {
      const rel = relative(ROOT, file);
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (patterns.some(p => p.test(line))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        const constant = /export const ([A-Z0-9_]*EXIT[A-Z0-9_]*)\s*=\s*3\s*;/.exec(line);
        if (constant && !ALLOWED_EXIT_3.has(`${rel}: ${constant[1]}`)) offenders.push(`${rel}:${i + 1}: ${constant[1]} = 3`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('the exit-codes guide documents every value', () => {
    const doc = readFileSync(join(ROOT, 'docs/guides/exit-codes.md'), 'utf8');
    for (const v of [0, 1, 2, 3, 10, 11, 75, 124, 130]) expect(doc).toContain(`| ${v} |`);
    expect(doc).toContain('## Changed in this release');
  });
});
