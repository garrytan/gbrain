import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const repoRoot = new URL('..', import.meta.url).pathname;
const conciseStopHookReason = 'MBrain memory check (not a crash): route durable signals through route_memory_writeback and the assertion pipeline; eligible writes become governed canonical memory, ambiguous ones become candidates. Otherwise reply exactly MBRAIN-PASS: <short reason>.';
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

async function runSetupAgent(args: string[], options: { cwd?: string } = {}) {
  const proc = Bun.spawn(['bun', 'run', join(repoRoot, 'src/cli.ts'), 'setup-agent', ...args], {
    cwd: options.cwd ?? repoRoot,
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

function restrictedPathWithoutMbrain(): string {
  // System dirs only (plus jq when available), excluding tempBin where the
  // fake mbrain CLI lives, so the relevance gate sees mbrain as missing.
  const jqPath = Bun.which('jq');
  const base = ['/bin', '/usr/bin'];
  if (jqPath) base.unshift(dirname(jqPath));
  return base.join(':');
}

async function runInstalledHook(
  payload: string,
  options: { env?: Record<string, string>; cwd?: string; script?: string } = {},
) {
  const hookPath = join(tempHome, '.claude', 'scripts', 'hooks', options.script ?? 'stop-mbrain-check.sh');
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
    expect(result.stdout).toContain('lightweight scan for durable knowledge signals');
    expect(result.stdout).toContain('retrieve_context');
    expect(result.stdout).toContain('candidate_signals');
    expect(result.stdout).toContain('Memory Inbox has non-canonical signals');
    expect(result.stdout).toContain('targetless candidates are not evidence for factual answers');
    expect(result.stdout).toContain('approve or reject the proposal');
    expect(result.stdout).toMatch(/approval must\s+not call put_page/);
    expect(result.stdout).toContain('read_context');
    expect(result.stdout).toMatch(/both pointers,\s+not answer evidence/);
    expect(result.stdout).toMatch(/canonical evidence boundary before\s+factual claims/);
    expect(result.stdout).toContain('Route Durable Writeback');
    expect(result.stdout).toContain('route_memory_writeback');
    expect(result.stdout).toContain('managed Postgres + pgvector target runtime');
    expect(result.stdout).toContain('automatic canonical writeback exists');
    expect(result.stdout).toContain('assertion pipeline');
    expect(result.stdout).toContain('raw source access is scoped');
    expect(result.stdout).toMatch(/secrets\s+are never canonical memory/);
    expect(result.stdout).toContain('daily memory report is the primary review surface');
    expect(result.stdout).toContain('canonical_write_allowed');
    expect(result.stdout).toContain('target_snapshot_hash');
    expect(result.stdout).toContain('write_session_id');
    expect(result.stdout).toContain('do not add timeline content');
    expect(result.stdout).toContain('expected_content_hash');
    expect(result.stdout).toContain('Backlinks And Sync');
    expect(result.stdout).toContain('sync_brain');
    expect(result.stdout).toContain('no_pull: true');
    expect(result.stdout).toContain('no_embed: true');
    expect(result.stdout).not.toContain('Every conversation must follow this cycle');
    expect(result.stdout).not.toContain('On EVERY inbound message');

    const wordCount = result.stdout.trim().split(/\s+/).length;
    // Budget raised from 720 to accommodate the D1 (put_page CAS) and D2 (promotion ≠
    // retrievable) governance contract notes; the rules stay deliberately compact.
    expect(wordCount).toBeLessThan(820);
  });

  test('setup-agent --print ignores stale cwd-local rule files', async () => {
    const staleCwd = mkdtempSync(join(tmpdir(), 'mbrain-stale-rules-cwd-'));
    try {
      mkdirSync(join(staleCwd, 'docs'), { recursive: true });
      writeFileSync(
        join(staleCwd, 'docs', 'MBRAIN_AGENT_RULES.md'),
        '<!-- mbrain-agent-rules-version: 9.9.9 -->\nSTALE CWD RULES\n',
        'utf-8',
      );

      const result = await runSetupAgent(['--print'], { cwd: staleCwd });

      expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('mbrain-agent-rules-version: 0.5.12');
      expect(result.stdout).toContain('candidate_signals');
      expect(result.stdout).toContain('tool_search');
      expect(result.stdout).not.toContain('STALE CWD RULES');
      expect(result.stdout).not.toContain('9.9.9');
    } finally {
      rmSync(staleCwd, { recursive: true, force: true });
    }
  });

  test('setup-agent --claude installs the Claude stop hook assets and registration', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const claudeMd = readFileSync(join(tempHome, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('MBRAIN:RULES:START');
    expect(claudeMd).toContain('retrieve_context');
    expect(claudeMd).toContain('candidate_signals');
    expect(claudeMd).toContain('tool_search');
    expect(claudeMd).toContain('lazy-loaded');
    expect(claudeMd).toContain('Memory Inbox has non-canonical signals');
    expect(claudeMd).toContain('targetless candidates are not evidence for factual answers');
    expect(claudeMd).toMatch(/approval must\s+not call put_page/);
    expect(claudeMd).toContain('read_context');
    expect(claudeMd).toMatch(/both pointers,\s+not answer evidence/);
    expect(claudeMd).toMatch(/canonical evidence boundary before\s+factual claims/);
    expect(claudeMd).toContain('route_memory_writeback');
    expect(claudeMd).toContain('automatic canonical writeback exists');
    expect(claudeMd).toContain('assertion pipeline');
    expect(claudeMd).toContain('daily memory report is the primary review surface');

    expect(existsSync(join(tempHome, '.claude', 'scripts', 'hooks', 'stop-mbrain-check.sh'))).toBe(true);
    expect(existsSync(join(tempHome, '.claude', 'scripts', 'hooks', 'prompt-mbrain-context.sh'))).toBe(true);
    expect(existsSync(join(tempHome, '.claude', 'scripts', 'hooks', 'lib', 'mbrain-relevance.sh'))).toBe(true);
    expect(existsSync(join(tempHome, '.claude', 'mbrain-skip-dirs'))).toBe(true);

    const settings = JSON.parse(readFileSync(join(tempHome, '.claude', 'settings.json'), 'utf-8'));
    const stopHooks = settings?.hooks?.Stop ?? [];
    const mbrainHook = stopHooks.find((entry: any) => entry.id === 'stop:mbrain-check');

    expect(mbrainHook).toBeDefined();
    expect(mbrainHook.hooks[0].command).toBe('bash "$HOME/.claude/scripts/hooks/stop-mbrain-check.sh"');

    const promptHooks = settings?.hooks?.UserPromptSubmit ?? [];
    const mbrainPromptHook = promptHooks.find((entry: any) => entry.id === 'prompt:mbrain-context');

    expect(mbrainPromptHook).toBeDefined();
    expect(mbrainPromptHook.hooks[0].command).toBe('bash "$HOME/.claude/scripts/hooks/prompt-mbrain-context.sh"');
  });

  test('setup-agent --codex installs canonical retrieval rules into AGENTS.md', async () => {
    mkdirSync(join(tempHome, '.codex'), { recursive: true });

    const result = await runSetupAgent(['--codex', '--skip-mcp']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const agentsMd = readFileSync(join(tempHome, '.codex', 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('MBRAIN:RULES:START');
    expect(agentsMd).toContain('retrieve_context');
    expect(agentsMd).toContain('candidate_signals');
    expect(agentsMd).toContain('tool_search');
    expect(agentsMd).toContain('lazy-loaded');
    expect(agentsMd).toContain('Memory Inbox has non-canonical signals');
    expect(agentsMd).toContain('targetless candidates are not evidence for factual answers');
    expect(agentsMd).toMatch(/approval must\s+not call put_page/);
    expect(agentsMd).toContain('read_context');
    expect(agentsMd).toMatch(/both pointers,\s+not answer evidence/);
    expect(agentsMd).toMatch(/canonical evidence boundary before\s+factual claims/);
    expect(agentsMd).toContain('route_memory_writeback');
    expect(agentsMd).toContain('automatic canonical writeback exists');
    expect(agentsMd).toContain('assertion pipeline');
    expect(agentsMd).toContain('daily memory report is the primary review surface');
  });

  test('setup-agent --codex replaces previous same-file rules when rules version changes', async () => {
    mkdirSync(join(tempHome, '.codex'), { recursive: true });
    writeFileSync(
      join(tempHome, '.codex', 'AGENTS.md'),
      [
        '# Existing Local Rules',
        '',
        '<!-- MBRAIN:RULES:START -->',
        '<!-- mbrain-agent-rules-version: 0.5.7 -->',
        '## 3. Write Back Durable Knowledge',
        'Call put_page directly for durable facts.',
        '<!-- MBRAIN:RULES:END -->',
        '',
        'Keep this local footer.',
      ].join('\n'),
      'utf-8',
    );

    const result = await runSetupAgent(['--codex', '--skip-mcp']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Rules: updated');

    const agentsMd = readFileSync(join(tempHome, '.codex', 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('mbrain-agent-rules-version: 0.5.12');
    expect(agentsMd).toContain('Route Durable Writeback');
    expect(agentsMd).toContain('route_memory_writeback');
    expect(agentsMd).toContain('write_session_id');
    expect(agentsMd).toContain('expected_content_hash');
    expect(agentsMd).not.toContain('Call put_page directly for durable facts.');
    expect(agentsMd).toContain('Keep this local footer.');
  });

  test('setup-agent explains Claude hook behavior after installing it', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Claude Code MBrain hooks');
    expect(result.stdout).toContain('UserPromptSubmit');
    expect(result.stdout).toContain('non-blocking by default');
    expect(result.stdout).toContain('MBRAIN_STOP_HOOK_MODE=block');
    expect(result.stdout).toContain('MBRAIN_PROMPT_HOOK=0');
    expect(result.stdout).toContain('MBRAIN_STOP_HOOK=0');
    expect(result.stdout).toContain('~/.claude/mbrain-skip-dirs');
  });

  test('setup-agent registers Claude MCP at user scope by default', async () => {
    const result = await runSetupAgent(['--claude']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(tempHome, 'claude-mcp-add.log'), 'utf-8'))
      .toBe('mcp add -s user mbrain -- mbrain serve --tier core\n');
    expect(result.stdout).toContain('Claude MCP scope: user');
  });

  test('setup-agent does not treat project-local Claude MCP as user-scope registration', async () => {
    writeFileSync(join(tempHome, 'claude-mcp-list.txt'), 'mbrain: mbrain serve --tier core - connected\n', 'utf-8');
    writeFileSync(
      join(tempHome, 'claude-mcp-get.txt'),
      [
        'mbrain:',
        '  Scope: Local config (private to you in this project)',
        '  Type: stdio',
        '  Command: mbrain',
        '  Args: serve --tier core',
      ].join('\n'),
      'utf-8',
    );

    const result = await runSetupAgent(['--claude']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(tempHome, 'claude-mcp-add.log'), 'utf-8'))
      .toBe('mcp add -s user mbrain -- mbrain serve --tier core\n');
  });

  test('setup-agent does not treat user-scope Claude MCP as local registration', async () => {
    writeFileSync(join(tempHome, 'claude-mcp-list.txt'), 'mbrain: mbrain serve --tier core - connected\n', 'utf-8');
    writeFileSync(
      join(tempHome, 'claude-mcp-get.txt'),
      [
        'mbrain:',
        '  Scope: User config',
        '  Type: stdio',
        '  Command: mbrain',
        '  Args: serve --tier core',
      ].join('\n'),
      'utf-8',
    );

    const result = await runSetupAgent(['--claude', '--scope', 'local']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(tempHome, 'claude-mcp-add.log'), 'utf-8'))
      .toBe('mcp add -s local mbrain -- mbrain serve --tier core\n');
  });

  test('setup-agent supports explicit project-local Claude MCP scope', async () => {
    const result = await runSetupAgent(['--claude', '--scope', 'local']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(tempHome, 'claude-mcp-add.log'), 'utf-8'))
      .toBe('mcp add -s local mbrain -- mbrain serve --tier core\n');
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
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].id).toBe('prompt:mbrain-context');
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].id).toBe('sessionstart:mbrain-activation');
    // The proactive-recall hook script is installed and executable.
    const sessionStartScript = join(tempHome, '.claude', 'scripts', 'hooks', 'sessionstart-mbrain-activation.sh');
    expect(existsSync(sessionStartScript)).toBe(true);
    const sessionStartContent = readFileSync(sessionStartScript, 'utf-8');
    expect(sessionStartContent).toContain('agent-session-activate');
    expect(sessionStartContent).toContain('MBRAIN_SESSIONSTART_SCOPE:-work');
    expect(sessionStartContent).toContain('--scope "$SCOPE"');
  });

  test('setup-agent leaves a malformed settings.json untouched and warns instead of overwriting', async () => {
    const settingsPath = join(tempHome, '.claude', 'settings.json');
    const malformed = '{"permissions":{"defaultMode":"bypassPermissions"},"apiKey":"sk-keep"';
    writeFileSync(settingsPath, malformed, 'utf-8');

    const result = await runSetupAgent(['--claude', '--skip-mcp']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('not valid JSON');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(malformed);
    // Hook scripts still install even when settings registration is skipped.
    expect(existsSync(join(tempHome, '.claude', 'scripts', 'hooks', 'stop-mbrain-check.sh'))).toBe(true);
  });

  test('setup-agent leaves settings.json untouched and warns when hooks is not an object', async () => {
    const settingsPath = join(tempHome, '.claude', 'settings.json');
    const withArrayHooks = JSON.stringify({ permissions: { defaultMode: 'default' }, hooks: ['bogus'] }, null, 2);
    writeFileSync(settingsPath, withArrayHooks, 'utf-8');

    const result = await runSetupAgent(['--claude', '--skip-mcp']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('"hooks"');
    expect(result.stderr).toContain('not an object');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(withArrayHooks);
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

  test('installed Claude stop hook capture mode backgrounds an mbrain agent-session capture', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const transcriptPath = join(tempHome, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [
        '{"message":{"role":"user","content":"remember: I prefer concise replies"}}',
        '{"message":{"role":"assistant","content":"Noted."}}',
      ].join('\n'),
      'utf-8',
    );

    const invocationLog = join(tempHome, 'mbrain-capture-invocations.log');
    writeFileSync(
      join(tempBin, 'mbrain'),
      `#!/bin/sh\necho "$@" >> "${invocationLog}"\nexit 0\n`,
      'utf-8',
    );
    Bun.spawnSync(['chmod', '+x', join(tempBin, 'mbrain')]);

    const payload = JSON.stringify({
      session_id: 's-capture',
      transcript_path: transcriptPath,
      stop_hook_active: false,
    });
    const hook = await runInstalledHook(payload, { env: { MBRAIN_STOP_HOOK_MODE: 'capture' } });

    expect(hook.exitCode).toBe(0);
    expect(hook.stdout).toBe('');

    // The capture is backgrounded; give it a moment to land.
    let invocations = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (existsSync(invocationLog)) {
        invocations = readFileSync(invocationLog, 'utf-8');
        if (invocations.includes('agent-session')) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(invocations).toContain('agent-session capture');
    expect(invocations).toContain(`--transcript-path ${transcriptPath}`);
    expect(invocations).toContain('--session-id s-capture');
    expect(invocations).toContain('--apply --write-mode candidate_only');

    const log = readFileSync(join(tempHome, '.claude', 'logs', 'mbrain-stop-hook.log'), 'utf-8');
    expect(log).toContain('capture');
    expect(log).toContain('backgrounded');
  });

  test('installed Claude stop hook capture mode skips when the transcript is missing', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const payload = JSON.stringify({
      session_id: 's-missing',
      transcript_path: join(tempHome, 'does-not-exist.jsonl'),
      stop_hook_active: false,
    });
    const hook = await runInstalledHook(payload, { env: { MBRAIN_STOP_HOOK_MODE: 'capture' } });

    expect(hook.exitCode).toBe(0);
    expect(hook.stdout).toBe('');
    const log = readFileSync(join(tempHome, '.claude', 'logs', 'mbrain-stop-hook.log'), 'utf-8');
    expect(log).toContain('capture-skip');
    expect(log).toContain('transcript-missing');
  });

  test('installed Claude stop hook capture mode respects the kill switch', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const payload = '{"session_id":"s-kill","transcript_path":"/tmp/x.jsonl","stop_hook_active":false}';
    const hook = await runInstalledHook(payload, {
      env: { MBRAIN_STOP_HOOK: '0', MBRAIN_STOP_HOOK_MODE: 'capture' },
    });

    expect(hook.exitCode).toBe(0);
    const log = readFileSync(join(tempHome, '.claude', 'logs', 'mbrain-stop-hook.log'), 'utf-8');
    expect(log).toContain('skip');
  });

  test('installed Claude stop hook stays silent by default for a relevant session', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const hook = await runInstalledHook('{"session_id":"s1","stop_hook_active":false}');

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toBe('');

    // Session id resolution needs jq; the silent decision must be logged either way.
    const log = readFileSync(join(tempHome, '.claude', 'logs', 'mbrain-stop-hook.log'), 'utf-8');
    expect(log).toContain('silent');
  });

  test('installed Claude stop hook treats unknown mode values as silent and logs them', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const hook = await runInstalledHook('{"session_id":"s1","stop_hook_active":false}', {
      env: { MBRAIN_STOP_HOOK_MODE: 'blokc' },
    });

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toBe('');

    const log = readFileSync(join(tempHome, '.claude', 'logs', 'mbrain-stop-hook.log'), 'utf-8');
    expect(log).toContain('unknown-mode');
    expect(log).toContain('MBRAIN_STOP_HOOK_MODE=blokc');
  });

  test('installed Claude stop hook emits a block decision in block mode', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const hook = await runInstalledHook('{"session_id":"s1","stop_hook_active":false}', {
      env: { MBRAIN_STOP_HOOK_MODE: 'block' },
    });

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toContain('"decision":"block"');
    expect(JSON.parse(hook.stdout).reason).toBe(conciseStopHookReason);
    expect(hook.stdout).not.toContain('Claude Code may label this as');
    expect(hook.stdout).not.toContain('Do not write to MBrain just because this hook fired');
    expect(hook.stdout).not.toContain('mbrain write check');
  });

  test('installed Claude stop hook emits its block decision when jq is unavailable', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const jqPath = join(tempBin, 'jq');
    writeFileSync(jqPath, '#!/bin/sh\nexit 127\n', 'utf-8');
    Bun.spawnSync(['chmod', '+x', jqPath]);

    const hook = await runInstalledHook('{"session_id":"s1","stop_hook_active":false}', {
      env: { MBRAIN_STOP_HOOK_MODE: 'block' },
    });

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(JSON.parse(hook.stdout)).toEqual({
      decision: 'block',
      reason: conciseStopHookReason,
    });
  });

  test('installed Claude hook preserves the re-entry guard when jq is unavailable', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const jqPath = join(tempBin, 'jq');
    writeFileSync(jqPath, '#!/bin/sh\nexit 127\n', 'utf-8');
    Bun.spawnSync(['chmod', '+x', jqPath]);

    const payload = '{"session_id":"s1","stop_hook_active":true}';
    const hook = await runInstalledHook(payload);

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toBe('');
  });

  test('installed Claude hook passes through when the mbrain stop hook kill switch is disabled', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const payload = '{"session_id":"s2","stop_hook_active":false}';
    const hook = await runInstalledHook(payload, { env: { MBRAIN_STOP_HOOK: '0' } });

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toBe('');
  });

  test('installed Claude hook passes through when mbrain is not on PATH', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const payload = '{"session_id":"s3","stop_hook_active":false}';
    const hook = await runInstalledHook(payload, {
      env: { PATH: restrictedPathWithoutMbrain() },
    });

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toBe('');
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
    expect(proc.stdout).toBe('');
  });

  test('installed Claude hook passes through on stop hook re-entry', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const payload = '{"session_id":"s5","stop_hook_active":true}';
    const hook = await runInstalledHook(payload);

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toBe('');
  });

  test('setup-agent does not duplicate the Claude hook registrations on repeat runs', async () => {
    expect((await runSetupAgent(['--claude', '--skip-mcp'])).exitCode).toBe(0);
    expect((await runSetupAgent(['--claude', '--skip-mcp'])).exitCode).toBe(0);

    const settings = JSON.parse(readFileSync(join(tempHome, '.claude', 'settings.json'), 'utf-8'));
    const stopHooks = settings?.hooks?.Stop ?? [];
    const mbrainHooks = stopHooks.filter((entry: any) => entry.id === 'stop:mbrain-check');

    expect(mbrainHooks).toHaveLength(1);

    const promptHooks = settings?.hooks?.UserPromptSubmit ?? [];
    const mbrainPromptHooks = promptHooks.filter((entry: any) => entry.id === 'prompt:mbrain-context');

    expect(mbrainPromptHooks).toHaveLength(1);
  });

  test('setup-agent preserves user-edited mbrain-skip-dirs on repeat runs', async () => {
    expect((await runSetupAgent(['--claude', '--skip-mcp'])).exitCode).toBe(0);

    const skipDirsPath = join(tempHome, '.claude', 'mbrain-skip-dirs');
    writeFileSync(skipDirsPath, `${readFileSync(skipDirsPath, 'utf-8')}/keep-this-user-path\n`, 'utf-8');

    expect((await runSetupAgent(['--claude', '--skip-mcp'])).exitCode).toBe(0);

    expect(readFileSync(skipDirsPath, 'utf-8')).toContain('/keep-this-user-path');
  });

  test('installed Claude stop hook logs block decisions to ~/.claude/logs/mbrain-stop-hook.log', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const hook = await runInstalledHook('{"session_id":"s6","stop_hook_active":false}', {
      env: { MBRAIN_STOP_HOOK_MODE: 'block' },
    });
    expect(hook.exitCode).toBe(0);

    const logPath = join(tempHome, '.claude', 'logs', 'mbrain-stop-hook.log');
    expect(existsSync(logPath)).toBe(true);

    // Session id resolution needs jq; the block decision must be logged either way.
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('block');
  });

  test('installed Claude prompt hook injects retrieval context for a relevant prompt', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const hook = await runInstalledHook('{"session_id":"p1","prompt":"who is acme corp?"}', {
      script: 'prompt-mbrain-context.sh',
    });

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');

    const output = JSON.parse(hook.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(output.hookSpecificOutput.additionalContext).toContain('retrieve_context');
    expect(output.hookSpecificOutput.additionalContext).toContain('read_context');
    expect(output.hookSpecificOutput.additionalContext).toContain('tool_search');
    expect(output.hookSpecificOutput.additionalContext).toContain('route_memory_writeback');
    expect(output.decision).toBeUndefined();

    const log = readFileSync(join(tempHome, '.claude', 'logs', 'mbrain-prompt-hook.log'), 'utf-8');
    expect(log).toContain('inject');
  });

  test('installed Claude prompt hook still injects context when jq is unavailable', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const jqPath = join(tempBin, 'jq');
    writeFileSync(jqPath, '#!/bin/sh\nexit 127\n', 'utf-8');
    Bun.spawnSync(['chmod', '+x', jqPath]);

    const hook = await runInstalledHook('{"session_id":"p5","prompt":"who is acme?"}', {
      script: 'prompt-mbrain-context.sh',
    });

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');

    const output = JSON.parse(hook.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(output.hookSpecificOutput.additionalContext).toContain('retrieve_context');
  });

  test('installed Claude prompt hook prints nothing when disabled by kill switch', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const hook = await runInstalledHook('{"session_id":"p2","prompt":"hello"}', {
      script: 'prompt-mbrain-context.sh',
      env: { MBRAIN_PROMPT_HOOK: '0' },
    });

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    // UserPromptSubmit treats plain stdout as context, so a skip must be silent.
    expect(hook.stdout).toBe('');
  });

  test('installed Claude prompt hook prints nothing when mbrain is not on PATH', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const hook = await runInstalledHook('{"session_id":"p3","prompt":"hello"}', {
      script: 'prompt-mbrain-context.sh',
      env: { PATH: restrictedPathWithoutMbrain() },
    });

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toBe('');
  });

  test('installed Claude prompt hook prints nothing in a skipped directory', async () => {
    const result = await runSetupAgent(['--claude', '--skip-mcp']);
    expect(result.exitCode).toBe(0);

    const skippedDir = join(tempHome, 'skip-me');
    mkdirSync(skippedDir, { recursive: true });
    writeFileSync(join(tempHome, '.claude', 'mbrain-skip-dirs'), `${skippedDir}\n`, 'utf-8');

    const hook = await runInstalledHook('{"session_id":"p4","prompt":"hello"}', {
      script: 'prompt-mbrain-context.sh',
      cwd: skippedDir,
      env: {
        MBRAIN_SKIP_DIRS_FILE: join(tempHome, '.claude', 'mbrain-skip-dirs'),
      },
    });

    expect(hook.exitCode).toBe(0);
    expect(hook.stderr).toBe('');
    expect(hook.stdout).toBe('');
  });
});
