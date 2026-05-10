import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';
import { readFileSync } from 'fs';

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
    const script = readFileSync(import.meta.dir + '/../scripts/smoke-test-installed-mcp.ts', 'utf8');
    const writebackCall = script.match(/name: 'route_memory_writeback'[\s\S]*?arguments: \{([\s\S]*?)\n    \},/);

    expect(writebackCall?.[1]).toContain('dry_run: true');
    expect(writebackCall?.[1]).toContain('apply: true');
  });
});
