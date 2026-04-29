import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
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
  if [ -f "$HOME/${name}-mcp-list.txt" ]; then
    cat "$HOME/${name}-mcp-list.txt"
  fi
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then
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
  const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'setup-agent', ...args], {
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

async function runInstalledHook(
  payload: string,
  options: { env?: Record<string, string>; cwd?: string } = {},
) {
  const hookPath = join(tempHome, '.claude', 'scripts', 'hooks', 'stop-mbrain-check.sh');
  const proc = spawnSync('bash', [hookPath], {
    cwd: options.cwd ?? repoRoot,
    env: {
      HOME: tempHome,
      PATH: `${tempBin}:${process.env.PATH ?? ''}`,
      ...(options.env ?? {}),
    },
    input: payload,
    encoding: 'utf-8',
  });

  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exitCode: proc.status,
  };
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'mbrain-setup-agent-'));
  tempBin = join(tempHome, 'bin');
  mkdirSync(tempBin, { recursive: true });
  mkdirSync(join(tempHome, '.claude'), { recursive: true });
  writeFakeCli('claude');
  writeFakeCli('codex');
  writeFakeCli('mbrain');
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tempHome, { recursive: true, force: true });
});

describe('setup-agent', () => {
  test('setup-agent --print emits compact rules with the required memory loop essentials', async () => {
    const result = await runSetupAgent(['--print']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('MBRAIN:RULES:START');
    expect(result.stdout).toContain('Read First When MBrain Is Relevant');
    expect(result.stdout).toContain('Write Back Durable Knowledge');
    expect(result.stdout).toContain('Backlinks And Sync');
    expect(result.stdout).toContain('sync_brain');
    expect(result.stdout).toContain('no_pull: true');
    expect(result.stdout).toContain('no_embed: true');
    expect(result.stdout).not.toContain('Every conversation must follow this cycle');
    expect(result.stdout).not.toContain('On EVERY inbound message');

    const wordCount = result.stdout.trim().split(/\s+/).length;
    expect(wordCount).toBeLessThan(650);
  });

  test('setup-agent --claude installs the Claude stop hook assets and registration', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const claudeMd = readFileSync(join(tempHome, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('MBRAIN:RULES:START');

    expect(existsSync(join(tempHome, '.claude', 'scripts', 'hooks', 'stop-mbrain-check.sh'))).toBe(true);
    expect(existsSync(join(tempHome, '.claude', 'scripts', 'hooks', 'lib', 'mbrain-relevance.sh'))).toBe(true);
    expect(existsSync(join(tempHome, '.claude', 'mbrain-skip-dirs'))).toBe(true);

    const settings = JSON.parse(readFileSync(join(tempHome, '.claude', 'settings.json'), 'utf-8'));
    const stopHooks = settings?.hooks?.Stop ?? [];
    const mbrainHook = stopHooks.find((entry: any) => entry.id === 'stop:mbrain-check');

    expect(mbrainHook).toBeDefined();
    expect(mbrainHook.hooks[0].command).toBe('bash "$HOME/.claude/scripts/hooks/stop-mbrain-check.sh"');
  });

  test('setup-agent explains Claude stop hook UX after installing it', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Claude Code MBrain memory check');
    expect(result.stdout).toContain('not a crash');
    expect(result.stdout).toContain('MBRAIN_STOP_HOOK=0');
    expect(result.stdout).toContain('~/.claude/mbrain-skip-dirs');
  });

  test('setup-agent registers Claude MCP at user scope by default', async () => {
    const result = await runSetupAgent(['--claude']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(tempHome, 'claude-mcp-add.log'), 'utf-8'))
      .toBe('mcp add -s user mbrain -- mbrain serve\n');
    expect(result.stdout).toContain('Claude MCP scope: user');
  });

  test('setup-agent does not treat project-local Claude MCP as user-scope registration', async () => {
    writeFileSync(join(tempHome, 'claude-mcp-list.txt'), 'mbrain: mbrain serve - connected\n', 'utf-8');
    writeFileSync(
      join(tempHome, 'claude-mcp-get.txt'),
      [
        'mbrain:',
        '  Scope: Local config (private to you in this project)',
        '  Type: stdio',
        '  Command: mbrain',
        '  Args: serve',
      ].join('\n'),
      'utf-8',
    );

    const result = await runSetupAgent(['--claude']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(tempHome, 'claude-mcp-add.log'), 'utf-8'))
      .toBe('mcp add -s user mbrain -- mbrain serve\n');
  });

  test('setup-agent does not treat user-scope Claude MCP as local registration', async () => {
    writeFileSync(join(tempHome, 'claude-mcp-list.txt'), 'mbrain: mbrain serve - connected\n', 'utf-8');
    writeFileSync(
      join(tempHome, 'claude-mcp-get.txt'),
      [
        'mbrain:',
        '  Scope: User config',
        '  Type: stdio',
        '  Command: mbrain',
        '  Args: serve',
      ].join('\n'),
      'utf-8',
    );

    const result = await runSetupAgent(['--claude', '--scope', 'local']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(tempHome, 'claude-mcp-add.log'), 'utf-8'))
      .toBe('mcp add -s local mbrain -- mbrain serve\n');
  });

  test('setup-agent supports explicit project-local Claude MCP scope', async () => {
    const result = await runSetupAgent(['--claude', '--scope', 'local']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(tempHome, 'claude-mcp-add.log'), 'utf-8'))
      .toBe('mcp add -s local mbrain -- mbrain serve\n');
    expect(result.stdout).toContain('Claude MCP scope: local');
  });

  test('setup-agent rejects invalid Claude MCP scope', async () => {
    const result = await runSetupAgent(['--claude', '--scope', 'workspace']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--scope must be either "user" or "local"');
    expect(existsSync(join(tempHome, 'claude-mcp-add.log'))).toBe(false);
  });

  test('setup-agent preserves existing settings.json fields when adding the stop hook', async () => {
    const settingsPath = join(tempHome, '.claude', 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { defaultMode: 'bypassPermissions' },
        enabledPlugins: { 'ecc@ecc': true },
        hooks: {
          PreToolUse: [{ id: 'existing:pre', matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
        },
      }, null, 2),
      'utf-8',
    );

    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
    expect(settings.enabledPlugins['ecc@ecc']).toBe(true);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].id).toBe('existing:pre');
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].id).toBe('stop:mbrain-check');
  });

  test('setup-agent removes legacy stop:mbrain-check entry from ~/.claude/hooks/hooks.json', async () => {
    const legacyPath = join(tempHome, '.claude', 'hooks', 'hooks.json');
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        hooks: {
          Stop: [
            { id: 'stop:mbrain-check', matcher: '*', hooks: [{ type: 'command', command: 'bash stale' }] },
            { id: 'stop:other', matcher: '*', hooks: [{ type: 'command', command: 'echo other' }] },
          ],
          PreToolUse: [{ id: 'pre:keep', matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep' }] }],
        },
      }, null, 2),
      'utf-8',
    );

    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    const legacyStop = legacy?.hooks?.Stop ?? [];
    expect(legacyStop.find((e: any) => e.id === 'stop:mbrain-check')).toBeUndefined();
    expect(legacyStop.find((e: any) => e.id === 'stop:other')).toBeDefined();
    expect(legacy.hooks.PreToolUse[0].id).toBe('pre:keep');
  });

  test('installed Claude hook emits a block decision for a relevant session', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const hook = await runInstalledHook('{"session_id":"s1","stop_hook_active":false}');

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toContain('"decision":"block"');
    expect(hook.stdout).toContain('MBrain memory check, not a crash');
    expect(hook.stdout).toContain('Claude Code may label this as');
    expect(hook.stdout).toContain('durable knowledge');
    expect(hook.stdout).toContain('Do not write to MBrain just because this hook fired');
    expect(hook.stdout).toContain('purely code editing, git operations, file management, library docs, or general programming');
    expect(hook.stdout).toContain('MBRAIN-PASS');
    expect(hook.stdout).not.toContain('mbrain write check');
  });

  test('installed Claude hook passes through when the mbrain stop hook kill switch is disabled', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const payload = '{"session_id":"s2","stop_hook_active":false}';
    const hook = await runInstalledHook(payload, { env: { MBRAIN_STOP_HOOK: '0' } });

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toBe(payload);
    expect(hook.stdout).not.toContain('"decision":"block"');
  });

  test('installed Claude hook passes through when mbrain is not on PATH', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const jqPath = Bun.which('jq');
    expect(jqPath).toBeDefined();

    const payload = '{"session_id":"s3","stop_hook_active":false}';
    const hook = await runInstalledHook(payload, {
      env: { PATH: `${dirname(jqPath!)}:/bin:/usr/bin` },
    });

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toBe(payload);
    expect(hook.stdout).not.toContain('"decision":"block"');
  });

  test('installed Claude hook passes through when the working directory is in mbrain-skip-dirs', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const skippedDir = join(tempHome, 'skip-me');
    mkdirSync(skippedDir, { recursive: true });
    writeFileSync(join(tempHome, '.claude', 'mbrain-skip-dirs'), `${skippedDir}\n`, 'utf-8');

    const proc = await runInstalledHook('{"session_id":"s4","stop_hook_active":false}', {
      cwd: skippedDir,
      env: {
        MBRAIN_SKIP_DIRS_FILE: join(tempHome, '.claude', 'mbrain-skip-dirs'),
      },
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.stderr).toBe('');
    expect(proc.stdout).toBe('{"session_id":"s4","stop_hook_active":false}');
  });

  test('installed Claude hook passes through on stop hook re-entry', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const payload = '{"session_id":"s5","stop_hook_active":true}';
    const hook = await runInstalledHook(payload);

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toBe(payload);
    expect(hook.stdout).not.toContain('"decision":"block"');
  });

  test('setup-agent does not duplicate the Claude stop hook registration on repeat runs', async () => {
    expect((await runSetupAgent(['--claude', '--skip-mcp'])).exitCode).toBe(0);
    expect((await runSetupAgent(['--claude', '--skip-mcp'])).exitCode).toBe(0);

    const settings = JSON.parse(readFileSync(join(tempHome, '.claude', 'settings.json'), 'utf-8'));
    const stopHooks = settings?.hooks?.Stop ?? [];
    const mbrainHooks = stopHooks.filter((entry: any) => entry.id === 'stop:mbrain-check');

    expect(mbrainHooks).toHaveLength(1);
  });

  test('installed Claude hook logs block decisions to ~/.claude/logs/mbrain-stop-hook.log', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const hook = await runInstalledHook('{"session_id":"s6","stop_hook_active":false}');
    expect(hook.exitCode).toBe(0);

    const logPath = join(tempHome, '.claude', 'logs', 'mbrain-stop-hook.log');
    expect(existsSync(logPath)).toBe(true);

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('s6');
    expect(log).toContain('block');
  });
});
