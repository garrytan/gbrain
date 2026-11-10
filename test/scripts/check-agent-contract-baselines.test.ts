/**
 * The checked-in per-rule baselines under scripts/agent-contract-baselines/
 * (for example scripts/agent-contract-baselines/stdio-inherit.tsv) match the
 * real tree: scripts/check-agent-contract.ts exits 0 against them, so a change
 * that shrinks or grows a baseline row runs this lane.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');

describe('agent-contract baselines', () => {
  test('scripts/check-agent-contract.ts passes against the checked-in baselines', () => {
    const run = spawnSync('bun', [join(ROOT, 'scripts', 'check-agent-contract.ts')], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain('check-agent-contract: OK');
  }, 150_000);

  test('stdio-inherit.tsv lists each file once with a positive count', () => {
    const rows = readFileSync(join(ROOT, 'scripts', 'agent-contract-baselines', 'stdio-inherit.tsv'), 'utf8')
      .split('\n').filter(line => line && !line.startsWith('#'));
    const paths = rows.map(row => row.split('\t')[0]);
    expect(new Set(paths).size).toBe(paths.length);
    for (const row of rows) expect(Number(row.split('\t')[1])).toBeGreaterThan(0);
  });
});
