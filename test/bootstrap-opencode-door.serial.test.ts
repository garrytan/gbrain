/**
 * opencode door — workspace lane, end to end against the REAL runBootstrap
 * (engine-free; the config write is the direct JSONC writer, no opencode
 * binary involved). The load-bearing contracts:
 *
 *  1. detectHarness: opencode sets OPENCODE=1 (+OPENCODE_PID) in bash-tool
 *     children (OPENCODE-CLI-PIN.md §Environment) — the probe must see it,
 *     and claude-code/codex signals must win when both are present (their
 *     paste-in flows run inside those harnesses).
 *  2. Scope inversion: with NO explicit MCP_SCOPE answer the registration is
 *     USER-GLOBAL (opencode spawns project-config servers with no trust gate
 *     — the committed-file scope is explicit-opt-in only). An explicit
 *     'project' answer writes the workspace opencode.json with a
 *     PATH-resolved "gbrain" command (committed-candidate file: no absolute
 *     machine paths) and prints the SHARING WARNING.
 *  3. Ownership: a remote-type mcp.gbrain in the global config (harness lane
 *     or foreign) makes the stdio lane STEP ASIDE; a foreign local entry
 *     refuses loudly.
 *  4. The rendered AGENTS.md pull protocol names opencode alongside Codex —
 *     a hookless opencode agent's per-turn seam is that prose.
 *
 * Serial: mutates GBRAIN_HOME and XDG_CONFIG_HOME.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  detectHarness,
  runBootstrap,
  runOpencodeProbe,
  type OpencodeProbeSpawn,
} from '../src/commands/bootstrap.ts';
import type { ExecRunner } from '../src/core/bootstrap/repo.ts';
import { readReceipt } from '../src/core/bootstrap/format.ts';
import { opencodeGlobalConfigPath } from '../src/core/bootstrap/host-specs.ts';
import { parseOpencodeConfig } from '../src/core/bootstrap/opencode-json.ts';
import { initState, setAnswer, confirm, readBackHash } from '../src/core/bootstrap/interview.ts';

const REQUIRED_ANSWERS: Record<string, string> = {
  AGENT_NAME: 'Opencoder',
  PRINCIPAL_NAME: 'Alice Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research group; values signal over noise.',
  VOICE_REGISTER: 'Direct: three options, the second one wins.',
};

let tmpParent: string;
let home: string;
let xdg: string;
let prevHome: string | undefined;
let prevXdg: string | undefined;
const FAKE_BIN = '/opt/fake/bin/gbrain';

function makeRunner(): { runner: ExecRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ExecRunner = async (argv: string[]) => {
    calls.push(argv);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

interface ProbeCall {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  cwdWasEmptyDir: boolean;
}

/** Fake for the probe-spawn seam. Empty stdout simulates opencode absent
 * (spawn throws → the probe maps it to the shell's 127); otherwise a
 * clean exit 0 with the given stdout. Captures argv + cwd + env. */
function makeProbeSpawn(listStdout = ''): { spawn: OpencodeProbeSpawn; calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  const spawn: OpencodeProbeSpawn = (argv, opts) => {
    calls.push({
      argv,
      cwd: opts.cwd,
      env: opts.env,
      cwdWasEmptyDir: existsSync(opts.cwd) && readdirSync(opts.cwd).length === 0,
    });
    if (listStdout === '') throw new Error('Executable not found in $PATH: "opencode"');
    return {
      exited: Promise.resolve(0),
      kill: () => {},
      stdout: Promise.resolve(listStdout),
      stderr: Promise.resolve(''),
    };
  };
  return { spawn, calls };
}

