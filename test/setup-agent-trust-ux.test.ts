import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = new URL('..', import.meta.url).pathname;
const originalEnv = { ...process.env };
let tempHome: string;
let tempBin: string;

function writeFakeCli(name: string) {
  const scriptPath = join(tempBin, name);
  writeFileSync(
    scriptPath,
    `#!/bin/sh
if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then
  echo "$@" >> "$HOME/${name}-mcp-probe.log"
  if [ -f "$HOME/${name}-mcp-list.txt" ]; then
    cat "$HOME/${name}-mcp-list.txt"
  fi
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then
  echo "$@" >> "$HOME/${name}-mcp-probe.log"
  if [ -f "$HOME/${name}-mcp-get.txt" ]; then
    cat "$HOME/${name}-mcp-get.txt"
    exit 0
  fi
  exit 1
fi
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  echo "$@" >> "$HOME/${name}-mcp-add.log"
  exit 0
fi
exit 0
`,
    'utf-8',
  );
  Bun.spawnSync(['chmod', '+x', scriptPath]);
}

async function runSetupAgent(args: string[]) {
  const proc = Bun.spawn(['bun', 'run', join(repoRoot, 'src/cli.ts'), 'setup-agent', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tempHome,
      PATH: `${tempBin}:${process.env.PATH ?? ''}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

function expectNoSetupSideEffects() {
  expect(existsSync(join(tempHome, '.claude', 'CLAUDE.md'))).toBe(false);
  expect(existsSync(join(tempHome, '.codex', 'AGENTS.md'))).toBe(false);
  expect(existsSync(join(tempHome, '.claude', 'settings.json'))).toBe(false);
  expect(existsSync(join(tempHome, '.claude', 'scripts', 'hooks', 'stop-mbrain-check.sh'))).toBe(false);
  expect(existsSync(join(tempHome, '.claude', 'CLAUDE.md.mbrain.tmp'))).toBe(false);
  expect(existsSync(join(tempHome, '.codex', 'AGENTS.md.mbrain.tmp'))).toBe(false);
  expect(existsSync(join(tempHome, 'claude-mcp-add.log'))).toBe(false);
  expect(existsSync(join(tempHome, 'codex-mcp-add.log'))).toBe(false);
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'mbrain-setup-agent-trust-ux-'));
  tempBin = join(tempHome, 'bin');
  mkdirSync(tempBin, { recursive: true });
  mkdirSync(join(tempHome, '.claude'), { recursive: true });
  mkdirSync(join(tempHome, '.codex'), { recursive: true });
  writeFakeCli('claude');
  writeFakeCli('codex');
  writeFakeCli('mbrain');
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempHome, { recursive: true, force: true });
});

describe('setup-agent trust UX preview and diff', () => {
  test('setup-agent --preview --json plans managed actions without side effects', async () => {
    const result = await runSetupAgent(['--preview', '--json']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expectNoSetupSideEffects();

    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      status: 'ok',
      mode: 'preview',
      mutating: false,
      changed: false,
      would_change: true,
      managed_only: true,
    });
    expect(report.version).toMatch(/\d+\.\d+\.\d+/);
    expect(report.clients.map((client: any) => client.client).sort()).toEqual(['claude', 'codex']);

    const actions = report.clients.flatMap((client: any) => client.actions);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target_kind: 'mcp_registration',
        status: 'create',
        effects: expect.arrayContaining(['runs_external_probe', 'external_mutation']),
      }),
      expect.objectContaining({
        target_kind: 'prompt_rules',
        status: 'create',
        effects: expect.arrayContaining(['reads_user_config', 'filesystem_write']),
      }),
      expect.objectContaining({
        target_kind: 'claude_stop_hook',
        status: 'create',
        effects: expect.arrayContaining(['filesystem_write', 'chmod']),
      }),
    ]));
  });

  test('setup-agent --diff shows redacted managed diffs without writing user files', async () => {
    const agentsPath = join(tempHome, '.codex', 'AGENTS.md');
    writeFileSync(agentsPath, 'PRIVATE USER CONTENT\n', 'utf-8');

    const result = await runSetupAgent(['--codex', '--diff']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('MBrain setup-agent diff (zero-write: no changes made)');
    expect(result.stdout).toContain('@@ mbrain managed prompt_rules @@');
    expect(result.stdout).toContain('planned_status: create');
    expect(result.stdout).not.toContain('PRIVATE USER CONTENT');
    expect(readFileSync(agentsPath, 'utf-8')).toBe('PRIVATE USER CONTENT\n');
    expect(existsSync(join(tempHome, 'codex-mcp-add.log'))).toBe(false);
  });

  test('setup-agent --diff --json redacts unrelated user prompt and settings content', async () => {
    writeFileSync(join(tempHome, '.claude', 'CLAUDE.md'), 'USER_SECRET_DO_NOT_LEAK=claude\n', 'utf-8');
    writeFileSync(
      join(tempHome, '.claude', 'settings.json'),
      JSON.stringify({
        apiKey: 'USER_SECRET_DO_NOT_LEAK=settings',
        hooks: { PreToolUse: [{ id: 'user:hook', command: 'echo USER_SECRET_DO_NOT_LEAK' }] },
      }),
      'utf-8',
    );

    const result = await runSetupAgent(['--claude', '--diff', '--json']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('USER_SECRET_DO_NOT_LEAK');

    const report = JSON.parse(result.stdout);
    expect(report.mode).toBe('diff');
    expect(report.diffs.every((diff: any) => diff.redacted === true)).toBe(true);
    expect(JSON.stringify(report.diffs)).not.toContain('USER_SECRET_DO_NOT_LEAK');
  });

  test('setup-agent --preview --skip-mcp skips registration probes and add commands', async () => {
    const result = await runSetupAgent(['--preview', '--skip-mcp', '--json']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(existsSync(join(tempHome, 'claude-mcp-probe.log'))).toBe(false);
    expect(existsSync(join(tempHome, 'codex-mcp-probe.log'))).toBe(false);
    expect(existsSync(join(tempHome, 'claude-mcp-add.log'))).toBe(false);
    expect(existsSync(join(tempHome, 'codex-mcp-add.log'))).toBe(false);

    const report = JSON.parse(result.stdout);
    const mcpActions = report.clients.flatMap((client: any) => client.actions)
      .filter((action: any) => action.target_kind === 'mcp_registration');
    expect(mcpActions.every((action: any) => action.status === 'skip')).toBe(true);
    expect(mcpActions.every((action: any) => action.effects.length === 0)).toBe(true);
  });

  test('setup-agent mode conflicts fail before mutation', async () => {
    for (const args of [
      ['--preview', '--apply'],
      ['--diff', '--uninstall'],
      ['--apply', '--uninstall'],
      ['--preview', '--diff', '--apply'],
    ]) {
      const result = await runSetupAgent(args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('setup-agent modes are mutually exclusive');
      expectNoSetupSideEffects();
    }
  });

  test('setup-agent --uninstall fails closed until managed uninstall is implemented', async () => {
    const result = await runSetupAgent(['--uninstall']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('setup-agent --uninstall is planned but not implemented yet');
    expectNoSetupSideEffects();
  });

  test('setup-agent --print remains print-only when preview is also present', async () => {
    const result = await runSetupAgent(['--print', '--preview']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('MBRAIN:RULES:START');
    expect(result.stdout).not.toContain('setup-agent preview');
    expectNoSetupSideEffects();
  });

  test('bare setup-agent --json remains a mutating compatibility alias with additive fields', async () => {
    const result = await runSetupAgent(['--codex', '--skip-mcp', '--json']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      status: 'ok',
      mode: 'apply',
      mutating: true,
      compatibility_alias: true,
      changed: true,
      managed_only: true,
    });
    expect(report.version).toMatch(/\d+\.\d+\.\d+/);
    expect(report.clients).toEqual([
      expect.objectContaining({
        client: 'codex',
        mcp: 'skipped',
        rules: 'injected',
      }),
    ]);
    expect(readFileSync(join(tempHome, '.codex', 'AGENTS.md'), 'utf-8')).toContain('MBRAIN:RULES:START');
  });
});
