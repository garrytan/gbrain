import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hookEntryHash } from '../src/core/bootstrap/hooks.ts';
import { inspectTurnHook } from '../src/core/setup/turn-hook-check.ts';
import { syncTurnRuleHook, turnRuleHookYields } from '../src/core/setup/turn-hook.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { withEnv } from './helpers/with-env.ts';

// #9256: a native settings rewrite removes only _gbrain. The setup receipt
// still owns the command/type/timeout; health, install and runtime must agree.
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const CLI = resolve(import.meta.dir, '../src/cli.ts');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
function box() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-markerless-9256-'));
  roots.push(root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  const managed = join(root, 'managed');
  for (const dir of [join(home, '.claude'), join(project, '.claude'), managed]) mkdirSync(dir, { recursive: true });
  const settings = join(home, '.claude/settings.json');
  const receipt = join(home, '.gbrain-connection-claude-code-gbrain.json');
  const entry = { type: 'command', command: `/usr/local/bin/gbrain hook user-prompt`, timeout: 15 };
  const record = { connection: 'local-stdio', setup_receipt_version: 1, harness: 'claude-code', name: 'gbrain',
    status: 'installed', gbrain_home: join(home, '.gbrain'), scope: 'user',
    hooks: { settings_path: settings, owned: { UserPromptSubmit: hookEntryHash(entry) }, pending: {}, edited: {} } };
  const env = { HOME: home, GBRAIN_HOME: home, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: join(home, '.codex'),
    GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_HOOKS: undefined, GBRAIN_HOOK_LANE: undefined, GBRAIN_SOURCE: undefined,
    GBRAIN_SURFACE: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined, XDG_CONFIG_HOME: undefined, PATH: '/usr/bin:/bin' };
  const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2));
  const writeEntry = (path = settings, value: unknown = entry) => save(path, { hooks: { UserPromptSubmit: [{ hooks: [value] }] } });
  writeEntry(); save(receipt, record);
  return { root, home, project, managed, settings, receipt, entry, record, env, save, writeEntry };
}
type Box = ReturnType<typeof box>;
async function expectRecognition(b: Box, recognized: boolean, source = b.settings) {
  await withEnv(b.env, async () => {
    const state = inspectTurnHook('claude-code', { projectDir: b.project, managedDir: b.managed });
    expect(state.state).toBe(recognized ? 'wired' : 'missing');
    if (recognized) expect(state).toMatchObject({ via: 'setup', source, command: b.entry.command });
    expect(turnRuleHookYields('claude-code', b.project, b.managed)).toBe(recognized);
  });
}

