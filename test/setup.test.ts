/**
 * `gbrain setup claude-code` (D8): the CLI-only command row's behavior test,
 * spawning `bun src/cli.ts setup` against a temp HOME / GBRAIN_HOME.
 *
 * Authoring gate:
 *  1. Protects: setup resolves its target before writing, owns harness
 *     entries by exact hash (resume never duplicates, --remove deletes only
 *     unchanged owned entries, another install's entries survive), records
 *     three consent decisions with memory-only defaults, and never falls back
 *     from a hosted connection or starts a second PGLite owner.
 *  2. Fails on: marker-only ownership (an edited hook removed), a resume that
 *     appends a second hook, a capture hook installed without acceptance or
 *     over an opt-out, a local brain created next to a hosted one, a
 *     registration written while a foreign live serve holds the lock.
 *  3. New command; bootstrap's tests cover its own lanes, and the
 *     hooks.ts unit block below pins that their marker-only behavior is
 *     unchanged.
 *  4. One seam: GBRAIN_SETUP_ABORT_AFTER (crash injection between files).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';
import { hookEntryHash, removeClaudeHooksAt, writeClaudeHooksAt } from '../src/core/bootstrap/hooks.ts';
import { GBRAIN_HOOK_MARKER_VALUE } from '../src/core/bootstrap/host-specs.ts';
import { codexHookTrustHash, codexTrustHash, removeCodexHooks, writeCodexHooks } from '../src/core/bootstrap/codex-hooks.ts';
import { appendCodexTomlTable, removeCodexTomlTable } from '../src/core/bootstrap/codex-toml.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; gbrainHome: string; bin: string }

function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-setup-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  mkdirSync(join(root, 'bin'));
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, gbrainHome: home, bin };
}

const CLEAN = { CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };

async function setup(b: Box, args: string[], env: Record<string, string | undefined> = {}): Promise<CliResult & { doc: any }> {
  const r = await runCli(['setup', ...args, '--gbrain-bin', b.bin], { env: { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.gbrainHome, ...env } });
  let doc: any = null;
  if (args.includes('--json')) { try { doc = JSON.parse(r.stdout); } catch { doc = null; } }
  return { ...r, doc };
}

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const claudeJson = (b: Box) => join(b.home, '.claude.json');
const settings = (b: Box) => join(b.home, '.claude', 'settings.json');
const receipt = (b: Box, name = 'gbrain') => join(b.home, `.gbrain-connection-claude-code-${name}.json`);

/** Every hook entry under an event, flattened. */
function entries(b: Box, event: string): any[] {
  if (!existsSync(settings(b))) return [];
  return (readJson(settings(b)).hooks?.[event] ?? []).flatMap((g: any) => g.hooks ?? []);
}