async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  let out = '';
  let err = '';
  console.log = (...args: unknown[]) => { out += args.map(String).join(' ') + '\n'; };
  console.error = (...args: unknown[]) => { err += args.map(String).join(' ') + '\n'; };
  try {
    const result = await fn();
    return { result, out, err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

/** Interviewed + rendered workspace; optional explicit MCP_SCOPE answer. */
async function readyWs(opts: { scope?: 'project' | 'user' } = {}): Promise<string> {
  const ws = mkdtempSync(join(tmpdir(), 'gb-opencode-door-ws-'));
  expect(initState(ws).ok).toBe(true);
  for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
    const r = setAnswer(ws, key, value);
    if (!r.ok) throw new Error(r.message);
  }
  if (opts.scope) expect(setAnswer(ws, 'MCP_SCOPE', opts.scope).ok).toBe(true);
  const h = readBackHash(ws);
  if (!h.ok) throw new Error(h.message);
  expect(confirm(ws, h.hash).ok).toBe(true);
  const render = await capture(() => runBootstrap(['render', '--workspace', ws]));
  expect(render.result).toBe(0);
  return ws;
}

beforeAll(() => {
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-opencode-door-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  xdg = join(tmpParent, 'xdg-config');
  prevHome = process.env.GBRAIN_HOME;
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.GBRAIN_HOME = tmpParent;
  process.env.XDG_CONFIG_HOME = xdg;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tmpParent, { recursive: true, force: true });
});

describe('detectHarness — opencode env probe (OPENCODE-CLI-PIN.md §Environment)', () => {
  test('OPENCODE=1 and OPENCODE_PID each detect opencode', () => {
    expect(detectHarness({ OPENCODE: '1' })).toBe('opencode');
    expect(detectHarness({ OPENCODE_PID: '12345' })).toBe('opencode');
  });
  test('claude-code and codex signals win over opencode (nested-harness order)', () => {
    expect(detectHarness({ CLAUDECODE: '1', OPENCODE: '1' })).toBe('claude-code');
    expect(detectHarness({ CODEX_HOME: '/x', OPENCODE: '1' })).toBe('codex');
  });
  test('no signals → null', () => {
    expect(detectHarness({})).toBeNull();
  });
});