describe('receipt-bound markerless setup hooks (#9256)', () => {
  test('owned and crash-pending hashes retain setup identity after marker loss', async () => {
    const b = box();
    await expectRecognition(b, true);
    b.record.status = 'prepared';
    b.record.hooks.pending = b.record.hooks.owned;
    b.record.hooks.owned = {} as typeof b.record.hooks.owned;
    b.save(b.receipt, b.record);
    await expectRecognition(b, true);
  });

  test('edited command, timeout or type is not adopted by the old receipt', async () => {
    const b = box();
    for (const change of [{ command: `${b.entry.command} # edited` }, { timeout: 16 }, { type: 'prompt' }]) {
      b.writeEntry(b.settings, { ...b.entry, ...change });
      await expectRecognition(b, false);
    }
    b.writeEntry();
    b.record.hooks.edited = b.record.hooks.owned;
    b.record.hooks.owned = {} as typeof b.record.hooks.owned;
    b.save(b.receipt, b.record);
    await expectRecognition(b, false);
  });

  test('runtime turn-rule yields to a markerless receipt-owned setup hook', async () => {
    const b = box();
    await withEnv(b.env, async () => {
      expect(turnRuleHookYields('claude-code', b.project, b.managed)).toBe(true);
    });
  });

  test('foreign, hosted, removed and malformed receipts do not certify a hook', async () => {
    const b = box();
    for (const change of [{ gbrain_home: join(b.root, 'other/.gbrain') }, { connection: 'hosted' }, { status: 'removed' }, { harness: 'codex' }]) {
      b.save(b.receipt, { ...b.record, ...change });
      await expectRecognition(b, false);
    }
    writeFileSync(b.receipt, '{broken');
    await expectRecognition(b, false);
    rmSync(b.receipt);
    await expectRecognition(b, false);
  });

  test('a receipt is bound to its settings file and UserPromptSubmit event', async () => {
    const b = box();
    b.save(b.receipt, { ...b.record, hooks: { ...b.record.hooks, owned: { SessionStart: hookEntryHash(b.entry) } } });
    await expectRecognition(b, false);
    b.save(b.receipt, b.record);
    b.save(b.settings, {});
    for (const path of [join(b.project, '.claude/settings.json'), join(b.project, '.claude/settings.local.json'), join(b.managed, 'managed-settings.json')]) {
      b.writeEntry(path);
      await expectRecognition(b, false);
      b.save(path, {});
    }
    const local = join(b.project, '.claude/settings.local.json');
    b.writeEntry(local);
    b.save(b.receipt, { ...b.record, scope: 'project', project_dir: b.project, hooks: { ...b.record.hooks, settings_path: local } });
    await expectRecognition(b, true, local);
    b.save(local, {});
    const committed = join(b.project, '.claude/settings.json');
    b.writeEntry(committed);
    b.save(b.receipt, { ...b.record, hooks: { ...b.record.hooks, settings_path: committed } });
    await expectRecognition(b, false);
  });

  test('turn-rule and skill-resolver lanes cannot acquire setup identity from a receipt', async () => {
    const b = box();
    const turn = { ...b.entry, command: `env GBRAIN_HOOK_LANE=turn-rule ${b.entry.command}` };
    b.writeEntry(b.settings, turn);
    b.save(b.receipt, { ...b.record, hooks: { ...b.record.hooks, owned: { UserPromptSubmit: hookEntryHash(turn) } } });
    await withEnv(b.env, async () => {
      expect(inspectTurnHook('claude-code', { managedDir: b.managed })).toMatchObject({ state: 'wired', via: 'turn-rule' });
      expect(turnRuleHookYields('claude-code', b.project, b.managed)).toBe(false);
    });
    const skill = { ...b.entry, command: `env GBRAIN_HOOK_LANE=skill-resolver ${b.entry.command}` };
    b.writeEntry(b.settings, skill);
    b.save(b.receipt, { ...b.record, hooks: { ...b.record.hooks, owned: { UserPromptSubmit: hookEntryHash(skill) } } });
    await expectRecognition(b, false);
  });

  test('real setup, doctor, idempotent re-setup and both hook commands agree after a native-style rewrite', async () => {
    const b = box();
    rmSync(b.receipt); b.save(b.settings, {});
    const bin = join(b.root, 'gbrain');
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
    chmodSync(bin, 0o755);
    const setup = (args: string[]) => runCli(['setup', 'claude-code', '--gbrain-bin', bin, '--json', ...args], { env: b.env, cwd: b.project, timeoutMs: 90_000 });
    const first = await setup(['--capture', '--yes']);
    expect(first.exitCode).toBe(0);
    const settings = readJson(b.settings);
    for (const groups of Object.values(settings.hooks) as Array<{ hooks: Record<string, unknown>[] }[]>) {
      for (const group of groups) for (const entry of group.hooks) delete entry._gbrain;
    }
    b.save(b.settings, settings);
    const before = [readFileSync(b.settings, 'utf8'), readFileSync(b.receipt, 'utf8')];
    const doctor = await runCli(['doctor', '--only', 'harness_wiring', '--json'], { env: b.env, cwd: b.project });
    const check = JSON.parse(doctor.stdout).checks.find((c: { name: string }) => c.name === 'harness_wiring');
    expect(check.details.turn_hooks).toContainEqual(expect.objectContaining({ harness: 'claude-code', state: 'wired', via: 'setup' }));
    const second = await setup(['--capture', '--yes']);
    expect(second.exitCode).toBe(0);
    expect([readFileSync(b.settings, 'utf8'), readFileSync(b.receipt, 'utf8')]).toEqual(before);
    const repair = await setup(['--instructions-only', '--surface', 'verbs']);
    expect(repair.exitCode).toBe(0);
    expect(JSON.parse(repair.stdout).turn_hook.action).toBe('skip');
    expect(readJson(b.settings).hooks.UserPromptSubmit.flatMap((g: { hooks: unknown[] }) => g.hooks)).toHaveLength(1);
    // Also recover a duplicate turn-rule installed before this fix.
    await withEnv(b.env, async () => {
      expect(syncTurnRuleHook({ harness: 'claude-code', gbrainBin: bin, gbrainHome: b.home, rerun: '' }).action).toBe('write');
    });
    const entries = readJson(b.settings).hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) => g.hooks) as { command: string }[];
    expect(entries).toHaveLength(2);
    const outputs: string[] = [];
    for (const entry of entries) {
      const env = keylessBrainEnv(process.env, b.home, { ...b.env, GBRAIN_SKIP_STARTUP_HOOKS: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined });
      const child = Bun.spawn(['sh', '-c', entry.command], { cwd: b.project, env, stdin: Buffer.from(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hello', session_id: 'markerless-9256' })), stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr).toBe(0);
      outputs.push(stdout);
    }
    expect(outputs.map((s) => (s.match(/GBrain: before answering/g) ?? []).length)).toEqual([1, 0]);
  }, 180_000);
});
