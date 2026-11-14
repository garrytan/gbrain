/**
 * #8449: a Windows gbrain install (drive-letter paths) gets the per-turn rule
 * hook. Claude Code runs hook commands through Git Bash on Windows, so the
 * command names the launcher and binary in Git Bash's /c/... form, which the
 * POSIX launcher's own absolute-path check accepts; gbrain maps that form back
 * to the native path when it reads the launcher file or the session directory. Codex runs hooks on
 * Windows without a POSIX shell, so it still gets the printed step. Paths are
 * passed in, so this runs the same on every platform.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { claudeTurnRuleCommand, isTurnRuleEntry, syncTurnRuleHook } from '../src/core/setup/turn-hook.ts';
import { captureHookSessionCwd, hookLauncherInCommand, hookSessionCwd, hookShellPath, isHookLauncherPath, shellWords } from '../src/core/setup/hook-launcher.ts';
import { withEnv } from './helpers/with-env.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const winHome = win32.join('C:\\', 'Users', 'alice example');
const gbrainBin = win32.join(winHome, '.bun', 'bin', 'gbrain.exe');
const winLauncher = win32.join(winHome, '.gbrain', 'hook-launcher', 'gbrain-hook');

describe('per-turn rule hook with Windows drive-letter paths (#8449)', () => {
  test('claude-code: a drive-letter --gbrain-bin is accepted and the command names Git Bash paths', () => {
    const settings = join(mkdtempSync(join(tmpdir(), 'gbrain-win-hook-')), 'settings.json');
    roots.push(settings.slice(0, -'/settings.json'.length));
    const o = syncTurnRuleHook({ harness: 'claude-code', gbrainBin, paths: { claudeSettings: settings, hookLauncher: winLauncher }, dryRun: true, rerun: 'gbrain setup claude-code --instructions-only' });
    expect(o.action).toBe('write');
    const command = claudeTurnRuleCommand(gbrainBin, undefined, winLauncher);
    expect(shellWords(command)).toEqual(['env', 'GBRAIN_HOOK_LANE=turn-rule', '/c/Users/alice example/.gbrain/hook-launcher/gbrain-hook', '/c/Users/alice example/.bun/bin/gbrain.exe', 'hook', 'user-prompt']);
    expect(isTurnRuleEntry({ type: 'command', command })).toBe(true);
  });

  test('the launcher is found in that command, and read at its native path on Windows only', () => {
    const command = claudeTurnRuleCommand(gbrainBin, undefined, winLauncher);
    expect(hookLauncherInCommand(command, 'win32')).toBe(winLauncher);
    expect(hookLauncherInCommand(command, 'linux')).toBe('/c/Users/alice example/.gbrain/hook-launcher/gbrain-hook');
    expect(isHookLauncherPath(winLauncher, 'win32')).toBe(true);
    expect(isHookLauncherPath('C:/Users/alice example/.gbrain/hook-launcher/gbrain-hook', 'win32')).toBe(true);
    expect(isHookLauncherPath('.gbrain\\hook-launcher\\gbrain-hook', 'win32')).toBe(false);
    expect(isHookLauncherPath(winLauncher, 'linux')).toBe(false);
    expect(isHookLauncherPath('\\x\\hook-launcher\\gbrain-hook', 'linux')).toBe(false);
    expect(hookShellPath('/home/alice-example/.gbrain/hook-launcher/gbrain-hook')).toBe('/home/alice-example/.gbrain/hook-launcher/gbrain-hook');
  });

  test('the session directory Git Bash records (/c/...) is read back as the native Windows path', async () => {
    await withEnv({ GBRAIN_HOOK_CWD: '/c/Users/alice example/project' }, async () => {
      captureHookSessionCwd('win32');
      expect(process.env.GBRAIN_HOOK_CWD).toBeUndefined();
      expect(hookSessionCwd()).toBe('C:\\Users\\alice example\\project');
    });
    await withEnv({ GBRAIN_HOOK_CWD: 'relative\\dir' }, async () => {
      captureHookSessionCwd('win32');
      expect(hookSessionCwd()).toBe(process.cwd());
    });
  });

  test('codex: a drive-letter binary prints the step with the reason, not "no absolute gbrain binary"', () => {
    const o = syncTurnRuleHook({ harness: 'codex', gbrainBin, paths: { codexHooks: join(tmpdir(), 'gbrain-win-no-such', 'hooks.json'), codexConfig: join(tmpdir(), 'gbrain-win-no-such', 'config.toml'), hookLauncher: winLauncher }, dryRun: true, rerun: 'gbrain setup codex --instructions-only' });
    expect(o.action).toBe('print');
    expect(o.detail).toContain('POSIX shell');
    expect(o.detail).not.toContain('no absolute gbrain binary');
  });

  test('a relative binary is still refused', () => {
    const o = syncTurnRuleHook({ harness: 'claude-code', gbrainBin: 'gbrain.exe', paths: { hookLauncher: winLauncher }, dryRun: true, rerun: 'x' });
    expect(o.detail).toContain('no absolute gbrain binary');
  });
});
