import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookLauncherFix, hookLauncherProblems } from '../src/commands/doctor/checks/harness-wiring.ts';
import { ownedEntryFingerprint } from '../src/core/bootstrap/adopted-connections.ts';
import { codexHookTrustHash } from '../src/core/bootstrap/codex-hooks.ts';
import { appendCodexTomlTable, removeCodexTomlTable } from '../src/core/bootstrap/codex-toml.ts';
import { hookEntryHash } from '../src/core/bootstrap/hooks.ts';
import { harnessWiringEntry } from '../src/core/readiness.ts';
import { applyClaudeSetup, readSetupReceipt } from '../src/core/setup/claude-code.ts';
import { refreshHookLaunchers } from '../src/core/setup/hook-launcher-refresh.ts';
import { launcherLaneFindings, setupRerunArgv } from '../src/core/setup/launcher-lanes.ts';
import { hookLauncherProblem, inspectTurnHook } from '../src/core/setup/turn-hook-check.ts';
import { syncTurnRuleHook, isTurnRuleEntry } from '../src/core/setup/turn-hook.ts';
import { withEnv } from './helpers/with-env.ts';
import { type Box, CLEAN, claudeJson, codexReceipt, codexToml, createSetupFixture, entries, hooksJson, launcher, readJson, receipt, settings, setup, setupGroups } from './helpers/setup-fixture.ts';

const { box, cleanup } = createSetupFixture();
afterAll(cleanup);

