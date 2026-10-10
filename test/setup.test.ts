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

const CLEAN = { CLAUDE_CONFIG_DIR: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SETUP_ABORT_AFTER: undefined };

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

    const before = [readFileSync(claudeJson(b), 'utf8'), readFileSync(settings(b), 'utf8'), readFileSync(receipt(b), 'utf8')];
    const second = await setup(b, ['claude-code', '--json']);
    expect(second.exitCode).toBe(0);
    expect(second.doc.steps.map((s: any) => s.action)).toEqual(['keep', 'keep', 'keep']);
    expect([readFileSync(claudeJson(b), 'utf8'), readFileSync(settings(b), 'utf8'), readFileSync(receipt(b), 'utf8')]).toEqual(before);
    expect(existsSync(`${settings(b)}.bak`)).toBe(false);
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

  for (const [harness, guide] of [['codex', 'docs/mcp/CODEX.md'], ['openclaw', 'docs/mcp/OPENCLAW.md'], ['hermes', 'docs/mcp/HERMES.md']] as const) {
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
