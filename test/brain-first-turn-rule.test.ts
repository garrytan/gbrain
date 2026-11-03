/**
 * The per-turn brain-first rule (src/core/setup/brain-first.ts): one line a
 * harness's per-turn hook puts beside every user turn. Pins who gets it and
 * when it is off: Claude Code / Codex UserPromptSubmit (only while a block is
 * installed for that harness), the self-contained Hermes pre_llm_call hook
 * setup writes into config.yaml, the hook-only OpenClaw plugin setup installs
 * with OpenClaw's CLI, and the opt-out.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { withEnv } from './helpers/with-env.ts';
import { brainFirstTurnRule, renderBrainFirstTurnRule, type BrainFirstAccess } from '../src/core/setup/brain-first.ts';
import { runHook } from '../src/commands/hook.ts';
import { hermesTurnHookCommand, removeHermesTurnHook, syncHermesTurnHook } from '../src/core/setup/hermes-turn-hook.ts';
import { OPENCLAW_TURN_PLUGIN_ID, openclawTurnPluginDir, removeOpenclawTurnPlugin, syncOpenclawTurnPlugin } from '../src/core/setup/openclaw-turn-plugin.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function home(entries: Array<{ harness: string; status: 'installed' | 'declined'; access?: BrainFirstAccess }> | null): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-turn-rule-'));
  roots.push(root);
  if (entries) {
    mkdirSync(join(root, '.gbrain'), { recursive: true });
    writeFileSync(join(root, '.gbrain', 'agent-instructions.json'), JSON.stringify({ version: 1, entries: entries.map((e, i) => ({
      path: join(root, `file-${i}.md`), block_version: 2, access: { kind: 'mcp', server: 'gbrain' }, writer: 'test', created_file: false,
      updated_at: new Date(Date.UTC(2026, 9, 25, 0, i)).toISOString(), ...e,
    })) }));
  }
  return root;
}

const env = (root: string, extra: Record<string, string | undefined> = {}) => ({ GBRAIN_HOME: root, GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_HOOKS: undefined, ...extra });

async function userPrompt(root: string, harness?: string, extra: Record<string, string | undefined> = {}): Promise<string> {
  let out = '';
  await withEnv(env(root, extra), async () => {
    const code = await runHook(['user-prompt', ...(harness ? ['--harness', harness] : [])], {
      stdin: JSON.stringify({ prompt: 'what did alice-example decide about the launch?', session_id: 's1' }),
      write: (s) => { out += s; }, cwd: root, configOverride: null, disablePushBanner: true, disableTelemetry: true,
    });
    expect(code).toBe(0);
  });
  return out;
}

describe('per-turn rule: text and decision', () => {
  test('names the tools of the recorded access', () => {
    expect(renderBrainFirstTurnRule({ kind: 'mcp', server: 'gbrain' })).toContain('before answering this turn, check GBrain first (`search` or `query` on the `gbrain` MCP server)');
    expect(renderBrainFirstTurnRule({ kind: 'mcp', server: 'brain', surface: 'verbs' })).toContain('`recall` or `entity` on the `brain` MCP server');
    expect(renderBrainFirstTurnRule({ kind: 'cli', launcher: '/opt/gbrain' })).toContain('`/opt/gbrain search "<names>"`');
  });

  test('a recorded install turns it on with its access; no record, a decline or the opt-out turns it off', async () => {
    await withEnv(env(home(null)), async () => {
      expect(brainFirstTurnRule('claude-code')).toBeNull();
    });
    await withEnv(env(home([{ harness: 'claude-code', status: 'installed', access: { kind: 'mcp', server: 'brain', surface: 'verbs' } }])), async () => {
      expect(brainFirstTurnRule('claude-code')).toBe(renderBrainFirstTurnRule({ kind: 'mcp', server: 'brain', surface: 'verbs' }));
      expect(brainFirstTurnRule('codex')).toBeNull();
    });
    await withEnv(env(home([{ harness: 'openclaw', status: 'declined' }])), async () => {
      expect(brainFirstTurnRule('openclaw')).toBeNull();
    });
    await withEnv(env(home([{ harness: 'claude-code', status: 'installed' }]), { GBRAIN_AGENT_INSTRUCTIONS: '0' }), async () => {
      expect(brainFirstTurnRule('claude-code')).toBeNull();
    });
  });
});

describe('per-turn rule: Claude Code and Codex user-prompt hook', () => {
  test('with a block installed, every turn carries the rule even when serve has no context to add', async () => {
    const out = await userPrompt(home([{ harness: 'claude-code', status: 'installed' }]));
    const doc = JSON.parse(out.trim());
    expect(doc.hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: renderBrainFirstTurnRule({ kind: 'mcp', server: 'gbrain' }) });
    expect(doc.systemMessage).toBeUndefined();
  });

  test('codex reads its own ledger entry', async () => {
    const root = home([{ harness: 'codex', status: 'installed' }]);
    expect(await userPrompt(root, 'codex')).toContain('check GBrain first');
    expect(await userPrompt(root)).toBe('');
  });

  test('no block, a declined block, GBRAIN_AGENT_INSTRUCTIONS=0 or the null seam: stdout stays empty', async () => {
    expect(await userPrompt(home(null))).toBe('');
    expect(await userPrompt(home([{ harness: 'claude-code', status: 'declined' }]))).toBe('');
    expect(await userPrompt(home([{ harness: 'claude-code', status: 'installed' }]), undefined, { GBRAIN_AGENT_INSTRUCTIONS: '0' })).toBe('');
    let out = '';
    await withEnv(env(home([{ harness: 'claude-code', status: 'installed' }])), async () => {
      await runHook(['user-prompt'], { stdin: JSON.stringify({ prompt: 'hi' }), write: (s) => { out += s; }, configOverride: null, disablePushBanner: true, disableTelemetry: true, turnRule: null });
    });
    expect(out).toBe('');
  });
});

describe('per-turn rule names the tools where tool_search hides them', () => {
  test('OpenClaw: names the gbrain tools and the tool_search / tool_call route; Hermes: names mcp_<server>_<tool>', () => {
    const starter = { kind: 'mcp', server: 'gbrain', surface: 'starter' } as const;
    const openclaw = renderBrainFirstTurnRule(starter, 'openclaw');
    expect(openclaw).toContain('find them with `tool_search` (search "gbrain recall") and run them with `tool_call`');
    expect(openclaw).toContain('`recall`, `entity`, `search`, `query` on the `gbrain` MCP server');
    expect(openclaw).toContain('tool_search shows them as external data');
    const hermes = renderBrainFirstTurnRule({ kind: 'mcp', server: 'brain', surface: 'verbs' }, 'hermes');
    expect(hermes).toContain('find them with `tool_search` (they register as `mcp_brain_recall`, `mcp_brain_entity`, `mcp_brain_remember`)');
    // Claude Code and Codex list MCP tools directly; a CLI launcher needs no discovery.
    expect(renderBrainFirstTurnRule(starter, 'claude-code')).not.toContain('tool_search');
    expect(renderBrainFirstTurnRule(starter)).not.toContain('tool_search');
    expect(renderBrainFirstTurnRule({ kind: 'cli', launcher: '/opt/gbrain' }, 'openclaw')).not.toContain('tool_search');
  });
});

describe('per-turn rule: Hermes pre_llm_call hook in config.yaml', () => {
  const access: BrainFirstAccess = { kind: 'mcp', server: 'gbrain' };
  const cmd = hermesTurnHookCommand(access);
  function hermes(config?: string, approvals: unknown[] = []): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-hermes-home-'));
    roots.push(dir);
    if (config !== undefined) writeFileSync(join(dir, 'config.yaml'), config);
    if (approvals.length) writeFileSync(join(dir, 'shell-hooks-allowlist.json'), JSON.stringify({ approvals }));
    return dir;
  }
  const cfg = (d: string) => readFileSync(join(d, 'config.yaml'), 'utf8');
  const approvals = (d: string) => JSON.parse(readFileSync(join(d, 'shell-hooks-allowlist.json'), 'utf8')).approvals as Array<Record<string, unknown>>;

  test('the command echoes Hermes\'s {"context": ...} wire shape on its own: no shell, no gbrain process', () => {
    const quoted: BrainFirstAccess = { kind: 'cli', launcher: "/opt/it's/gbrain" };
    const c = hermesTurnHookCommand(quoted);
    expect(c.startsWith("/bin/echo '")).toBe(true);
    expect(c.endsWith("'")).toBe(true);
    const inner = c.slice("/bin/echo '".length, -1);
    expect(inner).not.toContain("'");
    expect(JSON.parse(inner)).toEqual({ context: renderBrainFirstTurnRule(quoted, 'hermes') });
    expect(JSON.parse(cmd.slice("/bin/echo '".length, -1))).toEqual({ context: renderBrainFirstTurnRule(access, 'hermes') });
  });

  test('a flow-style config.yaml, or an allowlist gbrain cannot read, gets the entry printed and both files left as they are', () => {
    const flow = '{model: alice-example-model, agent: {max_turns: 4}}\n';
    const d = hermes(flow);
    expect(syncHermesTurnHook({ hermesHome: d, access, dryRun: false }).action).toBe('print');
    expect(cfg(d)).toBe(flow);
    const unreadable = hermes('model: x\n');
    writeFileSync(join(unreadable, 'shell-hooks-allowlist.json'), '{"approvals": [{"event": "post_tool_call", "command": "/opt/x"}],}');
    expect(syncHermesTurnHook({ hermesHome: unreadable, access, dryRun: false }).action).toBe('print');
    expect(cfg(unreadable)).toBe('model: x\n');
    expect(readFileSync(join(unreadable, 'shell-hooks-allowlist.json'), 'utf8')).toContain('post_tool_call');
    const bom = hermes('model: x\n');
    writeFileSync(join(bom, 'shell-hooks-allowlist.json'), '\uFEFF' + JSON.stringify({ approvals: [{ event: 'post_tool_call', command: '/opt/x' }] }));
    expect(syncHermesTurnHook({ hermesHome: bom, access, dryRun: false }).action).toBe('write');
    expect(approvals(bom).map((e) => e.event)).toEqual(['post_tool_call', 'pre_llm_call']);
  });

  test('appends a marked hook after the user\'s text, approves exactly that command, keeps on a re-run, and removal undoes both', () => {
    const mine = '# my config\nmodel:\n  default: alice-example-model\n';
    const other = { event: 'pre_tool_call', command: '/usr/bin/true', approved_at: 'x', script_mtime_at_approval: null };
    const d = hermes(mine, [other]);
    expect(syncHermesTurnHook({ hermesHome: d, access, dryRun: false }).action).toBe('write');
    const text = cfg(d);
    expect(text.startsWith(mine)).toBe(true);
    expect(load(text)).toEqual({ model: { default: 'alice-example-model' }, hooks: { pre_llm_call: [{ command: cmd, timeout: 10 }] } });
    expect(approvals(d)).toEqual([other, expect.objectContaining({ event: 'pre_llm_call', command: cmd, script_mtime_at_approval: null })]);
    expect(syncHermesTurnHook({ hermesHome: d, access, dryRun: false }).action).toBe('keep');
    expect(cfg(d)).toBe(text);
    expect(approvals(d)).toHaveLength(2);
    expect(removeHermesTurnHook({ hermesHome: d, dryRun: false }).action).toBe('remove');
    expect(cfg(d)).toBe(mine);
    expect(approvals(d)).toEqual([other]);
  });

  // Hermes's own writer (agent/shell_hooks.py _locked_update_approvals): an
  // exclusive fcntl.flock on the sibling .lock around read-modify-write.
  const HERMES_WRITER = [
    'import fcntl, json, os, sys, time',
    'home, hold = sys.argv[1], float(sys.argv[2])',
    'path = os.path.join(home, "shell-hooks-allowlist.json")',
    'with open(path + ".lock", "a+") as lock:',
    '    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)',
    '    print("locked", flush=True)',
    '    data = json.load(open(path, encoding="utf-8-sig")) if os.path.exists(path) else {"approvals": []}',
    '    time.sleep(hold)',
    '    data["approvals"].append({"event": "post_tool_call", "command": "/opt/hermes-side", "approved_at": "x", "script_mtime_at_approval": None})',
    '    open(path + ".tmp", "w").write(json.dumps(data))',
    '    os.replace(path + ".tmp", path)',
    '    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)',
  ].join('\n');
  async function hermesHoldsLock(d: string, holdSecs: number) {
    const proc = Bun.spawn(['python3', '-c', HERMES_WRITER, d, String(holdSecs)], { stdout: 'pipe', stderr: 'inherit' });
    const reader = proc.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('locked');
    reader.releaseLock();
    return proc;
  }

  test.skipIf(!Bun.which('python3'))('the approval waits for Hermes\'s allowlist flock, so an approval Hermes records at the same moment survives', async () => {
    const d = hermes('model: x\n');
    const proc = await hermesHoldsLock(d, 0.8);
    expect(syncHermesTurnHook({ hermesHome: d, access, dryRun: false }).action).toBe('write');
    expect(await proc.exited).toBe(0);
    expect(approvals(d).map((a) => a.command)).toEqual(['/opt/hermes-side', cmd]);
  });

  test.skipIf(!Bun.which('python3'))('a flock Hermes holds past the wait refuses loudly and leaves the allowlist untouched', async () => {
    const d = hermes('model: x\n', [{ event: 'pre_tool_call', command: '/usr/bin/true' }]);
    const before = readFileSync(join(d, 'shell-hooks-allowlist.json'), 'utf8');
    const proc = await hermesHoldsLock(d, 8);
    try {
      const o = syncHermesTurnHook({ hermesHome: d, access, dryRun: false });
      expect(o.action).toBe('print');
      expect(o.detail).toContain('shell-hooks-allowlist.json.lock');
      expect(readFileSync(join(d, 'shell-hooks-allowlist.json'), 'utf8')).toBe(before);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test('new rule text rewrites the block in place and moves the approval to the new command', () => {
    const d = hermes('');
    syncHermesTurnHook({ hermesHome: d, access, dryRun: false });
    const next: BrainFirstAccess = { kind: 'mcp', server: 'brain', surface: 'verbs' };
    expect(syncHermesTurnHook({ hermesHome: d, access: next, dryRun: false }).action).toBe('write');
    expect(load(cfg(d))).toEqual({ hooks: { pre_llm_call: [{ command: hermesTurnHookCommand(next), timeout: 10 }] } });
    expect(approvals(d).map((a) => a.command)).toEqual([hermesTurnHookCommand(next)]);
  });

  test('prints the entry instead of editing: a hooks: section of the user\'s, no Hermes home, damaged markers', () => {
    const theirs = 'hooks:\n  pre_tool_call:\n    - command: /usr/bin/true\n';
    const d = hermes(theirs);
    const o = syncHermesTurnHook({ hermesHome: d, access, dryRun: false });
    expect(o.action).toBe('print');
    expect(o.snippet).toContain(`- command: ${JSON.stringify(cmd)}`);
    expect(cfg(d)).toBe(theirs);
    expect(existsSync(join(d, 'shell-hooks-allowlist.json'))).toBe(false);
    expect(syncHermesTurnHook({ hermesHome: join(tmpdir(), 'gbrain-no-such-hermes-home'), access, dryRun: false }).action).toBe('print');
    const damaged = hermes('# gbrain:turn-rule:begin\nmodel: x\n');
    expect(syncHermesTurnHook({ hermesHome: damaged, access, dryRun: false }).action).toBe('print');
    expect(cfg(damaged)).toBe('# gbrain:turn-rule:begin\nmodel: x\n');
  });

  test('dry-run writes nothing', () => {
    const d = hermes('model: x\n');
    expect(syncHermesTurnHook({ hermesHome: d, access, dryRun: true }).action).toBe('write');
    expect(cfg(d)).toBe('model: x\n');
    expect(existsSync(join(d, 'shell-hooks-allowlist.json'))).toBe(false);
  });
});

describe('per-turn rule: OpenClaw before_prompt_build plugin', () => {
  const access: BrainFirstAccess = { kind: 'mcp', server: 'gbrain' };
  function state(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-openclaw-state-'));
    roots.push(dir);
    return dir;
  }
  function recorder(fail?: string) {
    const calls: string[][] = [];
    return { calls, run: (argv: string[]) => { calls.push(argv); return argv.includes(fail ?? '\0') ? { ok: false, output: 'boom' } : { ok: true, output: '' }; } };
  }

  test('writes a self-contained hook-only plugin and installs it with the openclaw CLI; a re-run keeps it', async () => {
    const st = state();
    await withEnv({ OPENCLAW_STATE_DIR: st, OPENCLAW_PROFILE: undefined }, async () => {
      const dir = openclawTurnPluginDir();
      expect(dir).toBe(join(st, 'gbrain', OPENCLAW_TURN_PLUGIN_ID));
      const rec = recorder();
      const o = syncOpenclawTurnPlugin({ access, dryRun: false, openclawBin: '/bin/openclaw', run: rec.run });
      expect(o.action).toBe('write');
      expect(rec.calls).toEqual([
        ['/bin/openclaw', 'plugins', 'install', '--link', dir, '--force', '--accept-capabilities'],
        ['/bin/openclaw', 'plugins', 'enable', OPENCLAW_TURN_PLUGIN_ID],
        ['/bin/openclaw', 'config', 'set', `plugins.entries.${OPENCLAW_TURN_PLUGIN_ID}.hooks.allowConversationAccess`, 'true'],
      ]);
      expect(JSON.parse(readFileSync(join(dir, 'openclaw.plugin.json'), 'utf8'))).toMatchObject({ id: OPENCLAW_TURN_PLUGIN_ID, configSchema: { type: 'object' } });
      expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).openclaw).toEqual({ extensions: ['./index.js'] });
      const mod = await import(join(dir, 'index.js'));
      const handlers: Record<string, () => unknown> = {};
      mod.default.register({ on: (event: string, fn: () => unknown) => { handlers[event] = fn; } });
      expect(Object.keys(handlers)).toEqual(['before_prompt_build']);
      expect(handlers.before_prompt_build()).toEqual({ prependContext: renderBrainFirstTurnRule(access, 'openclaw') });
      expect(syncOpenclawTurnPlugin({ access, dryRun: false, openclawBin: '/bin/openclaw', run: recorder().run }).action).toBe('keep');
    });
  });

  test('no openclaw on PATH or a failed command: the plugin is written and the remaining commands are printed', async () => {
    await withEnv({ OPENCLAW_STATE_DIR: state(), OPENCLAW_PROFILE: undefined }, async () => {
      const o = syncOpenclawTurnPlugin({ access, dryRun: false, openclawBin: null });
      expect(o.action).toBe('print');
      expect(o.commands?.[0]).toBe(`openclaw plugins install --link ${openclawTurnPluginDir()} --force --accept-capabilities`);
      expect(o.commands).toHaveLength(3);
      expect(existsSync(join(openclawTurnPluginDir(), 'index.js'))).toBe(true);
      const failed = syncOpenclawTurnPlugin({ access, dryRun: false, openclawBin: '/bin/openclaw', run: recorder('enable').run });
      expect(failed.action).toBe('print');
      expect(failed.commands).toEqual([`/bin/openclaw plugins enable ${OPENCLAW_TURN_PLUGIN_ID}`, `/bin/openclaw config set plugins.entries.${OPENCLAW_TURN_PLUGIN_ID}.hooks.allowConversationAccess true`]);
    });
  });

  test('dry-run writes and runs nothing; removal uninstalls and deletes the directory and its empty parent', async () => {
    const st = state();
    await withEnv({ OPENCLAW_STATE_DIR: st, OPENCLAW_PROFILE: undefined }, async () => {
      const rec = recorder();
      expect(syncOpenclawTurnPlugin({ access, dryRun: true, openclawBin: '/bin/openclaw', run: rec.run }).action).toBe('write');
      expect(rec.calls).toEqual([]);
      expect(existsSync(openclawTurnPluginDir())).toBe(false);
      expect(removeOpenclawTurnPlugin({ dryRun: false, openclawBin: '/bin/openclaw', run: rec.run }).action).toBe('skip');
      syncOpenclawTurnPlugin({ access, dryRun: false, openclawBin: '/bin/openclaw', run: rec.run });
      const gone = recorder();
      expect(removeOpenclawTurnPlugin({ dryRun: false, openclawBin: '/bin/openclaw', run: gone.run }).action).toBe('remove');
      expect(gone.calls).toEqual([['/bin/openclaw', 'plugins', 'uninstall', OPENCLAW_TURN_PLUGIN_ID, '--force']]);
      expect(existsSync(join(st, 'gbrain'))).toBe(false);
    });
  });

  test('removal keeps the directory OpenClaw still loads when the uninstall fails or openclaw is not on PATH', async () => {
    await withEnv({ OPENCLAW_STATE_DIR: state(), OPENCLAW_PROFILE: undefined }, async () => {
      syncOpenclawTurnPlugin({ access, dryRun: false, openclawBin: '/bin/openclaw', run: recorder().run });
      const failed = removeOpenclawTurnPlugin({ dryRun: false, openclawBin: '/bin/openclaw', run: recorder('uninstall').run });
      expect(failed.action).toBe('print');
      expect(failed.commands).toEqual([`/bin/openclaw plugins uninstall ${OPENCLAW_TURN_PLUGIN_ID} --force`]);
      expect(existsSync(join(openclawTurnPluginDir(), 'index.js'))).toBe(true);
      const noBin = removeOpenclawTurnPlugin({ dryRun: false, openclawBin: null });
      expect(noBin.action).toBe('print');
      expect(noBin.commands).toEqual([`openclaw plugins uninstall ${OPENCLAW_TURN_PLUGIN_ID} --force`]);
      expect(existsSync(join(openclawTurnPluginDir(), 'index.js'))).toBe(true);
    });
  });
});