describe('--harness flag validation', () => {
  test('unknown value names all three harnesses and exits 2', async () => {
    const ws = await readyWs();
    const r = await capture(() => runBootstrap(['hooks', '--workspace', ws, '--harness', 'grok']));
    expect(r.result).toBe(2);
    expect(r.err).toContain("unknown --harness 'grok'");
    expect(r.err).toContain('claude-code, codex, or opencode');
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('opencode workspace lane — default scope is USER-GLOBAL', () => {
  test('no explicit MCP_SCOPE → user-global config, absolute binary, rationale printed, receipt scope user', async () => {
    const ws = await readyWs();
    const { runner } = makeRunner();
    const probe = makeProbeSpawn(); // opencode absent → 127 branch
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], { runner, probeSpawn: probe.spawn }),
    );
    expect(r.result).toBe(0);

    const cfgPath = opencodeGlobalConfigPath();
    expect(cfgPath.startsWith(join(xdg, 'opencode'))).toBe(true);
    const parsed = parseOpencodeConfig(readFileSync(cfgPath, 'utf8'), cfgPath);
    const entry = (parsed.mcp as Record<string, unknown>).gbrain as {
      type: string; command: string[]; environment: Record<string, string>; enabled: boolean;
    };
    expect(entry.type).toBe('local');
    expect(entry.command[0]).toBe(FAKE_BIN); // user scope: absolute path
    expect(entry.command).toContain('--surface');
    expect(entry.command).toContain('full');
    expect(entry.environment.GBRAIN_SOURCE).toBeDefined();
    expect(entry.enabled).toBe(true);

    expect(r.out).toContain('scope: user-global');
    expect(r.out).toContain('scope defaulted to user-global');
    expect(r.out).toContain('restart opencode');
    // Pull protocol stated plainly, plugin lane named as a follow-up.
    expect(r.out).toContain('AGENTS.md');
    expect(r.out).toContain('plugin');

    const receipt = readReceipt(home);
    const reg = receipt?.registrations.find((x) => x.host === 'opencode');
    expect(reg?.scope).toBe('user');
    expect(reg?.detail).toBe('mcp');
    rmSync(ws, { recursive: true, force: true });
  });

  test('probe branches: ✓ connected logs the handshake; ✗ failed warns without failing the install', async () => {
    const okWs = await readyWs();
    const ok = await capture(() =>
      runBootstrap(['hooks', '--workspace', okWs, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner: makeRunner().runner,
        probeSpawn: makeProbeSpawn('┌ MCP Servers\n✓ gbrain connected\n').spawn,
      }),
    );
    expect(ok.result).toBe(0);
    expect(ok.out).toContain('✓ gbrain connected');
    rmSync(okWs, { recursive: true, force: true });

    const badWs = await readyWs();
    const bad = await capture(() =>
      runBootstrap(['hooks', '--workspace', badWs, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner: makeRunner().runner,
        probeSpawn: makeProbeSpawn('┌ MCP Servers\n✗ gbrain failed\n   Executable not found in $PATH\n').spawn,
      }),
    );
    expect(bad.result).toBe(0); // config parse-back is authoritative; the probe warns
    expect(bad.err).toContain('✗ gbrain failed');
    rmSync(badWs, { recursive: true, force: true });
  });

  test('probe hardening: ANSI-colored output still matches, and OPENCODE_DISABLE_AUTOUPDATE=1 rides the spawn env', async () => {
    const ws = await readyWs();
    const probe = makeProbeSpawn('\u001b[1m┌ MCP Servers\u001b[0m\n\u001b[32m✓\u001b[0m gbrain connected\n');
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner: makeRunner().runner,
        probeSpawn: probe.spawn,
      }),
    );
    expect(r.result).toBe(0);
    expect(r.out).toContain('✓ gbrain connected'); // ANSI stripped before matching
    // The auto-updater kill rides the spawn's OWN env (no process.env staging).
    expect(probe.calls[0]?.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    rmSync(ws, { recursive: true, force: true });
  });

  test('probe hardening: a ✓ gbrain-remote row never false-positives the bare gbrain name', async () => {
    const ws = await readyWs();
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner: makeRunner().runner,
        probeSpawn: makeProbeSpawn('┌ MCP Servers\n✓ gbrain-remote connected\n✗ gbrain failed\n').spawn,
      }),
    );
    expect(r.result).toBe(0);
    expect(r.out).not.toContain('✓ gbrain connected'); // gbrain-remote must NOT satisfy the success match
    expect(r.err).toContain('✗ gbrain failed');
    rmSync(ws, { recursive: true, force: true });
  });

  test('SECURITY: the user-scope probe spawns from a fresh EMPTY temp dir, never the workspace cwd', async () => {
    const ws = await readyWs();
    const probe = makeProbeSpawn('┌ MCP Servers\n✓ gbrain connected\n');
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner: makeRunner().runner,
        probeSpawn: probe.spawn,
      }),
    );
    expect(r.result).toBe(0);
    expect(probe.calls.length).toBe(1);
    const call = probe.calls[0];
    expect(call.argv).toEqual(['opencode', 'mcp', 'list', '--pure']);
    // A hostile project opencode.json must never load into the probe:
    // opencode merges cwd config and spawns its servers with no trust gate.
    expect(call.cwd).not.toBe(ws);
    expect(call.cwd.startsWith(ws)).toBe(false);
    expect(call.cwd).not.toBe(process.cwd());
    expect(call.cwdWasEmptyDir).toBe(true);
    expect(existsSync(call.cwd)).toBe(false); // cleaned up after the probe
    rmSync(ws, { recursive: true, force: true });
  });

  test('runOpencodeProbe timeout actually KILLS the child (SIGTERM then SIGKILL) and degrades to code 124', async () => {
    const kills: Array<boolean | undefined> = [];
    let resolveExit: (code: number) => void = () => {};
    const handle = {
      exited: new Promise<number>((res) => { resolveExit = res; }),
      kill: (force?: boolean) => {
        kills.push(force);
        if (force) resolveExit(137); // only SIGKILL lands — the child ignored SIGTERM
      },
      stdout: Promise.resolve(''),
      stderr: Promise.resolve(''),
    };
    const res = await runOpencodeProbe(['opencode', 'mcp', 'list', '--pure'], {
      cwd: tmpdir(),
      spawn: () => handle,
      timeoutMs: 50,
    });
    expect(kills).toEqual([undefined, true]); // graceful first, then SIGKILL after the grace window
    expect(res.code).toBe(124); // the existing could-not-confirm branch
    expect(res.stderr).toContain('timeout');
  }, 15_000);
});

