import { afterEach, describe, expect, test } from 'bun:test';
// Serial: each case remaps process-global HOME/config roots for host writers.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { crossHostHookTargets, installCrossHostHook } from '../src/core/bootstrap/cross-host-hooks.ts';
import { runBootstrap } from '../src/commands/bootstrap.ts';
import { CROSS_HOST_HOOK_HARNESSES, GBRAIN_MULTI_HOST_HOOK_MARKER_VALUE } from '../src/core/bootstrap/host-specs.ts';
import { TRAECLI_HOOK_BLOCK_BEGIN } from '../src/core/bootstrap/traecli-hooks-toml.ts';

const BIN = '/opt/gbrain/bin/gbrain';
let root: string | null = null;
let saved: Record<string, string | undefined> = {};

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function legacy(harness: string, subcommand: string): string {
  return 'GBRAIN_BRAIN_ID=host GBRAIN_SOURCE=default GBRAIN_HARNESS=' + harness +
    " /opt/homebrew/bin/bun '/tmp/gbrain/src/cli.ts' hook " + subcommand + ' --harness ' + harness;
}

function setup(): void {
  saved = {};
  for (const key of ['HOME', 'GBRAIN_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) saved[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), 'gbrain-cross-host-'));
  process.env.HOME = root;
  process.env.GBRAIN_HOME = root;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
}

afterEach(() => {
  for (const key of ['HOME', 'GBRAIN_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function options(dryRun: boolean) {
  return { workspaceDir: root!, gbrainBin: BIN, sourceId: 'default', brainId: 'host', repair: true, dryRun };
}

function ownedCount(path: string, event: string): number {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as any;
  return (parsed.hooks?.[event] ?? []).flatMap((group: any) => group.hooks ?? [])
    .filter((entry: any) => entry._gbrain === GBRAIN_MULTI_HOST_HOOK_MARKER_VALUE).length;
}

describe('cross-host lifecycle hook repair', () => {
  test('all resolves five hosts and dry-run writes no target file', () => {
    setup();
    const targets = crossHostHookTargets('all', root!);
    expect(targets.map((target) => target.harness)).toEqual([...CROSS_HOST_HOOK_HARNESSES]);
    for (const target of targets) installCrossHostHook(target, options(true));
    for (const target of targets) expect(existsSync(target.path)).toBe(false);
  });

  test('repair adopts legacy entries, preserves foreign hooks, and is idempotent', () => {
    setup();
    let targets = crossHostHookTargets('all', root!);
    for (const target of targets) {
      if (target.harness === 'traecli') {
        write(target.path, [
          '[features]', 'hooks = true', '',
          '[[hooks.Notification]]', '[[hooks.Notification.hooks]]',
          'type = "command"', 'command = "foreign.sh"', '',
          '[[hooks.UserPromptSubmit]]', '[[hooks.UserPromptSubmit.hooks]]',
          'type = "command"', 'command = ' + JSON.stringify(legacy('traecli', 'user-prompt')),
          'timeout = 2', '',
        ].join('\n'));
      } else if (target.harness === 'claude-code') {
        const local = join(dirname(target.path), 'settings.local.json');
        write(local, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [
          { type: 'command', command: legacy('claude-code', 'user-prompt'), timeout: 3 },
          { type: 'command', command: 'foreign.sh', timeout: 9 },
        ] }] } }, null, 2));
      } else {
        write(target.path, JSON.stringify({ version: 1, hooks: { UserPromptSubmit: [{ hooks: [
          { type: 'command', command: legacy(target.harness, 'user-prompt'), timeout: 2, _gbrain: 'manual-v1' },
          { type: 'command', command: 'foreign.sh', timeout: 9 },
        ] }] } }, null, 2));
      }
    }

    targets = crossHostHookTargets('all', root!);
    for (const target of targets) installCrossHostHook(target, options(false));
    const before = targets.map((target) => readFileSync(target.path, 'utf8'));
    for (const target of targets) installCrossHostHook(target, options(false));
    expect(targets.map((target) => readFileSync(target.path, 'utf8'))).toEqual(before);

    for (const target of targets) {
      const text = readFileSync(target.path, 'utf8');
      expect(text).toContain('foreign.sh');
      expect(text).not.toContain('manual-v1');
      expect(text).toContain('GBRAIN_BRAIN_ID=host');
      if (target.harness === 'traecli') {
        expect(text.split(TRAECLI_HOOK_BLOCK_BEGIN).length - 1).toBe(1);
        expect(text).not.toContain('timeout = 2');
      } else {
        expect(ownedCount(target.path, 'UserPromptSubmit')).toBe(1);
      }
    }
  });

  test('ambiguous legacy gbrain hook is refused without changing the file', () => {
    setup();
    const target = crossHostHookTargets('codex', root!)[0]!;
    const original = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{
      type: 'command', command: legacy('traecli', 'user-prompt'), _gbrain: 'manual-v1',
    }] }] } }, null, 2);
    write(target.path, original);
    expect(() => installCrossHostHook(target, options(false))).toThrow(/ambiguous gbrain hook/);
    expect(readFileSync(target.path, 'utf8')).toBe(original);
  });

  test('dispatcher dry-run works without agent.json when --source is explicit', async () => {
    setup();
    const originalLog = console.log;
    const originalError = console.error;
    let stdout = '';
    let stderr = '';
    console.log = (...args: unknown[]) => { stdout += args.map(String).join(' ') + '\n'; };
    console.error = (...args: unknown[]) => { stderr += args.map(String).join(' ') + '\n'; };
    try {
      const code = await runBootstrap([
        'hooks', '--harness', 'all', '--repair', '--dry-run', '--source', 'default', '--gbrain-bin', BIN,
      ]);
      expect(code).toBe(0);
      for (const harness of CROSS_HOST_HOOK_HARNESSES) expect(stdout).toContain(harness + ':');
      expect(stderr).toBe('');
      for (const target of crossHostHookTargets('all', root!)) expect(existsSync(target.path)).toBe(false);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  test('public CLI dry-run writes no gbrain state or hook target', () => {
    setup();
    const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
    const result = Bun.spawnSync([
      process.execPath, cli, 'bootstrap', 'hooks', '--harness', 'all', '--repair',
      '--dry-run', '--source', 'default', '--brain', 'host', '--gbrain-bin', BIN,
    ], {
      cwd: root!,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        HOME: root!,
        GBRAIN_HOME: root!,
        CLAUDE_CONFIG_DIR: undefined,
        CODEX_HOME: undefined,
        NODE_ENV: 'production',
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');
    expect(result.stdout.toString()).toContain('dry-run: machine-global lifecycle hooks only');
    expect(result.stdout.toString()).toContain('GBRAIN_BRAIN_ID=host');
    expect(existsSync(join(root!, '.gbrain'))).toBe(false);
    for (const target of crossHostHookTargets('all', root!)) expect(existsSync(target.path)).toBe(false);
  });

  test('dispatcher preflights all targets before the first write', async () => {
    setup();
    const targets = crossHostHookTargets('all', root!);
    const broken = targets.find((target) => target.harness === 'traecode-cn')!;
    write(broken.path, '{ broken json');
    const originalError = console.error;
    console.error = () => {};
    try {
      const code = await runBootstrap([
        'hooks', '--harness', 'all', '--repair', '--source', 'default', '--gbrain-bin', BIN,
      ]);
      expect(code).toBe(1);
    } finally {
      console.error = originalError;
    }
    for (const target of targets.slice(0, -1)) expect(existsSync(target.path)).toBe(false);
    expect(readFileSync(broken.path, 'utf8')).toBe('{ broken json');
  });
});
