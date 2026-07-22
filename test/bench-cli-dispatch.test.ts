// #1474: the v0.41.1 wave shipped bench-publish.ts + docs/eval-bench.md
// advertising `gbrain bench publish`, but the cli.ts dispatcher case was never
// added — the documented command hit 'Unknown command'. These tests spawn the
// real CLI (no DB needed; bench publish is pure file I/O) and fail on any
// regression of the dispatcher wiring.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(process.execPath, ['run', 'src/cli.ts', 'bench', ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.status ?? -1 };
}

describe('gbrain bench dispatcher (#1474)', () => {
  test('bench --help reaches bench-publish help without a DB (was: Unknown command)', () => {
    const { stdout, stderr, code } = runCli(['--help']);
    expect(stderr).not.toContain('Unknown command');
    expect(code).toBe(0);
    expect(stdout).toContain('gbrain bench publish');
    expect(stdout).toContain('--from');
  });

  test('unknown bench subcommand exits 2 with usage', () => {
    const { stderr, code } = runCli(['bogus']);
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown bench subcommand');
    expect(stderr).toContain('bench publish');
  });

  test('bench publish roundtrip: captured NDJSON in, baseline file out', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bench-cli-'));
    try {
      const row = {
        tool_name: 'query',
        query: 'hello world',
        retrieved_slugs: ['slug-a'],
        retrieved_chunk_ids: [1],
        source_ids: ['default'],
        expand_enabled: false,
        detail: 'medium',
        detail_resolved: 'medium',
        vector_enabled: true,
        expansion_applied: false,
        latency_ms: 100,
        remote: false,
        job_id: null,
        subagent_id: null,
      };
      const from = join(tmp, 'captured.ndjson');
      const to = join(tmp, 'personal.baseline.ndjson');
      writeFileSync(from, `${JSON.stringify(row)}\n`);
      const { code, stderr } = runCli(['publish', '--from', from, '--to', to]);
      expect(stderr).not.toContain('Unknown command');
      expect(code).toBe(0);
      expect(existsSync(to)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
