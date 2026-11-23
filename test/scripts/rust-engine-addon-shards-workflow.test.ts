import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

// The macOS cell of the Rust engine addon job is split in two halves so each finishes under 30
// minutes (one cell took 43 minutes in run 45126845000, 33 of them in the parity loop). These checks
// keep the split honest: every parity file runs in exactly one half, the Linux cell is unchanged in
// what it runs, and one check still carries the old macOS name and passes only when both halves do.
type Step = { name?: string; if?: string; uses?: string; run?: string; env?: Record<string, string>; shell?: string };
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  strategy?: { 'fail-fast'?: boolean; matrix?: { include?: string } };
  steps?: Step[];
};
type Workflow = { name: string; jobs: Record<string, Job> };
type Cell = { target: string; runner: string; shard: string; shards: string; label: string };

const root = join(import.meta.dir, '../..');
const workflow = load(readFileSync(join(root, '.github/workflows/rust-engine.yml'), 'utf8')) as Workflow;
const addon = workflow.jobs.addon!;
const gate = workflow.jobs['addon-darwin-gate']!;
const steps = addon.steps ?? [];
const step = (prefix: string) => {
  const found = steps.find(s => (s.name ?? '').startsWith(prefix) || (prefix === 'upload' && (s.uses ?? '').startsWith('actions/upload-artifact@')));
  if (!found) throw new Error(`no step ${prefix}`);
  return found;
};

// Run the scope job's own script (a push event reads no pull request) and return its matrix.
function scopeTargets(): Cell[] {
  const dir = mkdtempSync(join(tmpdir(), 'scope-'));
  try {
    const out = join(dir, 'out.txt');
    writeFileSync(out, '');
    const run = Bun.spawnSync(['bash', '-c', workflow.jobs.scope!.steps![0]!.run!], {
      env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: out, EVENT: 'push' },
    });
    expect(run.exitCode).toBe(0);
    const line = readFileSync(out, 'utf8').split('\n').find(l => l.startsWith('targets='));
    return JSON.parse(line!.slice('targets='.length)) as Cell[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Run the parity step with a stand-in for bun that records what it was asked to test.
function parityRun(shard: string, shards: string): { parity: string[]; storeRuns: number } {
  const dir = mkdtempSync(join(tmpdir(), 'shard-'));
  try {
    const log = join(dir, 'log.txt');
    writeFileSync(log, '');
    writeFileSync(join(dir, 'bun'), `#!/bin/bash\necho "$*" >> "${log}"\n`);
    chmodSync(join(dir, 'bun'), 0o755);
    const run = Bun.spawnSync(['bash', '-c', step("Rust engine store tests").run!], {
      cwd: root,
      env: { PATH: `${dir}:${process.env.PATH ?? ''}`, SHARD: shard, SHARDS: shards },
    });
    expect(run.exitCode).toBe(0);
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    return {
      parity: calls.filter(c => c.includes('test/engine-parity/')).map(c => c.split(' ').pop()!),
      storeRuns: calls.filter(c => c.includes('test/rust-engine-store.test.ts')).length,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Rust engine addon job shards', () => {
  test('keeps the workflow name and the Linux job name, and splits the macOS cell in two', () => {
    expect(workflow.name).toBe('Rust engine');
    const names = scopeTargets().map(c => `Addon and Bun smoke / ${c.label}`);
    expect(addon.name).toBe('Addon and Bun smoke / ${{ matrix.label }}');
    expect(names).toEqual([
      'Addon and Bun smoke / linux-x64-glibc',
      'Addon and Bun smoke / darwin-arm64 (1 of 2)',
      'Addon and Bun smoke / darwin-arm64 (2 of 2)',
    ]);
  });

  test('Linux is one shard of one; macOS is shards 1 and 2 of 2 on the same runner', () => {
    const [linux, ...darwin] = scopeTargets();
    expect(linux).toEqual({ target: 'linux-x64-glibc', runner: 'ubicloud-standard-4-ubuntu-2404', shard: '1', shards: '1', label: 'linux-x64-glibc' });
    expect(darwin.map(c => [c.target, c.runner, c.shard, c.shards])).toEqual([
      ['darwin-arm64', 'macos-26', '1', '2'],
      ['darwin-arm64', 'macos-26', '2', '2'],
    ]);
  });

  test('every cell has the same 30 minute cap and one failing cell does not cancel the others', () => {
    expect(addon['timeout-minutes']).toBe(30);
    expect(addon.strategy?.['fail-fast']).toBe(false);
    expect(addon.strategy?.matrix?.include).toBe('${{ fromJSON(needs.scope.outputs.targets) }}');
  });

  test('the halves cover every parity file once, and a single shard runs all of them', () => {
    const all = readdirSync(join(root, 'test/engine-parity')).filter(f => f.endsWith('.test.ts')).map(f => `test/engine-parity/${f}`).sort();
    const one = parityRun('1', '1');
    const first = parityRun('1', '2');
    const second = parityRun('2', '2');
    expect([...one.parity].sort()).toEqual(all);
    expect([...first.parity, ...second.parity].sort()).toEqual(all);
    expect(first.parity.filter(f => second.parity.includes(f))).toEqual([]);
    expect(Math.abs(first.parity.length - second.parity.length)).toBeLessThanOrEqual(1);
    expect([one.storeRuns, first.storeRuns, second.storeRuns]).toEqual([1, 1, 0]);
  });

  test('the other steps run on the shard that owns them, so Linux still runs all of them', () => {
    const first = (s: Step) => s.if;
    expect(first(step('CLI parity'))).toBe("matrix.shard == '1'");
    expect(first(step('Withdrawn claims'))).toBe("matrix.shard == '1'");
    expect(first(step('Fail the withdrawn-lead lane'))).toBe("matrix.shard == '1'");
    expect(first(step('Token and member'))).toBe('matrix.shard == matrix.shards');
    expect(first(step('MCP receipt'))).toBe('matrix.shard == matrix.shards');
    expect(first(step('upload'))).toBe("matrix.shard == '1'");
    expect(step('upload').uses).toContain('actions/upload-artifact@');
    // Both halves build the addon and smoke it.
    expect(first(step('Build the addon'))).toBeUndefined();
    expect(first(step('Smoke test under Bun'))).toBeUndefined();
  });

  test('one check named like the old macOS cell passes only when every macOS half passed', () => {
    expect(gate.name).toBe('Addon and Bun smoke / darwin-arm64');
    expect(gate.needs).toEqual(['scope', 'addon']);
    expect(gate.if).toContain('!cancelled()');
    expect(gate.if).toContain("github.event_name != 'schedule'");
    expect(gate.if).toContain('darwin-arm64');
    expect(gate.permissions).toEqual({ contents: 'read', actions: 'read' });
    const script = gate.steps![0]!.run!;
    expect(script).toContain('startswith("Addon and Bun smoke / darwin-arm64 (")');
    expect(script).toContain('"$have" -eq "$want"');
    expect(script).toContain('"$ok" -eq "$want"');
    // The gate's own name must not match the pattern it reads, or it would wait on itself.
    expect(gate.name!.startsWith('Addon and Bun smoke / darwin-arm64 (')).toBe(false);
  });
});
