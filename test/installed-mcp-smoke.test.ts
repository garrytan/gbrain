import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';
import {
  WRITEBACK_SMOKE_ARGUMENTS,
  assertWritebackSmokeResult,
} from '../scripts/smoke-test-installed-mcp.ts';

describe('installed MCP smoke script', () => {
  test('passes against the source CLI command', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/smoke-test-installed-mcp.ts'], {
      cwd: import.meta.dir + '/..',
      env: {
        ...process.env,
        MBRAIN_SMOKE_COMMAND: 'bun run "src/cli.ts"',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);

    expect(proc.exitCode).toBe(0);
    expect(`${stdout}\n${stderr}`).toContain('Installed MCP smoke test passed.');
    expect(stdout).toContain('route_memory_writeback: dry-run ok');
  });

  test('route_memory_writeback smoke call exercises dry-run apply suppression', () => {
    expect(WRITEBACK_SMOKE_ARGUMENTS.dry_run).toBe(true);
    expect(WRITEBACK_SMOKE_ARGUMENTS.apply).toBe(true);
  });

  test('route_memory_writeback smoke assertion rejects dry-run-only payloads', () => {
    expect(() => assertWritebackSmokeResult({ dry_run: true })).toThrow(/decision/);
  });

  test('route_memory_writeback smoke assertion requires the expected candidate plan', () => {
    expect(() => assertWritebackSmokeResult({
      dry_run: true,
      applied: false,
      decision: 'create_candidate',
      intended_operation: 'create_memory_candidate_entry',
      candidate_input: {
        proposed_content: WRITEBACK_SMOKE_ARGUMENTS.content,
        source_refs: WRITEBACK_SMOKE_ARGUMENTS.source_refs,
      },
    })).not.toThrow();
  });
});