describe('opencode workspace lane — explicit project opt-in', () => {
  test('MCP_SCOPE=project → workspace opencode.json, PATH-resolved command, SHARING WARNING, live probe SKIPPED', async () => {
    const ws = await readyWs({ scope: 'project' });
    const { runner } = makeRunner();
    const probe = makeProbeSpawn('┌ MCP Servers\n✓ gbrain connected\n');
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner,
        probeSpawn: probe.spawn,
      }),
    );
    expect(r.result).toBe(0);

    const cfgPath = join(ws, 'opencode.json');
    const parsed = parseOpencodeConfig(readFileSync(cfgPath, 'utf8'), cfgPath);
    const entry = (parsed.mcp as Record<string, unknown>).gbrain as { command: string[] };
    expect(entry.command[0]).toBe('gbrain'); // committed-candidate file: PATH-resolved, never absolute
    expect(r.out).toContain('project (explicit opt-in)');
    expect(r.err).toContain('SHARING WARNING');
    expect(r.err).toContain('"enabled": false');
    // GBRAIN_HOME is set in this suite → the committed-candidate entry embeds
    // a machine-specific path, and the warning must say so (portability).
    expect(r.err).toContain('GBRAIN_HOME');
    expect(r.err).toContain("won't be portable");

    // SECURITY: project scope never runs the live probe — `opencode mcp list`
    // from this workspace would spawn the project config's servers with no
    // trust prompt. The skip note points the human at the manual check.
    expect(probe.calls.length).toBe(0);
    expect(r.out).toContain('probe skipped for project scope');
    expect(r.out).toContain('run `opencode mcp list` yourself');

    const receipt = readReceipt(home);
    const regs = receipt?.registrations.filter((x) => x.host === 'opencode') ?? [];
    expect(regs.some((x) => x.scope === 'project')).toBe(true);
    rmSync(ws, { recursive: true, force: true });
  });

  test("a whitespace-padded ' project ' MCP_SCOPE answer still resolves to project scope (trimmed)", async () => {
    const ws = await readyWs();
    // Hand-edit the recorded answer the way a user editing interview.json
    // might — set-time validation normally rejects padding, but the raw file
    // is user-editable and the scope switch must not silently fall through
    // to the user-global default.
    const statePath = join(ws, 'state', 'interview.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { answers: Record<string, unknown> };
    state.answers.MCP_SCOPE = { value: ' project ' };
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    const probe = makeProbeSpawn('┌ MCP Servers\n✓ gbrain connected\n');
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner: makeRunner().runner,
        probeSpawn: probe.spawn,
      }),
    );
    expect(r.result).toBe(0);
    expect(r.out).toContain('project (explicit opt-in)'); // NOT user-global
    expect(existsSync(join(ws, 'opencode.json'))).toBe(true);
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('opencode two-filename WRITE reconcile (sibling global file)', () => {
  test('a gbrain LOCAL entry in the SIBLING global file is cleaned when the write lands in the other (note printed)', async () => {
    const ws = await readyWs();
    const ocDir = join(xdg, 'opencode');
    rmSync(ocDir, { recursive: true, force: true });
    mkdirSync(ocDir, { recursive: true });
    // Ours-classified local entry (another workspace's) lives in opencode.json;
    // BOTH files exist so the resolver picks .jsonc for the write.
    writeFileSync(
      join(ocDir, 'opencode.json'),
      JSON.stringify({ mcp: { gbrain: { type: 'local', command: ['gbrain', 'serve'], environment: { GBRAIN_SOURCE: 'some-other-ws' } } } }),
    );
    writeFileSync(join(ocDir, 'opencode.jsonc'), '{}\n');
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner: makeRunner().runner,
        probeSpawn: makeProbeSpawn().spawn,
      }),
    );
    expect(r.result).toBe(0);
    // The write landed in .jsonc; the shadow entry in .json is GONE.
    const jsonc = parseOpencodeConfig(readFileSync(join(ocDir, 'opencode.jsonc'), 'utf8'), 'opencode.jsonc');
    expect((jsonc.mcp as Record<string, unknown>).gbrain).toBeDefined();
    const json = parseOpencodeConfig(readFileSync(join(ocDir, 'opencode.json'), 'utf8'), 'opencode.json');
    expect((json.mcp as Record<string, unknown> | undefined)?.gbrain).toBeUndefined();
    expect(r.err).toContain('opencode merges both global filenames');
    rmSync(ocDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  test('a FOREIGN entry in the SIBLING global file refuses the write naming both files (exit 1, both untouched)', async () => {
    const ws = await readyWs();
    const ocDir = join(xdg, 'opencode');
    rmSync(ocDir, { recursive: true, force: true });
    mkdirSync(ocDir, { recursive: true });
    const foreign = JSON.stringify({ mcp: { gbrain: { type: 'local', command: ['npx', 'other-brain'], environment: {} } } });
    writeFileSync(join(ocDir, 'opencode.json'), foreign);
    writeFileSync(join(ocDir, 'opencode.jsonc'), '{}\n');
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner: makeRunner().runner,
        probeSpawn: makeProbeSpawn().spawn,
      }),
    );
    expect(r.result).toBe(1);
    expect(r.err).toContain('not a gbrain-managed entry');
    expect(r.err).toContain(join(ocDir, 'opencode.json'));
    expect(r.err).toContain(join(ocDir, 'opencode.jsonc'));
    expect(readFileSync(join(ocDir, 'opencode.json'), 'utf8')).toBe(foreign);
    expect(readFileSync(join(ocDir, 'opencode.jsonc'), 'utf8')).toBe('{}\n');
    rmSync(ocDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('opencode ownership arbitration', () => {
  test('remote-type mcp.gbrain in the global config → stdio lane steps aside (exit 0, config untouched)', async () => {
    const ws = await readyWs();
    const cfgPath = join(xdg, 'opencode', 'opencode.jsonc');
    mkdirSync(join(xdg, 'opencode'), { recursive: true });
    const harnessOwned = JSON.stringify({
      mcp: { gbrain: { type: 'remote', url: 'http://127.0.0.1:7411/mcp', headers: { Authorization: 'Bearer tok' } } },
    });
    writeFileSync(cfgPath, harnessOwned);
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner: makeRunner().runner,
      }),
    );
    expect(r.result).toBe(0);
    expect(r.out).toContain('bootstrap harness --remove');
    expect(readFileSync(cfgPath, 'utf8')).toBe(harnessOwned);
    rmSync(cfgPath, { force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  test('foreign local mcp.gbrain → refuse loudly (exit 1, config untouched)', async () => {
    const ws = await readyWs();
    const cfgPath = join(xdg, 'opencode', 'opencode.jsonc');
    mkdirSync(join(xdg, 'opencode'), { recursive: true });
    const foreign = JSON.stringify({ mcp: { gbrain: { type: 'local', command: ['npx', 'other-brain'], environment: {} } } });
    writeFileSync(cfgPath, foreign);
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner: makeRunner().runner,
      }),
    );
    expect(r.result).toBe(1);
    expect(r.err).toContain('not a gbrain-managed entry');
    expect(readFileSync(cfgPath, 'utf8')).toBe(foreign);
    rmSync(cfgPath, { force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  test('remote-type mcp.gbrain in the OTHER global filename also steps the stdio lane aside (merge blind spot)', async () => {
    // opencode merges opencode.json AND opencode.jsonc when both exist — a
    // harness-lane remote entry in opencode.json owns the name even when the
    // write resolver would pick opencode.jsonc.
    const ws = await readyWs();
    const ocDir = join(xdg, 'opencode');
    rmSync(ocDir, { recursive: true, force: true });
    mkdirSync(ocDir, { recursive: true });
    const harnessOwned = JSON.stringify({
      mcp: { gbrain: { type: 'remote', url: 'http://127.0.0.1:7411/mcp', headers: { Authorization: 'Bearer tok' } } },
    });
    writeFileSync(join(ocDir, 'opencode.json'), harnessOwned);
    writeFileSync(join(ocDir, 'opencode.jsonc'), '{}\n'); // resolver picks .jsonc — the gate must still see .json
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner: makeRunner().runner,
      }),
    );
    expect(r.result).toBe(0);
    expect(r.out).toContain('bootstrap harness --remove');
    expect(readFileSync(join(ocDir, 'opencode.json'), 'utf8')).toBe(harnessOwned);
    expect(readFileSync(join(ocDir, 'opencode.jsonc'), 'utf8')).toBe('{}\n'); // nothing written anywhere
    rmSync(ocDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });

  test('corrupt global config: hooks lane exits 1 with the parse-refusal copy + snippet, file untouched', async () => {
    const ws = await readyWs();
    const ocDir = join(xdg, 'opencode');
    rmSync(ocDir, { recursive: true, force: true });
    mkdirSync(ocDir, { recursive: true });
    const cfgPath = join(ocDir, 'opencode.jsonc');
    writeFileSync(cfgPath, '{"mcp": {{{');
    const r = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
        runner: makeRunner().runner,
      }),
    );
    expect(r.result).toBe(1);
    expect(r.err).toMatch(/does not parse as JSONC/);
    expect(r.err).toContain('add the entry by hand'); // the paste-by-hand refusal prose, never a stranding
    expect(readFileSync(cfgPath, 'utf8')).toBe('{"mcp": {{{'); // untouched
    rmSync(ocDir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  });
});