describe('hooks written before the hook launcher (#8424): the next setup and post-upgrade move them', () => {
  const env = (b: Box) => ({ ...CLEAN, HOME: b.home, GBRAIN_HOME: b.gbrainHome, CODEX_HOME: join(b.home, '.codex'), XDG_CONFIG_HOME: undefined });
  const viaLauncher = (b: Box, commands: string[]) => commands.length > 0 && commands.every((c) => c.includes(`${launcher(b)} ${b.bin} hook`));

  /** Rewrite setup's Claude Code entries and receipt hashes to what setup wrote before the launcher. */
  function downgradeClaude(b: Box, stripMarker = false): void {
    const s = readJson(settings(b));
    const r = readJson(receipt(b));
    for (const [event, groups] of Object.entries(s.hooks as Record<string, any[]>)) {
      for (const e of groups.flatMap((g) => g.hooks)) {
        if (e._gbrain !== 'setup-v1') continue;
        e.command = e.command.replace(` ${launcher(b)} `, ' ');
        r.hooks.owned[event] = hookEntryHash(e);
        if (stripMarker) delete e._gbrain;
      }
    }
    writeFileSync(settings(b), JSON.stringify(s, null, 2));
    writeFileSync(receipt(b), JSON.stringify(r, null, 2));
  }

  /** The same for Codex: hooks.json groups, their trust tables and the receipt's fingerprints. */
  function downgradeCodex(b: Box): void {
    const hooks = readJson(hooksJson(b));
    const r = readJson(codexReceipt(b));
    const states: Record<string, string> = { SessionStart: 'session_start', UserPromptSubmit: 'user_prompt_submit' };
    for (const event of Object.keys(states)) {
      (hooks.hooks[event] as any[]).forEach((group, index) => {
        const h = group.hooks[0];
        if (!h.command.includes('GBRAIN_HOOK_LANE=setup')) return;
        h.command = h.command.replace(` ${launcher(b)} `, ' ');
        r.hooks.owned[event] = ownedEntryFingerprint(group);
        const key = `${hooksJson(b)}:${states[event]}:${index}:0`;
        const table = { trusted_hash: codexHookTrustHash(states[event]!, h.command, h.timeout) };
        removeCodexTomlTable(codexToml(b), ['hooks', 'state', key]);
        appendCodexTomlTable(codexToml(b), ['hooks', 'state', key], table, 'gbrain setup: trust');
        r.trust.owned[event] = { key, hash: ownedEntryFingerprint({ key, table }) };
      });
    }
    writeFileSync(hooksJson(b), JSON.stringify(hooks, null, 2));
    writeFileSync(codexReceipt(b), JSON.stringify(r, null, 2));
  }
  const codexSetupCommands = (b: Box) => ['SessionStart', 'UserPromptSubmit'].flatMap((e) => setupGroups(b, e).map((g: any) => g.hooks[0].command as string));

  test('claude-code: doctor flags them, a setup re-run rewrites them, and so does post-upgrade', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--json'])).exitCode).toBe(0);
    const claudeCommands = () => ['SessionStart', 'UserPromptSubmit'].flatMap((e) => entries(b, e).map((x) => x.command as string));
    expect(viaLauncher(b, claudeCommands())).toBe(true);
    downgradeClaude(b);
    await withEnv(env(b), async () => { expect(hookLauncherProblem('claude-code')).toMatchObject({ lane: 'setup', reason: 'session_cwd' }); });
    expect((await setup(b, ['claude-code', '--json'])).exitCode).toBe(0);
    expect(viaLauncher(b, claudeCommands())).toBe(true);

    downgradeClaude(b);
    await withEnv(env(b), async () => {
      const lines: string[] = [];
      await refreshHookLaunchers((l) => lines.push(l));
      expect(lines.join('\n')).toContain("gbrain setup's claude-code hooks");
      expect(hookLauncherProblem('claude-code')).toBeNull();
    });
    expect(viaLauncher(b, claudeCommands())).toBe(true);
    expect((await setup(b, ['claude-code', '--json'])).doc.steps.map((s: any) => s.action)).toEqual(['keep', 'keep', 'keep']);
  });

  test('claude-code: entries Claude Code rewrote without the _gbrain marker are still found by receipt hash', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--json'])).exitCode).toBe(0);
    downgradeClaude(b, true);
    const commands = () => ['SessionStart', 'UserPromptSubmit'].flatMap((e) => entries(b, e).map((x) => x.command as string));
    expect(entries(b, 'UserPromptSubmit')[0]._gbrain).toBeUndefined();
    await withEnv(env(b), async () => {
      expect(hookLauncherProblem('claude-code')).toMatchObject({ lane: 'setup', reason: 'session_cwd' });
      await refreshHookLaunchers(() => {});
      expect(hookLauncherProblem('claude-code')).toBeNull();
    });
    expect(viaLauncher(b, commands())).toBe(true);
    expect(['SessionStart', 'UserPromptSubmit'].map((e) => entries(b, e).length)).toEqual([1, 1]);
  });

  test('claude-code: a pre-launcher hook the user edited is kept, post-upgrade says so, and doctor hands it to the user', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--json'])).exitCode).toBe(0);
    downgradeClaude(b);
    const s = readJson(settings(b));
    const mine = (s.hooks.UserPromptSubmit as any[]).flatMap((g) => g.hooks).find((e) => e._gbrain === 'setup-v1');
    mine.command = `${mine.command} # mine`;
    writeFileSync(settings(b), JSON.stringify(s, null, 2));
    await withEnv(env(b), async () => {
      const lines: string[] = [];
      await refreshHookLaunchers((l) => lines.push(l));
      expect(lines.join('\n')).toContain('UserPromptSubmit hook');
      expect(lines.join('\n')).toContain('was edited after setup wrote it');
      expect(lines.join('\n')).not.toContain('now start gbrain from its own directory');
      const problem = hookLauncherProblem('claude-code');
      expect(problem).toMatchObject({ lane: 'setup', reason: 'session_cwd', edited: true });
      const fix = hookLauncherFix(problem!);
      expect(fix.actor).toBe('user');
      expect(fix.user_message).toContain('Remove or rewrite that entry');
    });
    expect(entries(b, 'UserPromptSubmit').find((e) => e._gbrain === 'setup-v1').command).toBe(mine.command);
    expect(entries(b, 'SessionStart').every((e) => e.command.includes(launcher(b)))).toBe(true);
  });

  test('claude-code: the hook rewrite refuses under the lock when the MCP entry is no longer setup\'s, and writes nothing', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--json'])).exitCode).toBe(0);
    downgradeClaude(b);
    const r = readSetupReceipt(receipt(b)).setup!;
    const cfg = readJson(claudeJson(b));
    cfg.mcpServers.gbrain = { type: 'http', url: 'https://new-brain.example/mcp' };
    writeFileSync(claudeJson(b), JSON.stringify(cfg, null, 2));
    const before = { settings: readFileSync(settings(b), 'utf8'), config: readFileSync(claudeJson(b), 'utf8') };
    await withEnv(env(b), async () => {
      const plan = { name: r.name, scope: r.scope, launcher: r.launcher, brainHome: r.gbrain_home, sourceId: r.source_id, surface: r.surface, advertise: r.advertise ?? null, events: Object.keys(r.hooks.owned) as any };
      await expect(applyClaudeSetup(plan, r.consent, { pluginOwner: null, brainCreated: false, refreshOf: r })).rejects.toThrow('MCP entry changed');
    });
    expect({ settings: readFileSync(settings(b), 'utf8'), config: readFileSync(claudeJson(b), 'utf8') }).toEqual(before);
  });

  test('claude-code: the hook rewrite refuses under the lock when another install replaced the receipt it planned from, and writes nothing', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--json'])).exitCode).toBe(0);
    downgradeClaude(b);
    // post-upgrade read this receipt; before it took the lock, the name was removed and installed again, so the entry is the new install's and still setup's.
    const planned = readSetupReceipt(receipt(b)).setup!;
    const replaced = { ...planned, consent: { ...planned.consent, recorded_at: '2026-01-01T00:00:00.000Z' } };
    writeFileSync(receipt(b), JSON.stringify(replaced, null, 2));
    const before = { settings: readFileSync(settings(b), 'utf8'), config: readFileSync(claudeJson(b), 'utf8'), receipt: readFileSync(receipt(b), 'utf8') };
    await withEnv(env(b), async () => {
      const plan = { name: planned.name, scope: planned.scope, launcher: planned.launcher, brainHome: planned.gbrain_home, sourceId: planned.source_id, surface: planned.surface, advertise: planned.advertise ?? null, events: Object.keys(planned.hooks.owned) as any };
      await expect(applyClaudeSetup(plan, planned.consent, { pluginOwner: null, brainCreated: false, refreshOf: planned })).rejects.toThrow('setup receipt changed');
    });
    expect({ settings: readFileSync(settings(b), 'utf8'), config: readFileSync(claudeJson(b), 'utf8'), receipt: readFileSync(receipt(b), 'utf8') }).toEqual(before);
  });

  test('claude-code: --instructions-only moves a pre-launcher turn-rule entry that sits beside setup hooks', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--json'])).exitCode).toBe(0);
    await withEnv(env(b), async () => {
      expect(syncTurnRuleHook({ harness: 'claude-code', gbrainBin: b.bin, gbrainHome: b.gbrainHome, rerun: 'gbrain setup claude-code --instructions-only' }).action).toBe('write');
    });
    const s = readJson(settings(b));
    const turnRule = (s.hooks.UserPromptSubmit as any[]).flatMap((g) => g.hooks).find((e) => isTurnRuleEntry(e));
    turnRule.command = turnRule.command.replace(` ${launcher(b)} `, ' ');
    writeFileSync(settings(b), JSON.stringify(s, null, 2));
    await withEnv(env(b), async () => { expect(hookLauncherProblem('claude-code')).toMatchObject({ lane: 'turn-rule', reason: 'session_cwd' }); });
    expect((await setup(b, ['claude-code', '--instructions-only', '--json'])).exitCode).toBe(0);
    const after = entries(b, 'UserPromptSubmit').filter((e) => isTurnRuleEntry(e));
    expect(after).toHaveLength(1);
    expect(after[0].command).toContain(`${launcher(b)} ${b.bin} hook`);
    await withEnv(env(b), async () => { expect(hookLauncherProblem('claude-code')).toBeNull(); });
  });

  test('codex: post-upgrade names the setup rerun and writes nothing; setup rewrites them with matching trust', async () => {
    const b = box();
    expect((await setup(b, ['codex', '--json'])).exitCode).toBe(0);
    downgradeCodex(b);
    expect(viaLauncher(b, codexSetupCommands(b))).toBe(false);
    const before = { hooks: readFileSync(hooksJson(b), 'utf8'), config: readFileSync(codexToml(b), 'utf8') };
    await withEnv(env(b), async () => {
      expect(hookLauncherProblem('codex')).toMatchObject({ lane: 'setup', reason: 'session_cwd' });
      const lines: string[] = [];
      await refreshHookLaunchers((l) => lines.push(l));
      expect(lines.join('\n')).toContain("gbrain setup's codex hooks");
      expect(lines.join('\n')).toContain(`run gbrain setup codex --gbrain-bin ${b.bin} to rewrite them`);
      expect(hookLauncherProblem('codex')).toMatchObject({ lane: 'setup', reason: 'session_cwd' });
    });
    expect({ hooks: readFileSync(hooksJson(b), 'utf8'), config: readFileSync(codexToml(b), 'utf8') }).toEqual(before);
    expect((await setup(b, ['codex', '--json'])).exitCode).toBe(0);
    expect(viaLauncher(b, codexSetupCommands(b))).toBe(true);
    await withEnv(env(b), async () => {
      expect(hookLauncherProblem('codex')).toBeNull();
      expect(inspectTurnHook('codex')).toMatchObject({ state: 'wired', via: 'setup' });
    });
    expect((await setup(b, ['codex', '--json'])).doc.steps.map((s: any) => s.action)).toEqual(['keep', 'keep', 'keep', 'keep']);
  });

  test('codex: post-upgrade grants no trust to setup groups Codex does not run', async () => {
    const b = box();
    expect((await setup(b, ['codex', '--json'])).exitCode).toBe(0);
    downgradeCodex(b);
    for (const rec of Object.values(readJson(codexReceipt(b)).trust.owned) as Array<{ key: string }>) removeCodexTomlTable(codexToml(b), ['hooks', 'state', rec.key]);
    const before = { hooks: readFileSync(hooksJson(b), 'utf8'), config: readFileSync(codexToml(b), 'utf8') };
    await withEnv(env(b), async () => {
      const lines: string[] = [];
      await refreshHookLaunchers((l) => lines.push(l));
      expect(lines.join('\n')).not.toContain('now start gbrain from its own directory');
      expect(hookLauncherProblem('codex')).toMatchObject({ lane: 'setup', reason: 'session_cwd' });
    });
    expect({ hooks: readFileSync(hooksJson(b), 'utf8'), config: readFileSync(codexToml(b), 'utf8') }).toEqual(before);
  });

  /** Rewrite setup's MCP entry to the pre-launcher shape (bin serve …); with own, the receipt still owns it by hash. */
  function downgradeClaudeMcp(b: Box, own = true): Record<string, unknown> {
    const cfg = readJson(claudeJson(b));
    const entry = cfg.mcpServers.gbrain;
    expect(entry.command).toBe(launcher(b));
    const old = { ...entry, command: entry.args[0], args: entry.args.slice(1) };
    cfg.mcpServers.gbrain = old;
    writeFileSync(claudeJson(b), JSON.stringify(cfg, null, 2));
    if (own) {
      const r = readJson(receipt(b));
      r.entry_hash = ownedEntryFingerprint(old);
      writeFileSync(receipt(b), JSON.stringify(r, null, 2));
    }
    return old;
  }

  test('claude-code MCP (#8426): doctor flags a pre-launcher MCP entry setup still owns; post-upgrade moves it under the lock', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--json'])).exitCode).toBe(0);
    downgradeClaudeMcp(b);
    await withEnv(env(b), async () => {
      expect(hookLauncherProblem('claude-code')).toBeNull();
      const problem = hookLauncherProblems([]);
      expect(problem).toMatchObject({ harness: 'claude-code', lane: 'mcp', reason: 'session_cwd', owner: 'setup', setupOwned: true });
      expect(hookLauncherFix(problem!)).toMatchObject({ actor: 'agent', argv: ['gbrain', 'setup', 'claude-code', '--gbrain-bin', b.bin] });
      const lines: string[] = [];
      await refreshHookLaunchers((l) => lines.push(l));
      expect(lines.join('\n')).toContain("gbrain setup's claude-code MCP server and hooks now start gbrain from its own directory");
      expect(launcherLaneFindings()).toEqual([]);
    });
    const moved = readJson(claudeJson(b)).mcpServers.gbrain;
    expect([moved.command, ...moved.args.slice(0, 2)]).toEqual([launcher(b), b.bin, 'serve']);
    expect((await setup(b, ['claude-code', '--json'])).doc.steps.map((s: any) => s.action)).toEqual(['keep', 'keep', 'keep']);
  });

  test('claude-code MCP (#8426): post-upgrade keeps each install on its own brain when another install\'s setup hooks share the settings file', async () => {
    const b = box();
    const brainA = join(b.root, 'brain-a');
    const brainB = join(b.root, 'brain-b');
    expect((await setup(b, ['claude-code', '--json'], { GBRAIN_HOME: brainA })).exitCode).toBe(0);
    expect((await setup(b, ['claude-code', '--name', 'beta', '--no-hooks', '--json'], { GBRAIN_HOME: brainB })).exitCode).toBe(0);
    const before = readJson(claudeJson(b)).mcpServers;
    expect(before.gbrain.env.GBRAIN_HOME).toBe(brainA);
    expect(before.beta.env.GBRAIN_HOME).toBe(brainB);
    const cfg = readJson(claudeJson(b));
    const old = { ...cfg.mcpServers.beta, command: cfg.mcpServers.beta.args[0], args: cfg.mcpServers.beta.args.slice(1) };
    cfg.mcpServers.beta = old;
    writeFileSync(claudeJson(b), JSON.stringify(cfg, null, 2));
    const rb = receipt(b, 'beta');
    const r = readJson(rb);
    r.entry_hash = ownedEntryFingerprint(old);
    writeFileSync(rb, JSON.stringify(r, null, 2));
    const lines: string[] = [];
    await withEnv({ ...env(b), GBRAIN_HOME: brainB }, async () => { await refreshHookLaunchers((l) => lines.push(l)); });
    const after = readJson(claudeJson(b)).mcpServers;
    expect(lines.join('\n')).toContain("gbrain setup's claude-code MCP server and hooks now start gbrain from its own directory");
    expect(after.beta.command).toBe(launcher({ ...b, gbrainHome: brainB }));
    expect(after.beta.env.GBRAIN_HOME).toBe(brainB);
    expect(after.gbrain.env.GBRAIN_HOME).toBe(brainA);
  });

  test('readiness reruns an existing setup install with what it recorded: never --no-hooks, never a doctor self-loop, Codex left to the user', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--json'])).exitCode).toBe(0);
    expect((await setup(b, ['codex', '--no-hooks', '--json'])).exitCode).toBe(0);
    await withEnv(env(b), async () => {
      expect(harnessWiringEntry({ transport: 'cli', harnesses: ['claude-code'], lockOwner: null, gbrainBin: b.bin }).fix)
        .toMatchObject({ actor: 'agent', consent: ['persistent_install'], argv: ['gbrain', 'setup', 'claude-code', '--gbrain-bin', b.bin] });
      const codex = harnessWiringEntry({ transport: 'cli', harnesses: ['codex'], lockOwner: null, gbrainBin: b.bin }).fix!;
      expect(codex).toMatchObject({ actor: 'user' });
      expect(codex.argv).toBeUndefined();
      expect(codex.user_message).toContain(`run it yourself: gbrain setup codex --no-hooks --gbrain-bin ${b.bin}`);
    });
  });

  test('claude-code (#8426): post-upgrade never takes a plugin-lane install\'s GBRAIN_HOME from an MCP entry setup does not own', async () => {
    const b = box();
    const brainA = join(b.root, 'brain-a');
    const brainC = join(b.root, 'brain-c');
    mkdirSync(join(b.home, '.claude'), { recursive: true });
    writeFileSync(settings(b), JSON.stringify({ enabledPlugins: { 'gbrain@gbrain': true } }));
    writeFileSync(claudeJson(b), JSON.stringify({ mcpServers: { gbrain: { type: 'stdio', command: b.bin, args: ['serve'], env: { GBRAIN_HOME: brainC } } } }));
    expect((await setup(b, ['claude-code', '--json'], { GBRAIN_HOME: brainA })).exitCode).toBe(0);
    const a = { ...b, gbrainHome: brainA };
    downgradeClaude(a);
    await withEnv({ ...env(b), GBRAIN_HOME: brainA }, async () => { await refreshHookLaunchers(() => {}); });
    const hooks = JSON.stringify(readJson(settings(b)).hooks);
    expect(hooks).not.toContain(brainC);
    expect(hooks).toContain(`GBRAIN_HOME=${brainA}`);
    expect(hooks).toContain(launcher(a));
  });

  test('claude-code MCP (#8426): doctor\'s rerun keeps a recorded --no-hooks, so moving the entry turns no hooks on', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--no-hooks', '--json'])).exitCode).toBe(0);
    downgradeClaudeMcp(b);
    let argv: string[] = [];
    await withEnv(env(b), async () => {
      argv = hookLauncherFix(hookLauncherProblems([])!).argv!;
      expect(argv).toEqual(['gbrain', 'setup', 'claude-code', '--no-hooks', '--gbrain-bin', b.bin]);
    });
    expect((await setup(b, [...argv.slice(2), '--json'])).exitCode).toBe(0);
    expect(readSetupReceipt(receipt(b)).setup!.consent.wiring_scope.value.hooks).toBe('none');
    const moved = readJson(claudeJson(b)).mcpServers.gbrain;
    expect(moved.command).toBe(launcher(b));
  });

  test('claude-code MCP (#8426): a pre-launcher MCP entry the user edited is kept; post-upgrade and doctor hand it to the user', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--json'])).exitCode).toBe(0);
    downgradeClaudeMcp(b, false);
    const before = readFileSync(claudeJson(b), 'utf8');
    await withEnv(env(b), async () => {
      const lines: string[] = [];
      await refreshHookLaunchers((l) => lines.push(l));
      expect(lines.join('\n')).toContain("the 'gbrain' MCP server in");
      expect(lines.join('\n')).toContain('it was edited after setup wrote it, so it is kept as is');
      const problem = hookLauncherProblems([]);
      expect(problem).toMatchObject({ lane: 'mcp', owner: 'none', edited: true, setupOwned: false });
      const fix = hookLauncherFix(problem!);
      expect(fix.actor).toBe('user');
      expect(fix.user_message).toContain('Remove or rewrite that entry');
    });
    expect(readFileSync(claudeJson(b), 'utf8')).toBe(before);
  });

  test('claude-code (#8426): doctor reruns the install that owns the flagged hook, not the first receipt on disk', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--name', 'alpha', '--no-hooks', '--json'])).exitCode).toBe(0);
    expect((await setup(b, ['claude-code', '--json'])).exitCode).toBe(0);
    downgradeClaude(b);
    await withEnv(env(b), async () => {
      const problem = hookLauncherProblem('claude-code');
      expect(problem).toMatchObject({ lane: 'setup', receiptPath: receipt(b) });
      expect(hookLauncherFix(problem!)).toMatchObject({ actor: 'agent', argv: ['gbrain', 'setup', 'claude-code', '--gbrain-bin', b.bin] });
    });
  });

  test('setupRerunArgv carries the recorded hooks opt-out and source pin, and nothing setup keeps on its own', () => {
    const consent = (hooks: 'none' | 'read-context') => ({ wiring_scope: { value: { scope: 'user' as const, hooks }, source: 'flag' as const }, capture: { value: 'accepted' as const, source: 'flag' as const }, providers: { value: 'declined' as const, source: 'default' as const } });
    expect(setupRerunArgv('codex', { name: 'gbrain', consent: consent('none') as any, source_id: 'source-a' })).toEqual(['gbrain', 'setup', 'codex', '--no-hooks', '--source', 'source-a']);
    expect(setupRerunArgv('claude-code', { name: 'alpha', consent: consent('read-context') as any, source_id: null as any }, '/work/proj')).toEqual(['gbrain', 'setup', 'claude-code', '--name', 'alpha', '--scope', 'project']);
  });

  test('setupRerunArgv pins the binary the install recorded, so a PATH lookup in another directory cannot swap it', () => {
    const consent = { wiring_scope: { value: { scope: 'user' as const, hooks: 'read-context' as const }, source: 'flag' as const }, capture: { value: 'accepted' as const, source: 'flag' as const }, providers: { value: 'declined' as const, source: 'default' as const } };
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rerun-bin-'));
    const bin = join(dir, 'gbrain');
    writeFileSync(bin, '#!/bin/sh\n');
    try {
      expect(setupRerunArgv('claude-code', { name: 'gbrain', consent: consent as any, source_id: null as any, launcher: bin })).toEqual(['gbrain', 'setup', 'claude-code', '--gbrain-bin', bin]);
      expect(setupRerunArgv('codex', { name: 'gbrain', consent: consent as any, source_id: null as any, launcher: join(dir, 'gone') })).toEqual(['gbrain', 'setup', 'codex']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('codex MCP (#8426): post-upgrade\'s printed rerun keeps a recorded --no-hooks', async () => {
    const b = box();
    expect((await setup(b, ['codex', '--no-hooks', '--json'])).exitCode).toBe(0);
    const r = readJson(codexReceipt(b));
    const old = { command: b.bin, args: ['serve'], env: { GBRAIN_HOME: b.gbrainHome } };
    expect(removeCodexTomlTable(codexToml(b), ['mcp_servers', 'gbrain'])).toBe('removed');
    appendCodexTomlTable(codexToml(b), ['mcp_servers', 'gbrain'], old, 'gbrain setup (gbrain): owned by fingerprint');
    r.entry_hash = ownedEntryFingerprint(old);
    writeFileSync(codexReceipt(b), JSON.stringify(r, null, 2));
    await withEnv(env(b), async () => {
      const lines: string[] = [];
      await refreshHookLaunchers((l) => lines.push(l));
      expect(lines.join('\n')).toContain(`run gbrain setup codex --no-hooks --gbrain-bin ${b.bin} to rewrite them`);
    });
  });

  test('codex MCP (#8426): post-upgrade names the setup rerun for a pre-launcher [mcp_servers] table and writes nothing; setup moves it', async () => {
    const b = box();
    expect((await setup(b, ['codex', '--json'])).exitCode).toBe(0);
    const r = readJson(codexReceipt(b));
    const toml = readFileSync(codexToml(b), 'utf8');
    const old = { command: b.bin, args: ['serve'], env: { GBRAIN_HOME: b.gbrainHome } };
    expect(removeCodexTomlTable(codexToml(b), ['mcp_servers', 'gbrain'])).toBe('removed');
    appendCodexTomlTable(codexToml(b), ['mcp_servers', 'gbrain'], old, 'gbrain setup (gbrain): owned by fingerprint');
    r.entry_hash = ownedEntryFingerprint(old);
    writeFileSync(codexReceipt(b), JSON.stringify(r, null, 2));
    expect(toml).toContain(launcher(b));
    const before = { hooks: readFileSync(hooksJson(b), 'utf8'), config: readFileSync(codexToml(b), 'utf8') };
    await withEnv(env(b), async () => {
      expect(hookLauncherProblem('codex')).toBeNull();
      expect(hookLauncherProblems([])).toMatchObject({ harness: 'codex', lane: 'mcp', reason: 'session_cwd', owner: 'setup' });
      const lines: string[] = [];
      await refreshHookLaunchers((l) => lines.push(l));
      expect(lines.join('\n')).toContain(`gbrain setup's codex MCP server in ${codexToml(b)} start gbrain in the session's directory; run gbrain setup codex --gbrain-bin ${b.bin} to rewrite them`);
    });
    expect({ hooks: readFileSync(hooksJson(b), 'utf8'), config: readFileSync(codexToml(b), 'utf8') }).toEqual(before);
    expect((await setup(b, ['codex', '--json'])).exitCode).toBe(0);
    expect(readFileSync(codexToml(b), 'utf8')).toContain(launcher(b));
    await withEnv(env(b), async () => { expect(launcherLaneFindings()).toEqual([]); });
  });
});