describe('gbrain setup claude-code: install lifecycle', () => {
  test('fresh install creates a keyless brain, wires MCP + read-context hooks only, verifies; a second run changes nothing', async () => {
    const b = box();
    const first = await setup(b, ['claude-code', '--json']);
    expect(first.exitCode).toBe(0);
    expect(first.doc.target.brain.kind).toBe('new-local-pglite');
    expect(first.doc.target.launcher).toBe(b.bin);
    expect(first.doc.states).toEqual(['configured', 'connection-verified', 'native-pending']);
    expect(first.doc.verify.reason).toBe('smoke_passed');
    expect(first.doc.consent.capture).toMatchObject({ value: 'declined', source: 'default' });
    expect(first.doc.consent.providers).toMatchObject({ value: 'declined', source: 'default' });
    expect(readJson(join(b.gbrainHome, '.gbrain', 'config.json')).embedding_disabled).toBe(true);
    const entry = readJson(claudeJson(b)).mcpServers.gbrain;
    expect(entry).toEqual({ type: 'stdio', command: b.bin, args: ['serve', '--surface', 'full'], env: { GBRAIN_HOME: b.gbrainHome } });
    expect(Object.keys(readJson(settings(b)).hooks).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(readJson(receipt(b)).status).toBe('installed');
    const [bundle] = first.doc.notices;
    expect(bundle).toMatchObject({ code: 'first_run_decisions', kind: 'ask' });
    expect(bundle.decisions.map((d: any) => d.id)).not.toContain('harness_wiring');
    expect(bundle.user_message).not.toContain("Reply 'defaults'");

    const before = [readFileSync(claudeJson(b), 'utf8'), readFileSync(settings(b), 'utf8'), readFileSync(receipt(b), 'utf8')];
    const second = await setup(b, ['claude-code', '--json']);
    expect(second.exitCode).toBe(0);
    expect(second.doc.steps.map((s: any) => s.action)).toEqual(['keep', 'keep', 'keep']);
    expect([readFileSync(claudeJson(b), 'utf8'), readFileSync(settings(b), 'utf8'), readFileSync(receipt(b), 'utf8')]).toEqual(before);
    expect(existsSync(`${settings(b)}.bak`)).toBe(false);
  });

  test('human output ends with one non-blocking settings block after Next, and none of init\'s standalone steps', async () => {
    const b = box();
    const r = await setup(b, ['claude-code']);
    expect(r.exitCode).toBe(0);
    for (const stale of ['Do this next', 'claude mcp add', "Reply 'defaults'", 'Before continuing', 'gbrain install check', '(id: harness_wiring)']) expect(r.stdout).not.toContain(stale);
    expect(r.stdout).toContain('Brain ready at ');
    const next = r.stdout.indexOf('Next: open a new Claude Code session');
    const block = r.stdout.indexOf('[AGENT]');
    expect(next).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(next);
    expect(r.stdout.match(/\[AGENT\]/g)).toHaveLength(1);
    expect(r.stdout.slice(block)).toContain('in the reply that reports this install');
    expect(r.stdout.slice(block)).toContain('(id: search_mode)');
    expect(r.stdout.trimEnd().endsWith('[/AGENT]')).toBe(true);
  });

  test('#6606: after Next, setup names remember as the way to save a fact and what reaches new sessions', async () => {
    const b = box();
    const r = await setup(b, ['claude-code']);
    expect(r.exitCode).toBe(0);
    const next = r.stdout.indexOf('Next: open a new Claude Code session');
    const memory = r.stdout.indexOf('Memory: save what the user asks you to remember as a fact with gbrain remember "<fact>", naming its entity and provenance');
    expect(next).toBeGreaterThan(-1);
    expect(memory).toBeGreaterThan(next);
    expect(r.stdout.indexOf('[AGENT]')).toBeGreaterThan(memory);
    const line = r.stdout.slice(memory).split('\n')[0];
    expect(line).toContain('pushed into new sessions');
    expect(line).toContain('a private fact is not (local CLI recall only)');
    expect(line).toContain('capture writes a page, not a fact');
  });

  test('--remove deletes exactly the owned entries; foreign hooks, other MCP servers and the brain stay', async () => {
    const b = box();
    mkdirSync(join(b.home, '.claude'), { recursive: true });
    const foreign = { type: 'command', command: 'echo user-hook', timeout: 2 };
    writeFileSync(settings(b), JSON.stringify({ theme: 'dark', hooks: { SessionStart: [{ hooks: [foreign] }] } }));
    writeFileSync(claudeJson(b), JSON.stringify({ mcpServers: { other: { type: 'stdio', command: '/bin/true', args: [] } }, numStartups: 3 }));
    expect((await setup(b, ['claude-code'])).exitCode).toBe(0);
    expect(entries(b, 'SessionStart')).toHaveLength(2);

    const preview = await setup(b, ['claude-code', '--remove', '--dry-run', '--json']);
    expect(preview.exitCode).toBe(0);
    expect(readJson(claudeJson(b)).mcpServers.gbrain).toBeDefined();

    const removed = await setup(b, ['claude-code', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.preserved).toEqual([]);
    const cfg = readJson(claudeJson(b));
    expect(cfg.mcpServers).toEqual({ other: { type: 'stdio', command: '/bin/true', args: [] } });
    expect(cfg.numStartups).toBe(3);
    const s = readJson(settings(b));
    expect(s.theme).toBe('dark');
    expect(s.hooks).toEqual({ SessionStart: [{ hooks: [foreign] }] });
    expect(existsSync(receipt(b))).toBe(false);
    expect(existsSync(join(b.gbrainHome, '.gbrain', 'brain.pglite'))).toBe(true);
  });

  test('a crash after the MCP write and before the hook write resumes without duplicating anything', async () => {
    const b = box();
    const crashed = await setup(b, ['claude-code'], { GBRAIN_SETUP_ABORT_AFTER: 'mcp' });
    expect(crashed.exitCode).toBe(1);
    expect(crashed.stderr).toContain('aborted after mcp');
    expect(readJson(claudeJson(b)).mcpServers.gbrain).toBeDefined();
    expect(existsSync(settings(b))).toBe(false);
    const mid = readJson(receipt(b));
    expect(mid.status).toBe('prepared');
    expect(Object.keys(mid.hooks.pending).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);

    const resumed = await setup(b, ['claude-code', '--json']);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.doc.target.brain.kind).toBe('local-pglite');
    expect(resumed.doc.steps.find((s: any) => s.step === 'mcp').action).toBe('keep');
    expect(Object.keys(readJson(claudeJson(b)).mcpServers)).toEqual(['gbrain']);
    expect(entries(b, 'SessionStart')).toHaveLength(1);
    expect(entries(b, 'UserPromptSubmit')).toHaveLength(1);
    expect(readJson(receipt(b)).status).toBe('installed');
    expect(readJson(receipt(b)).brain_created_by_setup).toBe(true);
  });

  test('a user-edited owned hook survives --remove, is reported, and a later setup leaves it alone', async () => {
    const b = box();
    expect((await setup(b, ['claude-code'])).exitCode).toBe(0);
    const s = readJson(settings(b));
    const edited = s.hooks.SessionStart[0].hooks[0];
    edited.command = `${edited.command} --verbose`;
    expect(edited._gbrain).toBe('setup-v1');
    writeFileSync(settings(b), JSON.stringify(s, null, 2));

    const removed = await setup(b, ['claude-code', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.preserved).toEqual([{ kind: 'hook', event: 'SessionStart', reason: 'edited' }]);
    expect(entries(b, 'SessionStart')).toEqual([edited]);
    expect(entries(b, 'UserPromptSubmit')).toEqual([]);
    expect(readJson(claudeJson(b)).mcpServers.gbrain).toBeUndefined();

    const again = await setup(b, ['claude-code', '--json']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.preserved).toEqual([{ kind: 'hook', event: 'SessionStart', reason: 'edited' }]);
    expect(entries(b, 'SessionStart')).toEqual([edited]);
    expect(entries(b, 'UserPromptSubmit')).toHaveLength(1);
  });

  test('an MCP entry setup did not write is refused (setup_owner_conflict), an identical one is adopted and kept on --remove', async () => {
    const b = box();
    const foreignCfg = JSON.stringify({ mcpServers: { gbrain: { type: 'stdio', command: '/opt/other/gbrain', args: ['serve'] } } });
    writeFileSync(claudeJson(b), foreignCfg);
    const refused = await setup(b, ['claude-code', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(refused.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'unowned_entry' });
    expect(readFileSync(claudeJson(b), 'utf8')).toBe(foreignCfg);
    expect(existsSync(settings(b))).toBe(false);

    const same = { type: 'stdio', command: b.bin, args: ['serve', '--surface', 'full'], env: { GBRAIN_HOME: b.gbrainHome } };
    writeFileSync(claudeJson(b), JSON.stringify({ mcpServers: { gbrain: same } }));
    const adopted = await setup(b, ['claude-code', '--json']);
    expect(adopted.exitCode).toBe(0);
    expect(readJson(receipt(b)).mcp_adopted).toBe(true);
    const removed = await setup(b, ['claude-code', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(readJson(claudeJson(b)).mcpServers.gbrain).toEqual(same);
  });

  test('two installs on one machine each own their own entries; removing one leaves the other', async () => {
    const a = box();
    const b: Box = { ...a, gbrainHome: join(a.root, 'second') };
    mkdirSync(b.gbrainHome);
    expect((await setup(a, ['claude-code'])).exitCode).toBe(0);
    const clash = await setup(b, ['claude-code', '--json']);
    expect(clash.exitCode).toBe(1);
    expect(clash.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'other_install' });

    expect((await setup(b, ['claude-code', '--name', 'gbrain-b'])).exitCode).toBe(0);
    expect(Object.keys(readJson(claudeJson(a)).mcpServers).sort()).toEqual(['gbrain', 'gbrain-b']);
    expect(entries(a, 'SessionStart')).toHaveLength(2);
    const aOnly = entries(a, 'SessionStart').filter((e) => e.command.includes(`GBRAIN_HOME=${a.gbrainHome} `));

    expect((await setup(b, ['claude-code', '--name', 'gbrain-b', '--remove'])).exitCode).toBe(0);
    expect(Object.keys(readJson(claudeJson(a)).mcpServers)).toEqual(['gbrain']);
    expect(entries(a, 'SessionStart')).toEqual(aOnly);
    expect(existsSync(receipt(a))).toBe(true);
    expect(existsSync(receipt(a, 'gbrain-b'))).toBe(false);
  });
});

describe('gbrain setup claude-code: target first', () => {
  test('--dry-run prints the target and writes nothing; GBRAIN_SURFACE is honoured', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--dry-run', '--json'], { GBRAIN_SURFACE: 'starter' });
    expect(r.exitCode).toBe(0);
    expect(r.doc.target).toMatchObject({ transport: 'local-stdio', surface: 'starter', registration_owner: 'none', launcher: b.bin });
    expect(r.doc.steps.find((s: any) => s.step === 'brain').detail).toContain('--no-embedding');
    expect(existsSync(claudeJson(b))).toBe(false);
    expect(existsSync(join(b.gbrainHome, '.gbrain'))).toBe(false);
  });

  test('a hosted connection never falls back to a new local brain', async () => {
    const thin = box();
    mkdirSync(join(thin.gbrainHome, '.gbrain'));
    writeFileSync(join(thin.gbrainHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', remote_mcp: {
      issuer_url: 'https://brain.example.test', mcp_url: 'https://brain.example.test/mcp', oauth_client_id: 'client-a', oauth_client_secret: 'secret-a' } }));
    const r = await setup(thin, ['claude-code', '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.doc.code).toBe('setup_hosted_connection');
    expect(r.doc.message).toContain('https://brain.example.test/mcp');
    expect(existsSync(join(thin.gbrainHome, '.gbrain', 'brain.pglite'))).toBe(false);
    expect(existsSync(claudeJson(thin))).toBe(false);

    const wired = box();
    const hostedCfg = JSON.stringify({ mcpServers: { gbrain: { type: 'http', url: 'https://brain.example.test/mcp', headers: { Authorization: 'Bearer x' } } } });
    writeFileSync(claudeJson(wired), hostedCfg);
    writeFileSync(receipt(wired), JSON.stringify({ client_id: 'client-a', mcp_url: 'https://brain.example.test/mcp', status: 'installed', harness: 'claude-code' }));
    const w = await setup(wired, ['claude-code', '--json']);
    expect(w.exitCode).toBe(1);
    expect(w.doc.code).toBe('setup_hosted_connection');
    expect(readFileSync(claudeJson(wired), 'utf8')).toBe(hostedCfg);
    expect(existsSync(join(wired.gbrainHome, '.gbrain'))).toBe(false);
  });

  test('a live PGLite owner that this setup did not register is an owner conflict; setup writes nothing', async () => {
    const b = box();
    const init = await runCli(['init', '--pglite', '--no-embedding'], { home: b.home });
    expect(init.exitCode).toBe(0);
    const serve = Bun.spawn([process.execPath, '--no-env-file', CLI, 'serve'], {
      env: { ...process.env, HOME: b.home, GBRAIN_HOME: b.gbrainHome, GBRAIN_SKIP_STARTUP_HOOKS: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const lockFile = join(b.gbrainHome, '.gbrain', 'brain.pglite', '.gbrain-lock', 'lock');
      for (let i = 0; i < 300 && !existsSync(lockFile); i++) await Bun.sleep(50);
      expect(existsSync(lockFile)).toBe(true);
      const r = await setup(b, ['claude-code', '--json']);
      expect(r.exitCode).toBe(1);
      expect(r.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'live_serve' });
      expect(r.doc.fix.argv).toEqual(['kill', String(serve.pid)]);
      expect(existsSync(claudeJson(b))).toBe(false);
      expect(existsSync(receipt(b))).toBe(false);
    } finally {
      serve.kill();
      await serve.exited;
    }
  });

  test('a live stdio serve started by this setup\'s own registration is reused, not a conflict', async () => {
    const b = box();
    expect((await setup(b, ['claude-code'])).exitCode).toBe(0);
    const entry = readJson(claudeJson(b)).mcpServers.gbrain;
    const serve = Bun.spawn([entry.command, ...entry.args], {
      env: { ...process.env, ...entry.env, HOME: b.home, GBRAIN_SKIP_STARTUP_HOOKS: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const lockFile = join(b.gbrainHome, '.gbrain', 'brain.pglite', '.gbrain-lock', 'lock');
      for (let i = 0; i < 300 && !existsSync(lockFile); i++) await Bun.sleep(50);
      const r = await setup(b, ['claude-code', '--json']);
      expect(r.exitCode).toBe(0);
      expect(r.doc.target.live_owner).toMatchObject({ pid: serve.pid, transport: 'stdio', ours: true });
      expect(r.doc.verify.reason).toBe('wired_running');
    } finally {
      serve.kill();
      await serve.exited;
    }
  });
});

describe('gbrain setup: consent and refusals', () => {
  test('provider keys present + capture declined + an existing opt-out: no capture hooks, no provider traffic, keyless brain', async () => {
    const seen: string[] = [];
    const recorder: Server = createServer((sock) => {
      sock.once('data', (d) => { seen.push(d.toString('utf8').split('\r\n')[0] ?? ''); sock.destroy(); });
    });
    await new Promise<void>((ok) => recorder.listen(0, '127.0.0.1', ok));
    const port = (recorder.address() as { port: number }).port;
    const providerEnv = {
      OPENAI_API_KEY: 'sk-test-setup', ANTHROPIC_API_KEY: 'sk-ant-test-setup', VOYAGE_API_KEY: 'pa-test-setup', GEMINI_API_KEY: 'gm-test-setup',
      HTTPS_PROXY: `http://127.0.0.1:${port}`, HTTP_PROXY: `http://127.0.0.1:${port}`, https_proxy: `http://127.0.0.1:${port}`, http_proxy: `http://127.0.0.1:${port}`,
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    };
    try {
      const fresh = box();
      const r = await setup(fresh, ['claude-code', '--no-capture', '--json'], providerEnv);
      expect(r.exitCode).toBe(0);
      expect(r.doc.consent.capture).toMatchObject({ value: 'declined', source: 'flag' });
      expect(readJson(join(fresh.gbrainHome, '.gbrain', 'config.json')).embedding_disabled).toBe(true);
      expect(entries(fresh, 'Stop')).toEqual([]);
      expect(entries(fresh, 'SessionEnd')).toEqual([]);

      const optedOut = box();
      expect((await runCli(['init', '--pglite', '--no-embedding'], { home: optedOut.home })).exitCode).toBe(0);
      const cfgPath = join(optedOut.gbrainHome, '.gbrain', 'config.json');
      writeFileSync(cfgPath, JSON.stringify({ ...readJson(cfgPath), memory: { auto_writeback: 'off' } }));
      const o = await setup(optedOut, ['claude-code', '--capture', '--json'], providerEnv);
      expect(o.exitCode).toBe(0);
      expect(o.doc.consent.capture).toMatchObject({ value: 'declined', source: 'opt_out' });
      expect(o.doc.notes.join(' ')).toContain('--capture ignored');
      expect(Object.keys(readJson(settings(optedOut)).hooks).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
      expect(seen.filter((l) => /openai|anthropic|voyage|googleapis|\/v1\//i.test(l))).toEqual([]);
    } finally {
      recorder.close();
    }
  });

  test('--capture, accepted and not opted out, adds Stop and SessionEnd; --no-hooks then removes every owned hook', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--capture', '--json']);
    expect(r.exitCode).toBe(0);
    expect(Object.keys(readJson(settings(b)).hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    const off = await setup(b, ['claude-code', '--no-hooks', '--json']);
    expect(off.exitCode).toBe(0);
    expect(readJson(settings(b)).hooks ?? {}).toEqual({});
    expect(readJson(claudeJson(b)).mcpServers.gbrain).toBeDefined();
  });

  for (const [harness, guide] of [['openclaw', 'docs/mcp/OPENCLAW.md'], ['hermes', 'docs/mcp/HERMES.md']] as const) {
    test(`${harness} is a coded refusal that names its guide`, async () => {
      const b = box();
      const r = await setup(b, [harness, '--json']);
      expect(r.exitCode).toBe(2);
      expect(r.doc.code).toBe('setup_harness_unsupported');
      expect(r.doc.message).toContain(guide);
      expect(existsSync(claudeJson(b))).toBe(false);
    });
  }
});

describe('hooks.ts ownership: hash-keyed for setup, marker-keyed for bootstrap (unchanged)', () => {
  const env = { GBRAIN_SOURCE: 'default' };
  function editedFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-hooks-own-'));
    roots.push(dir);
    const path = join(dir, 'settings.json');
    writeClaudeHooksAt(path, { gbrainBin: '/usr/local/bin/gbrain', env, events: ['SessionStart'] });
    const s = readJson(path);
    s.hooks.SessionStart[0].hooks[0].command += ' --edited';
    writeFileSync(path, JSON.stringify(s));
    return path;
  }

  test('without ownedEntryHashes a marked entry is removed even when edited (bootstrap lanes keep their behavior)', () => {
    const path = editedFile();
    const r = removeClaudeHooksAt(path, GBRAIN_HOOK_MARKER_VALUE);
    expect(r.removed).toBe(1);
    expect(readJson(path).hooks).toBeUndefined();
  });

  test('with ownedEntryHashes an edited marked entry survives removal and rewrite, and is reported', () => {
    const path = editedFile();
    const before = readJson(path).hooks.SessionStart[0].hooks[0];
    const r = removeClaudeHooksAt(path, GBRAIN_HOOK_MARKER_VALUE, { ownedEntryHashes: new Set(['not-this-one']) });
    expect(r.removed).toBe(0);
    expect(r.preserved).toEqual([{ event: 'SessionStart', hash: hookEntryHash(before)! }]);
    const w = writeClaudeHooksAt(path, { gbrainBin: '/usr/local/bin/gbrain', env, events: ['UserPromptSubmit'], ownedEntryHashes: new Set() });
    expect(w.preserved).toHaveLength(1);
    expect(readJson(path).hooks.SessionStart[0].hooks[0]).toEqual(before);
  });

  test('hookEntryHash ignores the marker key and changes with the command or timeout', () => {
    const base = { type: 'command', command: 'env A=1 /bin/gbrain hook session-start', timeout: 5 };
    expect(hookEntryHash({ ...base, _gbrain: 'setup-v1' })).toBe(hookEntryHash(base));
    expect(hookEntryHash({ ...base, timeout: 6 })).not.toBe(hookEntryHash(base));
    expect(hookEntryHash({ ...base, command: `${base.command} x` })).not.toBe(hookEntryHash(base));
    expect(hookEntryHash({ type: 'other' })).toBeNull();
  });
});

// ── gbrain setup codex ──────────────────────────────────────────────────────

const codexDir = (b: Box) => join(b.home, '.codex');
const codexToml = (b: Box) => join(codexDir(b), 'config.toml');
const hooksJson = (b: Box) => join(codexDir(b), 'hooks.json');
const codexReceipt = (b: Box, name = 'gbrain') => join(codexDir(b), `.gbrain-connection-codex-${name}.json`);
const toml = (b: Box): any => Bun.TOML.parse(readFileSync(codexToml(b), 'utf8'));
const trustKeys = (b: Box): string[] => Object.keys(toml(b).hooks?.state ?? {}).sort();
const trustKey = (b: Box, event: string, index: number) => `${hooksJson(b)}:${event}:${index}:0`;
/** Matcher groups under one hooks.json event. */
function groups(b: Box, event: string): any[] {
  if (!existsSync(hooksJson(b))) return [];
  return readJson(hooksJson(b)).hooks?.[event] ?? [];
}
const setupGroups = (b: Box, event: string) => groups(b, event).filter((g) => g.hooks?.[0]?.command?.includes('GBRAIN_HOOK_LANE=setup'));

describe('gbrain setup codex: install lifecycle', () => {
  test('fresh install: keyless brain, MCP table, read-context hooks and their trust entries only, verified; a second run changes nothing', async () => {
    const b = box();
    const first = await setup(b, ['codex', '--json']);
    expect(first.exitCode).toBe(0);
    expect(first.doc.harness).toBe('codex');
    expect(first.doc.target).toMatchObject({ brain: { kind: 'new-local-pglite' }, launcher: b.bin, config_path: codexToml(b), hooks_path: hooksJson(b) });
    expect(first.doc.verify.reason).toBe('smoke_passed');
    expect(first.doc.states).toEqual(['configured', 'connection-verified', 'native-verified']);
    expect(first.doc.capability).toMatchObject({ harness: 'codex', setup: 'supported', push: 'native-verified', read_events: ['SessionStart', 'UserPromptSubmit'] });
    expect(first.doc.consent.capture).toMatchObject({ value: 'declined', source: 'default' });
    expect(readJson(join(b.gbrainHome, '.gbrain', 'config.json')).embedding_disabled).toBe(true);
    expect(toml(b).mcp_servers.gbrain).toEqual({ command: b.bin, args: ['serve', '--surface', 'full'], env: { GBRAIN_HOME: b.gbrainHome } });
    expect(Object.keys(readJson(hooksJson(b)).hooks).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(groups(b, 'UserPromptSubmit')).toEqual([{ hooks: [{ type: 'command', timeout: 15,
      command: `env GBRAIN_HOOK_LANE=setup GBRAIN_HOME=${b.gbrainHome} ${b.bin} hook user-prompt --harness codex` }] }]);
    expect(trustKeys(b)).toEqual([trustKey(b, 'session_start', 0), trustKey(b, 'user_prompt_submit', 0)]);
    const r = readJson(codexReceipt(b));
    expect(r).toMatchObject({ harness: 'codex', connection: 'local-stdio', setup_receipt_version: 2, status: 'installed' });
    expect(Object.keys(r.hooks.owned).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect(Object.keys(r.trust.owned).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);

    const before = [codexToml(b), hooksJson(b), codexReceipt(b)].map((p) => readFileSync(p, 'utf8'));
    const second = await setup(b, ['codex', '--json']);
    expect(second.exitCode).toBe(0);
    expect(second.doc.steps.map((s: any) => [s.step, s.action])).toEqual([['receipt', 'keep'], ['mcp', 'keep'], ['hooks', 'keep'], ['trust', 'keep']]);
    expect([codexToml(b), hooksJson(b), codexReceipt(b)].map((p) => readFileSync(p, 'utf8'))).toEqual(before);
  });

  test('--remove deletes exactly the owned entries; foreign config, hooks, trust entries and the brain stay byte-for-byte', async () => {
    const b = box();
    mkdirSync(codexDir(b), { recursive: true });
    const foreignToml = [
      'model = "o5"', '',
      '[mcp_servers.other]', 'command = "/bin/true"', '',
      '# my own hook trust', `[hooks.state.${JSON.stringify(trustKey(b, 'session_start', 0))}]`, 'trusted_hash = "sha256:mine"', '',
    ].join('\n');
    writeFileSync(codexToml(b), foreignToml);
    const foreignHooks = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook', timeout: 2 }] }] } }, null, 2);
    writeFileSync(hooksJson(b), foreignHooks);
    const installed = await setup(b, ['codex', '--json']);
    expect(installed.exitCode).toBe(0);
    expect(groups(b, 'SessionStart')).toHaveLength(2);
    expect(trustKeys(b)).toEqual([trustKey(b, 'session_start', 0), trustKey(b, 'session_start', 1), trustKey(b, 'user_prompt_submit', 0)]);
    expect(toml(b).hooks.state[trustKey(b, 'session_start', 0)]).toEqual({ trusted_hash: 'sha256:mine' });

    const preview = await setup(b, ['codex', '--remove', '--dry-run', '--json']);
    expect(preview.exitCode).toBe(0);
    expect(toml(b).mcp_servers.gbrain).toBeDefined();
    expect(existsSync(codexReceipt(b))).toBe(true);

    const removed = await setup(b, ['codex', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.preserved).toEqual([]);
    expect(readFileSync(codexToml(b), 'utf8')).toBe(foreignToml);
    expect(readJson(hooksJson(b))).toEqual(JSON.parse(foreignHooks));
    expect(existsSync(codexReceipt(b))).toBe(false);
    expect(existsSync(join(b.gbrainHome, '.gbrain', 'brain.pglite'))).toBe(true);
  });

  test('a crash after the MCP write and before the hook write resumes without duplicating anything', async () => {
    const b = box();
    const crashed = await setup(b, ['codex'], { GBRAIN_SETUP_ABORT_AFTER: 'mcp' });
    expect(crashed.exitCode).toBe(1);
    expect(crashed.stderr).toContain('aborted after mcp');
    expect(toml(b).mcp_servers.gbrain).toBeDefined();
    expect(existsSync(hooksJson(b))).toBe(false);
    const mid = readJson(codexReceipt(b));
    expect(mid.status).toBe('prepared');
    expect(mid.consent.capture.value).toBe('declined');
    expect(Object.keys(mid.hooks.pending).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);

    const resumed = await setup(b, ['codex', '--json']);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.doc.target.brain.kind).toBe('local-pglite');
    expect(resumed.doc.steps.find((s: any) => s.step === 'mcp').action).toBe('keep');
    expect(readFileSync(codexToml(b), 'utf8').match(/^\[mcp_servers\.gbrain\]$/gm)).toHaveLength(1);
    expect(groups(b, 'SessionStart')).toHaveLength(1);
    expect(groups(b, 'UserPromptSubmit')).toHaveLength(1);
    expect(trustKeys(b)).toEqual([trustKey(b, 'session_start', 0), trustKey(b, 'user_prompt_submit', 0)]);
    expect(readJson(codexReceipt(b))).toMatchObject({ status: 'installed', brain_created_by_setup: true });
  });

  test('a crash after the hook write and before the trust write leaves untrusted (inert) hooks; resume trusts them once', async () => {
    const b = box();
    expect((await setup(b, ['codex'], { GBRAIN_SETUP_ABORT_AFTER: 'hooks' })).exitCode).toBe(1);
    expect(groups(b, 'UserPromptSubmit')).toHaveLength(1);
    expect(trustKeys(b)).toEqual([]);
    expect(Object.keys(readJson(codexReceipt(b)).trust.pending).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
    expect((await setup(b, ['codex'])).exitCode).toBe(0);
    expect(groups(b, 'UserPromptSubmit')).toHaveLength(1);
    expect(trustKeys(b)).toEqual([trustKey(b, 'session_start', 0), trustKey(b, 'user_prompt_submit', 0)]);
  });

  test('a user-edited owned hook survives --remove, is reported, and a later setup neither rewrites nor trusts it', async () => {
    const b = box();
    expect((await setup(b, ['codex'])).exitCode).toBe(0);
    const doc = readJson(hooksJson(b));
    doc.hooks.SessionStart[0].hooks[0].command += ' --verbose';
    const edited = doc.hooks.SessionStart[0];
    writeFileSync(hooksJson(b), JSON.stringify(doc, null, 2));

    const removed = await setup(b, ['codex', '--remove', '--json']);
    expect(removed.exitCode).toBe(0);
    expect(removed.doc.preserved).toEqual([{ kind: 'hook', event: 'SessionStart', reason: 'edited' }]);
    expect(groups(b, 'SessionStart')).toEqual([edited]);
    expect(groups(b, 'UserPromptSubmit')).toEqual([]);
    expect(toml(b).mcp_servers?.gbrain).toBeUndefined();
    expect(trustKeys(b)).toEqual([]);
    expect(readJson(codexReceipt(b)).status).toBe('removed');

    const again = await setup(b, ['codex', '--json']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.preserved).toEqual([{ kind: 'hook', event: 'SessionStart', reason: 'edited' }]);
    expect(groups(b, 'SessionStart')).toEqual([edited]);
    expect(setupGroups(b, 'UserPromptSubmit')).toHaveLength(1);
    expect(trustKeys(b)).toEqual([trustKey(b, 'user_prompt_submit', 0)]);
  });

  test('a changed hook index (a group inserted before setup\'s) re-trusts only what setup owns', async () => {
    const b = box();
    expect((await setup(b, ['codex'])).exitCode).toBe(0);
    const doc = readJson(hooksJson(b));
    const userGroup = { hooks: [{ type: 'command', command: 'echo mine', timeout: 5 }] };
    doc.hooks.UserPromptSubmit.unshift(userGroup);
    writeFileSync(hooksJson(b), JSON.stringify(doc, null, 2));
    const userTrust = `\n[hooks.state.${JSON.stringify(`${hooksJson(b)}:stop:0:0`)}]\ntrusted_hash = "sha256:user-owned"\n`;
    writeFileSync(codexToml(b), readFileSync(codexToml(b), 'utf8') + userTrust);

    const dry = await setup(b, ['codex', '--dry-run', '--json']);
    expect(dry.doc.steps.find((s: any) => s.step === 'trust').action).toBe('write');
    const r = await setup(b, ['codex', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.steps.filter((s: any) => s.step === 'trust').map((s: any) => s.action)).toEqual(['remove', 'keep', 'write']);
    expect(groups(b, 'UserPromptSubmit')[0]).toEqual(userGroup);
    expect(setupGroups(b, 'UserPromptSubmit')).toHaveLength(1);
    expect(trustKeys(b)).toEqual([trustKey(b, 'session_start', 0), `${hooksJson(b)}:stop:0:0`, trustKey(b, 'user_prompt_submit', 1)].sort());
    expect(toml(b).hooks.state[`${hooksJson(b)}:stop:0:0`]).toEqual({ trusted_hash: 'sha256:user-owned' });
    expect(readJson(codexReceipt(b)).trust.owned.UserPromptSubmit.key).toBe(trustKey(b, 'user_prompt_submit', 1));
  });

  test('two installs on one machine each own their own entries; removing one leaves the other', async () => {
    const a = box();
    const b: Box = { ...a, gbrainHome: join(a.root, 'second') };
    mkdirSync(b.gbrainHome);
    expect((await setup(a, ['codex'])).exitCode).toBe(0);
    const clash = await setup(b, ['codex', '--json']);
    expect(clash.exitCode).toBe(1);
    expect(clash.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'other_install' });

    expect((await setup(b, ['codex', '--name', 'gbrain-b'])).exitCode).toBe(0);
    expect(Object.keys(toml(a).mcp_servers).sort()).toEqual(['gbrain', 'gbrain-b']);
    expect(setupGroups(a, 'UserPromptSubmit')).toHaveLength(2);
    const aGroups = { ss: groups(a, 'SessionStart')[0], ups: groups(a, 'UserPromptSubmit')[0] };
    expect(aGroups.ups.hooks[0].command).toContain(`GBRAIN_HOME=${a.gbrainHome} `);
    const aTrust = { ss: toml(a).hooks.state[trustKey(a, 'session_start', 0)], ups: toml(a).hooks.state[trustKey(a, 'user_prompt_submit', 0)] };

    expect((await setup(b, ['codex', '--name', 'gbrain-b', '--remove'])).exitCode).toBe(0);
    expect(Object.keys(toml(a).mcp_servers)).toEqual(['gbrain']);
    expect(groups(a, 'SessionStart')).toEqual([aGroups.ss]);
    expect(groups(a, 'UserPromptSubmit')).toEqual([aGroups.ups]);
    expect(trustKeys(a)).toEqual([trustKey(a, 'session_start', 0), trustKey(a, 'user_prompt_submit', 0)]);
    expect(toml(a).hooks.state[trustKey(a, 'session_start', 0)]).toEqual(aTrust.ss);
    expect(toml(a).hooks.state[trustKey(a, 'user_prompt_submit', 0)]).toEqual(aTrust.ups);
    expect(existsSync(codexReceipt(a))).toBe(true);
    expect(existsSync(codexReceipt(a, 'gbrain-b'))).toBe(false);
  });

  test('an MCP table setup did not write is refused; an identical one is adopted and kept on --remove; a remote one is a hosted connection', async () => {
    const b = box();
    mkdirSync(codexDir(b), { recursive: true });
    const foreign = '[mcp_servers.gbrain]\ncommand = "/opt/other/gbrain"\nargs = ["serve"]\n';
    writeFileSync(codexToml(b), foreign);
    const refused = await setup(b, ['codex', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(refused.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'unowned_entry' });
    expect(readFileSync(codexToml(b), 'utf8')).toBe(foreign);
    expect(existsSync(hooksJson(b))).toBe(false);

    const same = `[mcp_servers.gbrain]\ncommand = ${JSON.stringify(b.bin)}\nargs = ["serve", "--surface", "full"]\nenv = { GBRAIN_HOME = ${JSON.stringify(b.gbrainHome)} }\n`;
    writeFileSync(codexToml(b), same);
    expect((await setup(b, ['codex'])).exitCode).toBe(0);
    expect(readJson(codexReceipt(b)).mcp_adopted).toBe(true);
    const removed = await setup(b, ['codex', '--remove', '--json']);
    expect(removed.doc.preserved).toEqual([{ kind: 'mcp', reason: 'adopted' }]);
    expect(readFileSync(codexToml(b), 'utf8')).toBe(same);

    const hosted = box();
    mkdirSync(codexDir(hosted), { recursive: true });
    const remote = '[mcp_servers.gbrain]\nurl = "https://brain.example.test/mcp"\nhttp_headers = { Authorization = "Bearer x" }\n';
    writeFileSync(codexToml(hosted), remote);
    const h = await setup(hosted, ['codex', '--json']);
    expect(h.exitCode).toBe(1);
    expect(h.doc.code).toBe('setup_hosted_connection');
    expect(readFileSync(codexToml(hosted), 'utf8')).toBe(remote);
    expect(existsSync(join(hosted.gbrainHome, '.gbrain'))).toBe(false);
  });
});

describe('gbrain setup codex: consent and flags', () => {
  test('provider keys present + capture declined + existing opt-outs: no capture hook, no provider traffic, keyless brain', async () => {
    const seen: string[] = [];
    const recorder: Server = createServer((sock) => {
      sock.once('data', (d) => { seen.push(d.toString('utf8').split('\r\n')[0] ?? ''); sock.destroy(); });
    });
    await new Promise<void>((ok) => recorder.listen(0, '127.0.0.1', ok));
    const port = (recorder.address() as { port: number }).port;
    const providerEnv = {
      OPENAI_API_KEY: 'sk-test-setup', ANTHROPIC_API_KEY: 'sk-ant-test-setup', VOYAGE_API_KEY: 'pa-test-setup', GEMINI_API_KEY: 'gm-test-setup',
      HTTPS_PROXY: `http://127.0.0.1:${port}`, HTTP_PROXY: `http://127.0.0.1:${port}`, https_proxy: `http://127.0.0.1:${port}`, http_proxy: `http://127.0.0.1:${port}`,
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    };
    try {
      const fresh = box();
      const r = await setup(fresh, ['codex', '--no-capture', '--json'], providerEnv);
      expect(r.exitCode).toBe(0);
      expect(r.doc.consent.capture).toMatchObject({ value: 'declined', source: 'flag' });
      expect(r.doc.consent.providers).toMatchObject({ value: 'declined', source: 'default' });
      expect(readJson(join(fresh.gbrainHome, '.gbrain', 'config.json')).embedding_disabled).toBe(true);
      expect(groups(fresh, 'SessionEnd')).toEqual([]);
      expect(trustKeys(fresh).some((k) => k.includes(':session_end:'))).toBe(false);

      const optedOut = box();
      expect((await runCli(['init', '--pglite', '--no-embedding'], { home: optedOut.home })).exitCode).toBe(0);
      const cfgPath = join(optedOut.gbrainHome, '.gbrain', 'config.json');
      writeFileSync(cfgPath, JSON.stringify({ ...readJson(cfgPath), memory: { auto_writeback: 'off' } }));
      const o = await setup(optedOut, ['codex', '--capture', '--json'], providerEnv);
      expect(o.exitCode).toBe(0);
      expect(o.doc.consent.capture).toMatchObject({ value: 'declined', source: 'opt_out' });
      expect(o.doc.notes.join(' ')).toContain('--capture ignored');
      expect(Object.keys(readJson(hooksJson(optedOut)).hooks).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);

      const hooksOff = box();
      const k = await setup(hooksOff, ['codex', '--capture', '--json'], { ...providerEnv, GBRAIN_HOOKS: '0' });
      expect(k.exitCode).toBe(0);
      expect(k.doc.consent.wiring_scope).toMatchObject({ value: { hooks: 'none' }, source: 'opt_out' });
      expect(existsSync(hooksJson(hooksOff))).toBe(false);
      expect(trustKeys(hooksOff)).toEqual([]);
      expect(k.doc.states).toEqual(['configured', 'connection-verified', 'native-pending']);

      expect(seen.filter((l) => /openai|anthropic|voyage|googleapis|\/v1\//i.test(l))).toEqual([]);
      for (const b of [fresh, optedOut, hooksOff]) expect(existsSync(join(b.gbrainHome, '.gbrain', 'corpus'))).toBe(false);
    } finally {
      recorder.close();
    }
  });

  test('--capture adds the SessionEnd capture group and its trust; --no-hooks then removes every owned hook and trust entry', async () => {
    const b = box();
    const r = await setup(b, ['codex', '--capture', '--json']);
    expect(r.exitCode).toBe(0);
    expect(Object.keys(readJson(hooksJson(b)).hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    const end = groups(b, 'SessionEnd')[0].hooks[0];
    expect(end.timeout).toBe(3);
    expect(end.command).toMatch(/^env GBRAIN_HOOK_LANE=setup GBRAIN_HOME=\S+ sh -c '.*hook session-end --harness codex/);
    expect(trustKeys(b)).toContain(trustKey(b, 'session_end', 0));
    const off = await setup(b, ['codex', '--no-hooks', '--json']);
    expect(off.exitCode).toBe(0);
    expect(readJson(hooksJson(b)).hooks).toEqual({});
    expect(trustKeys(b)).toEqual([]);
    expect(toml(b).mcp_servers.gbrain).toBeDefined();
  });

  test('--dry-run writes nothing and honours GBRAIN_SURFACE; --scope project is refused for codex', async () => {
    const b = box();
    const r = await setup(b, ['codex', '--dry-run', '--json'], { GBRAIN_SURFACE: 'starter' });
    expect(r.exitCode).toBe(0);
    expect(r.doc.target).toMatchObject({ transport: 'local-stdio', surface: 'starter', registration_owner: 'none', scope: 'user' });
    expect(r.doc.steps.map((s: any) => s.step)).toEqual(['receipt', 'brain', 'mcp', 'hooks', 'trust']);
    expect(existsSync(codexDir(b))).toBe(false);
    expect(existsSync(join(b.gbrainHome, '.gbrain'))).toBe(false);
    const p = await setup(b, ['codex', '--scope', 'project']);
    expect(p.exitCode).toBe(2);
    expect(p.stderr).toContain('user scope only');
  });

  test('the bootstrap Codex SessionEnd lane is an owner conflict for --capture, and bootstrap never claims setup\'s groups', async () => {
    const b = box();
    mkdirSync(codexDir(b), { recursive: true });
    expect(writeCodexHooks({ gbrainBin: b.bin, hooksPath: hooksJson(b), configPath: codexToml(b) }).ok).toBe(true);
    const refused = await setup(b, ['codex', '--capture', '--json']);
    expect(refused.exitCode).toBe(1);
    expect(refused.doc).toMatchObject({ code: 'setup_owner_conflict', reason: 'harness_lane' });
    expect(existsSync(codexReceipt(b))).toBe(false);

    const c = box();
    expect((await setup(c, ['codex', '--capture'])).exitCode).toBe(0);
    const before = readFileSync(hooksJson(c), 'utf8');
    removeCodexHooks({ hooksPath: hooksJson(c), configPath: codexToml(c) });
    expect(readFileSync(hooksJson(c), 'utf8')).toBe(before);
  });
});

describe('codex trust hash and hash-owned TOML tables', () => {
  test('codexHookTrustHash reproduces trust entries a live codex-cli 0.162.1 accepted (the hooks ran)', () => {
    const base = '/home/user/.capy/work/d8/obs-2';
    const cmd = (sub: string) => `env GBRAIN_HOOK_LANE=setup GBRAIN_HOME=${base}/home ${base}/bin/gbrain hook ${sub} --harness codex`;
    expect(codexHookTrustHash('user_prompt_submit', cmd('user-prompt'), 15)).toBe('sha256:14aa503e53d2b5dd658bec9232f3021e8169c2799b6332dc4514dfdf71fb44ae');
    expect(codexHookTrustHash('session_start', cmd('session-start'), 15)).toBe('sha256:86d30bf0ab9b998a4121df4a83de0662ea94f69d94d4311c61589c26d5191737');
    expect(codexHookTrustHash('session_end', 'x', 3)).toBe(codexTrustHash('x'));
  });

  test('append then remove is byte-exact, keeps the next table\'s comment, and refuses a re-rendered table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-codex-toml-'));
    roots.push(dir);
    const path = join(dir, 'config.toml');
    const original = 'model = "o5"\n\n[profiles.fast]\nmodel = "o5-mini"\n';
    writeFileSync(path, original);
    appendCodexTomlTable(path, ['mcp_servers', 'gbrain'], { command: '/bin/gbrain', args: ['serve'], env: { GBRAIN_HOME: '/h' } }, 'gbrain setup (gbrain): test');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n# user note about the next table\n[profiles.slow]\nmodel = "o5"\n`);
    expect(() => appendCodexTomlTable(path, ['mcp_servers', 'gbrain'], { command: '/x' })).toThrow(/never defines a table twice/);
    expect(removeCodexTomlTable(path, ['mcp_servers', 'gbrain'])).toBe('removed');
    expect(readFileSync(path, 'utf8')).toBe(`${original}\n# user note about the next table\n[profiles.slow]\nmodel = "o5"\n`);
    expect(removeCodexTomlTable(path, ['mcp_servers', 'gbrain'])).toBe('absent');

    writeFileSync(path, '[mcp_servers.gbrain]\ncommand = "/bin/gbrain"\n\n[mcp_servers.gbrain.env]\nGBRAIN_HOME = "/h"\n');
    const split = readFileSync(path, 'utf8');
    expect(removeCodexTomlTable(path, ['mcp_servers', 'gbrain'])).toBe('unlocatable');
    expect(readFileSync(path, 'utf8')).toBe(split);
  });
});
