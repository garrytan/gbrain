/**
 * Self-test for scripts/check-jsonb-pattern.sh.
 *
 * The guard is deliberately regex-based, so keep tiny synthetic violators here
 * for both untyped and typed executeRaw calls. The typed form is common in this
 * codebase and must not slip past the positional JSONB check.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(import.meta.dir, '..', '..', 'scripts', 'check-jsonb-pattern.sh');

function runGateWithSource(sourceText: string): { code: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-jsonb-guard-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'violator.ts'), sourceText, 'utf8');

    const result = spawnSync('bash', [SCRIPT_PATH], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-jsonb-pattern.sh positional executeRaw guard', () => {
  test('flags untyped executeRaw with JSON.stringify bound to a jsonb cast', () => {
    const result = runGateWithSource(`
async function bad(engine: any, value: unknown) {
  await engine.executeRaw(
    \`UPDATE sources SET config = $1::jsonb\`,
    [JSON.stringify(value)],
  );
}
`);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('positional double-encode');
  });

  test('flags typed executeRaw<T> with JSON.stringify bound to a jsonb cast', () => {
    const result = runGateWithSource(`
async function bad(engine: any, value: unknown) {
  await engine.executeRaw<{ id: string }>(
    \`UPDATE sources SET config = $1::jsonb RETURNING id\`,
    [JSON.stringify(value)],
  );
}
`);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('positional double-encode');
  });
});