describe('opencode uninstall sweep', () => {
  /** Workspace with an ISOLATED gbrain home INSIDE it (uninstall's HOME_GUARD
   * requires a contained, signature-bearing home when GBRAIN_HOME is set) —
   * interview + render run under that home so the receipt lands there. */
  async function isolatedWs(opts: { scope?: 'project' | 'user' } = {}): Promise<{ ws: string; isolatedHome: string }> {
    const ws = mkdtempSync(join(tmpdir(), 'gb-opencode-uninst-ws-'));
    process.env.GBRAIN_HOME = ws; // configDir() appends '.gbrain'
    const isolatedHome = join(ws, '.gbrain');
    mkdirSync(join(isolatedHome, 'brain.pglite'), { recursive: true });
    mkdirSync(join(isolatedHome, 'bootstrap'), { recursive: true });
    writeFileSync(join(isolatedHome, 'config.json'), '{"engine":"pglite"}');
    expect(initState(ws).ok).toBe(true);
    for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
      const r = setAnswer(ws, key, value);
      if (!r.ok) throw new Error(r.message);
    }
    if (opts.scope) expect(setAnswer(ws, 'MCP_SCOPE', opts.scope).ok).toBe(true);
    const h = readBackHash(ws);
    if (!h.ok) throw new Error(h.message);
    expect(confirm(ws, h.hash).ok).toBe(true);
    const render = await capture(() => runBootstrap(['render', '--workspace', ws]));
    expect(render.result).toBe(0);
    return { ws, isolatedHome };
  }

  function restoreSuiteHome(ws: string): void {
    process.env.GBRAIN_HOME = tmpParent;
    rmSync(ws, { recursive: true, force: true });
  }

  test('user-scope install → uninstall removes mcp.gbrain from the global config — BOTH filenames swept even when resolution flips', async () => {
    const ocDir = join(xdg, 'opencode');
    rmSync(ocDir, { recursive: true, force: true });
    mkdirSync(ocDir, { recursive: true });
    // Only opencode.json exists at install time → the registration lands there.
    writeFileSync(join(ocDir, 'opencode.json'), '{}\n');
    const { ws, isolatedHome } = await isolatedWs();
    try {
      const hooks = await capture(() =>
        runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
          runner: makeRunner().runner,
          probeSpawn: makeProbeSpawn().spawn,
        }),
      );
      expect(hooks.result).toBe(0);
      const installed = parseOpencodeConfig(readFileSync(join(ocDir, 'opencode.json'), 'utf8'), 'opencode.json');
      expect((installed.mcp as Record<string, unknown>).gbrain).toBeDefined();

      // NOW an empty opencode.jsonc appears — the path resolver flips to it,
      // but opencode still merges BOTH files, so the sweep must hit .json too.
      writeFileSync(join(ocDir, 'opencode.jsonc'), '{}\n');

      const uninst = await capture(() =>
        runBootstrap(['uninstall', '--workspace', ws, '--home', isolatedHome, '--yes'], {
          runner: makeRunner().runner,
        }),
      );
      expect(uninst.result).toBe(0);
      const after = parseOpencodeConfig(readFileSync(join(ocDir, 'opencode.json'), 'utf8'), 'opencode.json');
      expect((after.mcp as Record<string, unknown> | undefined)?.gbrain).toBeUndefined();
      expect(uninst.out).toContain('removed the gbrain opencode MCP entry');
    } finally {
      rmSync(ocDir, { recursive: true, force: true });
      restoreSuiteHome(ws);
    }
  });

  test('project-scope install → uninstall sweeps the workspace opencode.json entry', async () => {
    const ocDir = join(xdg, 'opencode');
    rmSync(ocDir, { recursive: true, force: true });
    const { ws, isolatedHome } = await isolatedWs({ scope: 'project' });
    try {
      const hooks = await capture(() =>
        runBootstrap(['hooks', '--workspace', ws, '--harness', 'opencode', '--gbrain-bin', FAKE_BIN], {
          runner: makeRunner().runner,
          probeSpawn: makeProbeSpawn().spawn,
        }),
      );
      expect(hooks.result).toBe(0);
      const projPath = join(ws, 'opencode.json');
      expect((parseOpencodeConfig(readFileSync(projPath, 'utf8'), projPath).mcp as Record<string, unknown>).gbrain).toBeDefined();

      const uninst = await capture(() =>
        runBootstrap(['uninstall', '--workspace', ws, '--home', isolatedHome, '--yes'], {
          runner: makeRunner().runner,
        }),
      );
      expect(uninst.result).toBe(0);
      const after = parseOpencodeConfig(readFileSync(projPath, 'utf8'), projPath);
      expect((after.mcp as Record<string, unknown> | undefined)?.gbrain).toBeUndefined();
    } finally {
      rmSync(ocDir, { recursive: true, force: true });
      restoreSuiteHome(ws);
    }
  });
});

describe('opencode door — rendered AGENTS.md pull protocol', () => {
  test('the hookless-harness gate names opencode alongside Codex, with the brain-first prose intact', async () => {
    const ws = await readyWs();
    const agents = readFileSync(join(ws, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('Codex / opencode — pull protocol');
    expect(agents).toContain('Gate 3 — Entity lookup (brain first)');
    expect(agents).toContain('`recall` for hot');
    rmSync(ws, { recursive: true, force: true });
  });
});
