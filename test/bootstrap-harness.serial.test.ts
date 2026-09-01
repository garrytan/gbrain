/**
 * bootstrap-harness.serial.test.ts — `gbrain bootstrap harness` (#4043)
 * orchestration contracts, against applyHarness/removeHarness/statusHarness
 * with fully injected deps (no engine, no network, no real CLIs):
 *
 *  - consent gate: non-TTY without --yes refuses BEFORE any mutation
 *  - full apply: claude argv carries --scope user + bearer; codex wiring is
 *    the managed TOML block (codex CLI never execed); permissions.allow +
 *    five hooks with the harness lane env
 *  - write-ahead receipt [F1]: pending targets exist the moment minting
 *    completes; failures are per-target and --remove consumes the receipt
 *  - mint-first rotation [C7]: the previous token is revoked BY ID only
 *    after all targets confirm + smoke passes; a wiring failure leaves it
 *  - ownership [C8]: a foreign-url registration refuses without --force;
 *    --remove skips url-mismatched registrations with a note
 *  - user-XOR-project hooks [C6]; loopback guard [F3]; --project validation
 *    [F4]; --no-capture subset [C5]; version-skew note [F7]; idempotent
 *    not-found removals [F2]; PGLite live-serve revoke deferral [C9]
 *  - statusHarness: absent-receipt json exit contract, token recovery from
 *    the codex block, revoked-token failure, serve-down failure
 *
 * Serial: dispatcher-level cases set GBRAIN_HOME.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  applyHarness,
  buildConsentBlock,
  codexBlockOwnsName,
  isServeOlderThanScopes,
  SCOPES_MIN_SERVE_VERSION,
  parseClaudeMcpGetBearer,
  parseClaudeMcpGetUrl,
  parseCodexBlockBearer,
  parseHarnessArgs,
  removeHarness,
  statusHarness,
  type HarnessDeps,
  type HarnessFlags,
} from '../src/core/bootstrap/harness.ts';
import { readHarnessReceiptState, harnessReceiptPath, type HarnessTarget } from '../src/core/bootstrap/format.ts';
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_TOML_BLOCK_BEGIN,
  CODEX_TOML_BLOCK_END,
  GBRAIN_HARNESS_MARKER_VALUE,
} from '../src/core/bootstrap/host-specs.ts';
import { AMBIENT_WRITEBACK_BLOCK_BEGIN } from '../src/core/bootstrap/instructions-block.ts';
import type { ExecRunner } from '../src/core/bootstrap/repo.ts';
import type { ConnectProbeResult } from '../src/core/connect-probe.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { VERSION } from '../src/version.ts';
import { withEnv } from './helpers/with-env.ts';

const TOKEN_A = `gbrain_${'a'.repeat(64)}`;
const TOKEN_B = `gbrain_${'b'.repeat(64)}`;
const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const URL = 'http://127.0.0.1:3131/mcp';

interface Fake {
  deps: HarnessDeps;
  calls: string[][];
  revoked: string[];
  mintCalls: Array<{ name: string; scopes: string[]; sourceGrant?: string[] }>;
  out: string[];
  err: string[];
  home: string;
  userSettings: string;
  codexConfig: string;
  opencodeConfig: string;
}

function makeFake(opts: {
  mcpGet?: (name: string) => { code: number; stdout: string; stderr: string };
  mcpAddCode?: number;
  health?: { ok: boolean; version?: string; engine?: string };
  probeOk?: boolean;
  mintQueue?: Array<{ token: string; id: string }>;
  pgliteLive?: boolean;
} = {}): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'gb-harness-'));
  const home = join(dir, '.gbrain');
  mkdirSync(home, { recursive: true });
  const userSettings = join(dir, 'claude-settings.json');
  const codexConfig = join(dir, 'codex-config.toml');
  const opencodeConfig = join(dir, 'opencode.jsonc');
  const calls: string[][] = [];
  const revoked: string[] = [];
  const mintCalls: Array<{ name: string; scopes: string[]; sourceGrant?: string[] }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const mintQueue = opts.mintQueue ?? [{ token: TOKEN_A, id: ID_A }, { token: TOKEN_B, id: ID_B }];
  let mintIdx = 0;
  const health = opts.health ?? { ok: true, version: VERSION, engine: 'postgres' };

  const runner: ExecRunner = async (argv: string[]) => {
    calls.push(argv);
    if (argv[0] === 'claude' && argv[2] === 'get') {
      return opts.mcpGet ? opts.mcpGet(argv[3]) : { code: 1, stdout: '', stderr: 'No MCP server found' };
    }
    if (argv[0] === 'claude' && argv[2] === 'add') {
      return { code: opts.mcpAddCode ?? 0, stdout: '', stderr: opts.mcpAddCode ? 'add failed' : '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  const deps: HarnessDeps = {
    runner,
    gbrainHome: home,
    isTTY: false,
    fetchFn: (async () => {
      if (!health.ok) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ status: 'ok', version: health.version, engine: health.engine }), {
        status: 200,
      });
    }) as unknown as typeof fetch,
    probeIdentity: async (_url: string, probeToken: string): Promise<ConnectProbeResult> => {
      // Token-aware like a REAL serve: only tokens this fixture knows about
      // authenticate — the apply-time canary (a random same-format token)
      // must fail with reason 'auth' or every apply trips the impostor guard.
      const known = new Set([TOKEN_A, TOKEN_B, ...mintQueue.map((m) => m.token)]);
      if (!known.has(probeToken)) return { ok: false, reason: 'auth', message: 'HTTP 401' };
      return (opts.probeOk ?? true)
        ? { ok: true, identity: 'brain "test" (source default)' }
        : { ok: false, reason: 'auth', message: 'HTTP 401' };
    },
    userSettingsPath: userSettings,
    codexConfig,
    opencodeConfig,
    mint: async (o) => {
      mintCalls.push(o as { name: string; scopes: string[]; sourceGrant?: string[] });
      const m = mintQueue[Math.min(mintIdx++, mintQueue.length - 1)];
      return { token: m.token, id: m.id, name: 'bootstrap-harness', scopes: ['read', 'write'] };
    },
    revokeById: async (id: string) => {
      revoked.push(id);
      return true;
    },
    pgliteLiveServe: () => opts.pgliteLive ?? false,
    detectClaude: () => true,
    detectCodex: () => true,
    detectOpencode: () => true,
    gbrainBin: '/opt/fake/gbrain',
    log: (l) => out.push(l),
    logError: (l) => err.push(l),
  };
  return { deps, calls, revoked, mintCalls, out, err, home, userSettings, codexConfig, opencodeConfig };
}

function flags(extra: string[] = []): HarnessFlags {
  return parseHarnessArgs(['--yes', ...extra]);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('parseHarnessArgs', () => {
  test('defaults + aliases: --local and --user-hooks are accepted no-ops', () => {
    const f = parseHarnessArgs(['--local', '--user-hooks']);
    expect(f.error).toBeUndefined();
    expect(f.harness).toBe('all');
    expect(f.tokenName).toBe('bootstrap-harness');
    expect(f.name).toBe('gbrain');
  });
  test('unknown --harness refused; bad --port refused; bad --name refused', () => {
    expect(parseHarnessArgs(['--harness', 'cursor']).error).toMatch(/unknown --harness/);
    expect(parseHarnessArgs(['--port', 'nope']).error).toMatch(/invalid --port/);
    expect(parseHarnessArgs(['--name', 'My Server']).error).toMatch(/invalid --name/);
  });
  test('--project is repeatable and resolved', () => {
    const f = parseHarnessArgs(['--project', '/a', '--project', '/b']);
    expect(f.projects).toEqual(['/a', '/b']);
  });
});

describe('consent gate', () => {
  test('non-TTY without --yes refuses BEFORE any mutation (no mint, no files)', async () => {
    const f = makeFake();
    const code = await applyHarness(parseHarnessArgs([]), f.deps);
    expect(code).toBe(2);
    expect(f.err.join('\n')).toMatch(/pass --yes/);
    expect(existsSync(f.userSettings)).toBe(false);
    expect(existsSync(f.codexConfig)).toBe(false);
    expect(readHarnessReceiptState(f.home)).toEqual({ state: 'absent' });
  });

  test('consent copy: capture is its own numbered item with the no-capture off-ramp', () => {
    const block = buildConsentBlock({
      tokenName: 'bootstrap-harness',
      tokenSupplied: false,
      scopes: ['read', 'write'],
      url: URL,
      wireClaude: true,
      wireCodex: true,
      hooks: true,
      capture: true,
      hookScope: 'user scope',
      name: 'gbrain',
      userSettingsPath: '/u/settings.json',
      codexConfig: '/u/config.toml',
      wireOpencode: true,
      opencodeConfig: '/u/opencode.jsonc',
    });
    expect(block).toMatch(/Session-transcript capture: every Claude Code session/);
    expect(block).toMatch(/no-capture/);
    expect(block).toMatch(/read AND write/);
    expect(block).toMatch(/five lifecycle hooks/);
  });
});

describe('full apply', () => {
  test('claude scope-user argv + permissions + five lane-tagged hooks + codex block + receipt', async () => {
    const f = makeFake();
    const code = await applyHarness(flags(), f.deps);
    expect(code).toBe(0);

    // claude mcp add with --scope user and the bearer header
    const add = f.calls.find((c) => c[0] === 'claude' && c[2] === 'add');
    expect(add).toBeDefined();
    expect(add!.join(' ')).toContain('--scope user');
    expect(add!.join(' ')).toContain(`Authorization: Bearer ${TOKEN_A}`);
    // codex CLI NEVER execed — the TOML block is the single write mechanism
    expect(f.calls.some((c) => c[0] === 'codex')).toBe(false);
    const toml = readFileSync(f.codexConfig, 'utf8');
    expect(toml).toContain(CODEX_TOML_BLOCK_BEGIN);
    // #4574: http_headers inline-table credential — never inline bearer_token
    // (codex-cli >=0.149 rejects it at config load, bricking every session).
    expect(toml).toContain(`http_headers = { Authorization = "Bearer ${TOKEN_A}" }`);
    expect(toml).not.toContain('bearer_token');
    // Harness-lane codex hooks: hooks.json written beside the TARGET's
    // config.toml (never the ambient global), trust entry in the same toml.
    const hooksJson = readFileSync(join(dirname(f.codexConfig), 'hooks.json'), 'utf8');
    expect(hooksJson).toContain('hook session-end --harness codex');
    expect(hooksJson).not.toContain('GBRAIN_SOURCE');
    expect(toml).toContain('gbrain:codex-hooks-trust');
    expect(toml).toContain('trusted_hash');

    const settings = readJson(f.userSettings);
    expect((settings.permissions as { allow: string[] }).allow).toEqual(['mcp__gbrain']);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    const cmd = ((hooks.SessionStart[0] as { hooks: Array<{ command: string }> }).hooks[0]).command;
    expect(cmd).toContain('GBRAIN_HOOK_LANE=harness');
    expect(cmd).toContain('GBRAIN_SOURCE=default');

    const state = readHarnessReceiptState(f.home);
    expect(state.state).toBe('ok');
    const receipt = (state as { receipt: { targets: Array<{ state: string }>; token: { id?: string } } }).receipt;
    expect(receipt.targets.every((t) => t.state === 'confirmed')).toBe(true);
    expect(receipt.token.id).toBe(ID_A);
    // first run: nothing to rotate
    expect(f.revoked).toEqual([]);
  });

  test('--no-capture wires the context events only [C5]', async () => {
    const f = makeFake();
    const code = await applyHarness(flags(['--no-capture', '--harness', 'claude-code']), f.deps);
    expect(code).toBe(0);
    const hooks = readJson(f.userSettings).hooks as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual(['PreCompact', 'SessionStart', 'UserPromptSubmit']);
  });

  test('re-run rotates mint-first [C7]: one entry per event, previous token revoked by id AFTER confirm', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    // second run: existing registration points at OUR url → remove+re-add
    const f2deps: HarnessDeps = {
      ...f.deps,
      runner: async (argv: string[]) => {
        f.calls.push(argv);
        if (argv[0] === 'claude' && argv[2] === 'get') {
          return { code: 0, stdout: `Scope: User\nType: http\nURL: ${URL}\nHeaders:\n  Authorization: Bearer ${TOKEN_A}`, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    expect(await applyHarness(flags(), f2deps)).toBe(0);
    expect(f.revoked).toEqual([ID_A]); // previous id, only after full confirm
    const settings = readJson(f.userSettings);
    const groups = (settings.hooks as Record<string, unknown[]>).SessionStart;
    const entries = groups.flatMap((g) => ((g as { hooks?: unknown[] }).hooks ?? []) as unknown[]);
    expect(entries.length).toBe(1); // marker dedupe, not accumulation
    expect((settings.permissions as { allow: string[] }).allow).toEqual(['mcp__gbrain']);
    expect(readFileSync(f.codexConfig, 'utf8').split(CODEX_TOML_BLOCK_BEGIN).length - 1).toBe(1);
    expect(readFileSync(f.codexConfig, 'utf8')).toContain(TOKEN_B);
  });

  test('wiring failure leaves the OLD token unrevoked and the receipt retryable [C7/F1]', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    const f2 = makeFake({ mcpAddCode: 1, mintQueue: [{ token: TOKEN_B, id: ID_B }] });
    // same home so the prior receipt is visible
    const deps: HarnessDeps = { ...f2.deps, gbrainHome: f.home, userSettingsPath: f.userSettings, codexConfig: f.codexConfig };
    const code = await applyHarness(flags(), deps);
    expect(code).toBe(1);
    expect(f2.revoked).toEqual([]); // old token still live
    const state = readHarnessReceiptState(f.home);
    const receipt = (state as { receipt: { targets: Array<{ state: string; kind: string }>; token: { previous_ids?: string[] } } }).receipt;
    expect(receipt.token.previous_ids).toEqual([ID_A]); // kept for the next converge [X4]
    expect(receipt.targets.some((t) => t.state === 'failed' && t.kind === 'mcp')).toBe(true);
  });

  test('ownership [C8]: foreign-url registration refuses without --force, replaces with it', async () => {
    const foreign = { code: 0, stdout: 'Scope: User\nType: http\nURL: http://127.0.0.1:9999/mcp', stderr: '' };
    const f = makeFake({ mcpGet: () => foreign });
    const code = await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), f.deps);
    expect(code).toBe(1);
    expect(f.err.join('\n')).toMatch(/points at http:\/\/127\.0\.0\.1:9999\/mcp/);
    expect(f.err.join('\n')).toMatch(/--force/);
    expect(f.calls.some((c) => c[0] === 'claude' && c[2] === 'add')).toBe(false);

    const f2 = makeFake({ mcpGet: () => foreign });
    const code2 = await applyHarness(flags(['--harness', 'claude-code', '--no-hooks', '--force']), f2.deps);
    expect(code2).toBe(0);
    expect(f2.calls.some((c) => c[0] === 'claude' && c[2] === 'remove')).toBe(true);
    expect(f2.calls.some((c) => c[0] === 'claude' && c[2] === 'add')).toBe(true);
  });

  test('user-XOR-project hooks [C6]: --project after a user-scope install refuses', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    const proj = mkdtempSync(join(tmpdir(), 'gb-proj-'));
    const code = await applyHarness(flags(['--project', proj]), f.deps);
    expect(code).toBe(2);
    expect(f.err.join('\n')).toMatch(/USER-scope harness hooks.*double-fire/s);
  });

  test('loopback guard [F3]: non-loopback --url without --token refused; allowed with --token', async () => {
    const f = makeFake();
    const code = await applyHarness(flags(['--url', 'http://192.168.1.50:3131/mcp']), f.deps);
    expect(code).toBe(2);
    expect(f.err.join('\n')).toMatch(/gbrain connect/);
    const f2 = makeFake();
    const code2 = await applyHarness(
      flags(['--url', 'http://192.168.1.50:3131/mcp', '--token', TOKEN_A, '--harness', 'codex']),
      f2.deps,
    );
    expect(code2).toBe(0);
    expect(readFileSync(f2.codexConfig, 'utf8')).toContain('http://192.168.1.50:3131/mcp');
  });

  test('--project must exist [F4]', async () => {
    const f = makeFake();
    const code = await applyHarness(flags(['--project', '/definitely/not/a/dir']), f.deps);
    expect(code).toBe(2);
    expect(f.err.join('\n')).toMatch(/does not exist/);
  });

  test('health failure is a hard stop with no writes', async () => {
    const f = makeFake({ health: { ok: false } });
    const code = await applyHarness(flags(), f.deps);
    expect(code).toBe(1);
    expect(f.err.join('\n')).toMatch(/no healthy gbrain serve/);
    expect(readHarnessReceiptState(f.home)).toEqual({ state: 'absent' });
  });

  test('version-skew note [F7] when the serve predates token scoping', async () => {
    const f = makeFake({ health: { ok: true, version: '0.1.0', engine: 'pglite' } });
    const code = await applyHarness(flags(['--harness', 'codex']), f.deps);
    expect(code).toBe(0);
    expect(f.out.join('\n')).toMatch(/predates token scoping.*FULL-ACCESS/s);
  });

  test('postgres engine prints the degradation note; smoke auth-fail names the wrong-brain cause', async () => {
    const f = makeFake({ probeOk: false });
    const code = await applyHarness(flags(['--harness', 'codex']), f.deps);
    expect(code).toBe(1);
    expect(f.out.join('\n')).toMatch(/no_pglite_path.*MCP tools are the active seam/s);
    expect(f.err.join('\n')).toMatch(/GBRAIN_HOME \/ DATABASE_URL/);
  });
});

describe('--remove', () => {
  test('full remove: ours-by-url removed, token revoked by id, receipt consumed; foreign entries survive', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    // seed a foreign allow entry AFTER apply — must survive removal
    const s = readJson(f.userSettings);
    (s.permissions as { allow: string[] }).allow.push('Bash(ls:*)');
    writeFileSync(f.userSettings, JSON.stringify(s, null, 2));

    const removeDeps: HarnessDeps = {
      ...f.deps,
      runner: async (argv: string[]) => {
        f.calls.push(argv);
        if (argv[0] === 'claude' && argv[2] === 'get') {
          return { code: 0, stdout: `Type: http\nURL: ${URL}`, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const code = await removeHarness(parseHarnessArgs(['--remove', '--yes']), removeDeps);
    expect(code).toBe(0);
    expect(f.revoked).toContain(ID_A);
    expect(readHarnessReceiptState(f.home)).toEqual({ state: 'absent' });
    const after = readJson(f.userSettings);
    expect((after.permissions as { allow: string[] }).allow).toEqual(['Bash(ls:*)']);
    expect(after.hooks).toBeUndefined();
    expect(readFileSync(f.codexConfig, 'utf8')).toBe('');
    // The codex SessionEnd hook arm is gone too — removeHarness strips the
    // group from hooks.json beside the target config (file may remain, empty
    // of our entry, or the description-only cleanup deleted it).
    const hooksAfterPath = join(dirname(f.codexConfig), 'hooks.json');
    if (existsSync(hooksAfterPath)) {
      expect(readFileSync(hooksAfterPath, 'utf8')).not.toContain('hook session-end --harness codex');
    }
  });

  test('not-found counts as removed [F2]; url-mismatch skipped with a note [C8]', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), f.deps)).toBe(0);
    const removeDeps: HarnessDeps = {
      ...f.deps,
      runner: async (argv: string[]) => {
        if (argv[0] === 'claude' && argv[2] === 'get') {
          return { code: 0, stdout: 'Type: http\nURL: http://127.0.0.1:7777/mcp', stderr: '' };
        }
        if (argv[0] === 'claude' && argv[2] === 'remove') throw new Error('must not remove a foreign registration');
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const code = await removeHarness(parseHarnessArgs(['--remove', '--yes']), removeDeps);
    expect(code).toBe(0);
    expect(f.out.join('\n')).toMatch(/owned by another install/);
  });

  test('PGLite live serve defers the revoke [C9]: host wiring removed, receipt keeps the token remainder', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    const removeDeps: HarnessDeps = {
      ...f.deps,
      pgliteLiveServe: () => true,
      runner: async (argv: string[]) => {
        if (argv[0] === 'claude' && argv[2] === 'get') return { code: 0, stdout: `URL: ${URL}`, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const code = await removeHarness(parseHarnessArgs(['--remove', '--yes']), removeDeps);
    expect(code).toBe(1);
    expect(f.revoked).toEqual([]);
    expect(f.err.join('\n')).toMatch(/token\(s\) NOT revoked/);
    const state = readHarnessReceiptState(f.home);
    expect(state.state).toBe('ok');
    expect((state as { receipt: { targets: unknown[] } }).receipt.targets).toEqual([]);

    // Red-team CRITICAL: the half-removed remainder (zero targets, minted
    // token still live) must NOT read green — cron sees exit 1 until the
    // deferred revoke lands.
    const statusCode = await statusHarness(parseHarnessArgs(['--status']), removeDeps);
    expect(statusCode).toBe(1);
    expect(f.err.join('\n')).toMatch(/removal pending/);
  });

  test('absent receipt is a calm exit 0', async () => {
    const f = makeFake();
    expect(await removeHarness(parseHarnessArgs(['--remove']), f.deps)).toBe(0);
    expect(f.out.join('\n')).toMatch(/nothing harness-installed/);
  });
});

describe('--status', () => {
  test('absent receipt: human exit 0, --json exit 2 (cron contract)', async () => {
    const f = makeFake();
    expect(await statusHarness(parseHarnessArgs(['--status']), f.deps)).toBe(0);
    expect(await statusHarness(parseHarnessArgs(['--status', '--json']), f.deps)).toBe(2);
  });

  test('green path: token recovered from the codex block, identity verified, exit 0', async () => {
    const f = makeFake({ mcpGet: () => ({ code: 1, stdout: '', stderr: 'nope' }) });
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    const code = await statusHarness(parseHarnessArgs(['--status']), f.deps);
    expect(code).toBe(0);
    expect(f.out.join('\n')).toMatch(/token: OK .*codex config block/);
    expect(f.out.join('\n')).toMatch(/needs a running gbrain serve on Postgres/);
  });

  test('revoked-under-a-green-receipt: token verify fails → exit 1', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    const statusDeps: HarnessDeps = {
      ...f.deps,
      probeIdentity: async () => ({ ok: false, reason: 'auth', message: 'HTTP 401' }),
    };
    const code = await statusHarness(parseHarnessArgs(['--status']), statusDeps);
    expect(code).toBe(1);
    expect(f.out.join('\n')).toMatch(/token: FAILED \(auth\)/);
  });

  test('serve down → exit 1 with honest token line', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    const statusDeps: HarnessDeps = {
      ...f.deps,
      fetchFn: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    };
    const code = await statusHarness(parseHarnessArgs(['--status']), statusDeps);
    expect(code).toBe(1);
    expect(f.out.join('\n')).toMatch(/serve: UNREACHABLE/);
    expect(f.out.join('\n')).toMatch(/not verified \(serve unreachable\)/);
  });
});

describe('outside-voice hardening (X-batch)', () => {
  const ID_C = '33333333-3333-3333-3333-333333333333';
  const TOKEN_C = `gbrain_${'c'.repeat(64)}`;

  test('[X1] explicit --harness codex FORCES wiring with zero detection signals', async () => {
    const f = makeFake();
    const deps: HarnessDeps = { ...f.deps, detectCodex: () => false, detectClaude: () => false };
    const code = await applyHarness(flags(['--harness', 'codex']), deps);
    expect(code).toBe(0);
    expect(readFileSync(f.codexConfig, 'utf8')).toContain(CODEX_TOML_BLOCK_BEGIN);
  });

  test('[X2] --source reaches the mint as a scalar write-floor grant; absent → federation default', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'codex', '--source', 'wiki']), f.deps)).toBe(0);
    expect(f.mintCalls[0].sourceGrant).toEqual(['wiki']);
    const f2 = makeFake();
    expect(await applyHarness(flags(['--harness', 'codex']), f2.deps)).toBe(0);
    expect(f2.mintCalls[0].sourceGrant).toBeUndefined();
  });

  test('[X3] --no-capture RE-RUN unwires the capture events it previously wired', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'claude-code']), f.deps)).toBe(0);
    expect(Object.keys(readJson(f.userSettings).hooks as object).length).toBe(5);
    expect(await applyHarness(flags(['--harness', 'claude-code', '--no-capture']), f.deps)).toBe(0);
    const hooks = readJson(f.userSettings).hooks as Record<string, unknown>;
    expect(Object.keys(hooks).sort()).toEqual(['PreCompact', 'SessionStart', 'UserPromptSubmit']);
  });

  test('[X3] a changed --project set unwires the dropped dir and the receipt stays honest', async () => {
    const projA = mkdtempSync(join(tmpdir(), 'gb-proj-a-'));
    const projB = mkdtempSync(join(tmpdir(), 'gb-proj-b-'));
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'claude-code', '--project', projA]), f.deps)).toBe(0);
    const settingsA = join(projA, '.claude', 'settings.local.json');
    expect(readFileSync(settingsA, 'utf8')).toContain(GBRAIN_HARNESS_MARKER_VALUE);
    expect(await applyHarness(flags(['--harness', 'claude-code', '--project', projB]), f.deps)).toBe(0);
    // A unwired; B wired; receipt records only B
    expect(readFileSync(settingsA, 'utf8')).not.toContain(GBRAIN_HARNESS_MARKER_VALUE);
    expect(readFileSync(join(projB, '.claude', 'settings.local.json'), 'utf8')).toContain(GBRAIN_HARNESS_MARKER_VALUE);
    const state = readHarnessReceiptState(f.home);
    const targets = (state as { receipt: { targets: Array<{ kind: string; scope: string }> } }).receipt.targets;
    expect(targets.filter((t) => t.kind === 'hooks').map((t) => t.scope)).toEqual([projB]);
  });

  test('[X4] a failed rotation accumulates unrevoked ids; the next converge revokes them ALL', async () => {
    const f = makeFake({ mintQueue: [{ token: TOKEN_A, id: ID_A }, { token: TOKEN_B, id: ID_B }, { token: TOKEN_C, id: ID_C }] });
    expect(await applyHarness(flags(['--harness', 'codex']), f.deps)).toBe(0); // mints A
    // run 2 fails post-mint (codex config made unwritable via foreign damage)
    writeFileSync(f.codexConfig, `${CODEX_TOML_BLOCK_BEGIN}\ndamaged`); // one marker only → writer refuses
    expect(await applyHarness(flags(['--harness', 'codex']), f.deps)).toBe(1); // mints B, wiring fails
    expect(f.revoked).toEqual([]);
    // repair the config, run 3 converges: A AND B both revoked
    writeFileSync(f.codexConfig, '');
    expect(await applyHarness(flags(['--harness', 'codex']), f.deps)).toBe(0); // mints C
    expect([...f.revoked].sort()).toEqual([ID_A, ID_B].sort());
    const state = readHarnessReceiptState(f.home);
    expect((state as { receipt: { token: { previous_ids?: string[] } } }).receipt.token.previous_ids).toBeUndefined();
  });

  test('[X5] claude add-failure restores the previous registration (old clients stay connected)', async () => {
    // the OLD registration carries TOKEN_B; the fresh mint is TOKEN_A —
    // fail the new-token add, succeed the restore of the old one.
    const oursGet = {
      code: 0,
      stdout: `Scope: User\nType: http\nURL: ${URL}\nHeaders:\n  Authorization: Bearer ${TOKEN_B}`,
      stderr: '',
    };
    const f = makeFake({ mcpGet: () => oursGet });
    const deps: HarnessDeps = {
      ...f.deps,
      runner: async (argv: string[]) => {
        f.calls.push(argv);
        if (argv[0] === 'claude' && argv[2] === 'get') return oursGet;
        if (argv[0] === 'claude' && argv[2] === 'add' && argv.join(' ').includes(`Bearer ${TOKEN_A}`)) {
          return { code: 1, stdout: '', stderr: 'add failed' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const code = await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), deps);
    expect(code).toBe(1);
    const adds = f.calls.filter((c) => c[0] === 'claude' && c[2] === 'add');
    expect(adds.length).toBe(2); // failed new add + restore of the old registration
    expect(adds[1].join(' ')).toContain(`Bearer ${TOKEN_B}`);
    expect(f.out.join('\n')).toMatch(/previous MCP registration restored/);
  });

  test('[X5] smoke failure rolls the codex block back to the pre-run config', async () => {
    const f = makeFake();
    writeFileSync(f.codexConfig, 'model = "o5"\n');
    expect(await applyHarness(flags(['--harness', 'codex']), f.deps)).toBe(0); // block with TOKEN_A
    const preRun = readFileSync(f.codexConfig, 'utf8');
    const f2deps: HarnessDeps = {
      ...f.deps,
      probeIdentity: async () => ({ ok: false, reason: 'unreachable', message: 'boom' }),
    };
    expect(await applyHarness(flags(['--harness', 'codex']), f2deps)).toBe(1); // mints B, smoke fails
    expect(readFileSync(f.codexConfig, 'utf8')).toBe(preRun); // TOKEN_A block restored
    // The OLD token (ID_A) stays live and wired; the FRESH mint (ID_B) — which
    // was sent to the unverified endpoint — is retired immediately.
    expect(f.revoked).toEqual([ID_B]);
  });

  test('permission pre-approval never lands when the MCP registration itself failed (red-team CRITICAL)', async () => {
    const f = makeFake({ mcpAddCode: 1 }); // `claude mcp add` fails
    const code = await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), f.deps);
    expect(code).toBe(1);
    // The pre-approval string must not bless whatever server owns the name.
    expect(existsSync(f.userSettings) ? JSON.stringify(readJson(f.userSettings)) : '{}').not.toContain('mcp__gbrain');
    const state = readHarnessReceiptState(f.home);
    const perm = (state as { receipt: { targets: Array<{ kind: string; state: string; error?: string }> } }).receipt.targets.find(
      (t) => t.kind === 'permission',
    );
    expect(perm?.state).toBe('failed');
    expect(perm?.error).toMatch(/foreign server/);
  });

  test('a freshly-added pre-approval is removed by the smoke-failure rollback (red-team CRITICAL)', async () => {
    const f = makeFake({ probeOk: false });
    const code = await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), f.deps);
    expect(code).toBe(1);
    const allow = ((readJson(f.userSettings).permissions as { allow?: string[] })?.allow) ?? [];
    expect(allow).not.toContain('mcp__gbrain');
  });

  test('status never recovers a bearer from a registration owned by ANOTHER install (red-team CRITICAL)', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), f.deps)).toBe(0);
    const statusDeps: HarnessDeps = {
      ...f.deps,
      runner: async (argv: string[]) => {
        if (argv[0] === 'claude' && argv[2] === 'get') {
          // The name now points at a DIFFERENT install's serve — its bearer
          // is a foreign credential and must not be transmitted anywhere.
          return {
            code: 0,
            stdout: `gbrain:\n  Scope: User config\n  Type: http\n  URL: http://127.0.0.1:9999/mcp\n  Headers:\n    Authorization: Bearer ${TOKEN_B}\n`,
            stderr: '',
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      probeIdentity: async () => {
        throw new Error('status must NOT probe with a foreign bearer');
      },
    };
    const code = await statusHarness(parseHarnessArgs(['--status']), statusDeps);
    expect(f.out.join('\n')).toMatch(/verify unavailable/);
    expect(code).toBe(0); // honest degrade, all targets confirmed
  });

  test('canary impostor guard: an endpoint that accepts an INVALID credential fails the apply and the fresh mint is revoked', async () => {
    const f = makeFake();
    // Impostor behavior: accept EVERY bearer (it cannot validate any).
    const deps: HarnessDeps = {
      ...f.deps,
      probeIdentity: async () => ({ ok: true, identity: 'brain "faked" (source default)' }),
    };
    const code = await applyHarness(flags(['--harness', 'codex']), deps);
    expect(code).toBe(1);
    expect(f.err.join('\n')).toMatch(/accepted an INVALID credential/);
    expect(f.revoked).toEqual([ID_A]); // the fresh mint never stays live
    // Nothing left wired: the fresh codex block was rolled back.
    const leftover = existsSync(f.codexConfig) ? readFileSync(f.codexConfig, 'utf8') : '';
    expect(leftover).not.toContain('http_headers');
    expect(leftover).not.toContain('bearer_token');
  });

  test('[X5] smoke failure on a FRESH claude add removes the registration (pre-run state) and fails the target', async () => {
    const f = makeFake({ probeOk: false }); // fresh box: mcp get → not found
    const code = await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), f.deps);
    expect(code).toBe(1);
    const removes = f.calls.filter((c) => c[0] === 'claude' && c[2] === 'remove');
    expect(removes.length).toBe(1); // the fresh add is rolled back
    const state = readHarnessReceiptState(f.home);
    expect(state.state).toBe('ok');
    const mcp = (state as { receipt: { targets: Array<{ kind: string; state: string; error?: string }> } }).receipt.targets.find(
      (t) => t.kind === 'mcp',
    );
    expect(mcp?.state).toBe('failed');
    expect(mcp?.error).toMatch(/fresh registration removed/);
  });

  test('[X5] smoke failure after replacing an UNRECOVERABLE registration keeps the new wiring but fails the target honestly', async () => {
    // `claude mcp get` shows our URL but no Authorization header — the old
    // bearer cannot be recovered, so there is nothing to restore.
    const f = makeFake({
      probeOk: false,
      mcpGet: () => ({
        code: 0,
        stdout: `gbrain:\n  Scope: User config\n  Type: http\n  URL: ${URL}\n`,
        stderr: '',
      }),
    });
    const code = await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), f.deps);
    expect(code).toBe(1);
    const state = readHarnessReceiptState(f.home);
    const mcp = (state as { receipt: { targets: Array<{ kind: string; state: string; error?: string }> } }).receipt.targets.find(
      (t) => t.kind === 'mcp',
    );
    expect(mcp?.state).toBe('failed');
    expect(mcp?.error).toMatch(/could not be recovered/);
  });

  test('[X6] a mint crash leaves a write-ahead receipt (pending targets, no token id)', async () => {
    const f = makeFake();
    const deps: HarnessDeps = {
      ...f.deps,
      mint: async () => {
        throw new Error('simulated crash mid-mint');
      },
    };
    await expect(applyHarness(flags(['--harness', 'codex']), deps)).rejects.toThrow(/simulated crash/);
    const state = readHarnessReceiptState(f.home);
    expect(state.state).toBe('ok');
    const receipt = (state as { receipt: { targets: Array<{ state: string }>; token: { id?: string } } }).receipt;
    expect(receipt.token.id).toBeUndefined();
    expect(receipt.targets.every((t) => t.state === 'pending')).toBe(true);
  });

  test('[X7] consent reach matches the actual wiring (codex-only, no-hooks)', () => {
    const block = buildConsentBlock({
      tokenName: 'bootstrap-harness',
      tokenSupplied: true,
      scopes: ['read', 'write'],
      url: URL,
      wireClaude: false,
      wireCodex: true,
      hooks: false,
      capture: true,
      hookScope: 'user scope',
      name: 'gbrain',
      userSettingsPath: '/u/settings.json',
      codexConfig: '/u/config.toml',
      wireOpencode: false,
      opencodeConfig: '/u/opencode.jsonc',
    });
    expect(block).toMatch(/EVERY Codex session/);
    expect(block).not.toMatch(/EVERY Claude Code and Codex session/);
    expect(block).not.toMatch(/opencode/);
    expect(block).toMatch(/No hooks are wired by this invocation/);
    expect(block).toMatch(/written ONLY into the host registrations/);
    expect(block).not.toMatch(/never stored/);
  });

  test('[X7] consent reach names opencode when (and only when) it is wired', () => {
    const block = buildConsentBlock({
      tokenName: 'bootstrap-harness',
      tokenSupplied: false,
      scopes: ['read', 'write'],
      url: URL,
      wireClaude: false,
      wireCodex: false,
      wireOpencode: true,
      hooks: false,
      capture: true,
      hookScope: 'user scope',
      name: 'gbrain',
      userSettingsPath: '/u/settings.json',
      codexConfig: '/u/config.toml',
      opencodeConfig: '/u/opencode.jsonc',
    });
    expect(block).toMatch(/EVERY opencode session/);
    expect(block).toMatch(/mcp\.gbrain remote entry with the bearer token INLINE/);
    expect(block).toMatch(/\{env:…\} interpolation would resolve empty/);
    expect(block).toMatch(/edit the opencode config/);
    expect(block).not.toMatch(/Claude Code session/);
    expect(block).not.toMatch(/Codex session/);
  });

  test('[X8] a pre-existing permissions.allow entry is recorded as such and SURVIVES --remove', async () => {
    const f = makeFake();
    mkdirSync(join(f.userSettings, '..'), { recursive: true });
    writeFileSync(f.userSettings, JSON.stringify({ permissions: { allow: ['mcp__gbrain'] } }));
    expect(await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), f.deps)).toBe(0);
    const state = readHarnessReceiptState(f.home);
    const perm = (state as { receipt: { targets: Array<{ kind: string; mechanism?: string }> } }).receipt.targets.find(
      (t) => t.kind === 'permission',
    );
    expect(perm?.mechanism).toBe('pre-existing');
    const removeDeps: HarnessDeps = {
      ...f.deps,
      runner: async (argv: string[]) => {
        if (argv[0] === 'claude' && argv[2] === 'get') return { code: 0, stdout: `URL: ${URL}`, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    expect(await removeHarness(parseHarnessArgs(['--remove', '--yes']), removeDeps)).toBe(0);
    expect((readJson(f.userSettings).permissions as { allow: string[] }).allow).toEqual(['mcp__gbrain']);
    expect(f.out.join('\n')).toMatch(/predates the harness install — left in place/);
  });

  test('[X10] a narrowed --surface serve (unknown-tool tool_error) is verified, not broken', async () => {
    const f = makeFake();
    const deps: HarnessDeps = {
      ...f.deps,
      // Token-aware like a real narrowed serve: bearer auth still happens
      // BEFORE tool dispatch, so the canary (unknown token) gets 401 and only
      // a VALID token reaches the unknown-tool tool_error.
      probeIdentity: async (_url: string, probeToken: string) =>
        probeToken === TOKEN_A || probeToken === TOKEN_B
          ? { ok: false, reason: 'tool_error' as const, message: 'Unknown tool: get_brain_identity' }
          : { ok: false, reason: 'auth' as const, message: 'HTTP 401' },
    };
    expect(await applyHarness(flags(['--harness', 'codex']), deps)).toBe(0);
    expect(f.out.join('\n')).toMatch(/narrowed --surface.*Counted as verified/s);
    expect(await statusHarness(parseHarnessArgs(['--status']), deps)).toBe(0);
    expect(f.out.join('\n')).toMatch(/token: OK .*narrowed --surface/);
  });

  test('[X13] registrar mode (non-loopback url + token) wires MCP only — no hooks', async () => {
    const f = makeFake();
    const code = await applyHarness(
      flags(['--url', 'http://192.168.1.50:3131/mcp', '--token', TOKEN_A]),
      f.deps,
    );
    expect(code).toBe(0);
    expect(f.out.join('\n')).toMatch(/registrar mode.*hooks are NOT wired/s);
    expect(readJson(f.userSettings).hooks).toBeUndefined();
    // the discarded-warning fix: http-bearer warning surfaces
    expect(f.err.join('\n')).toMatch(/unencrypted/);
  });

  test('[X14] conflicting or value-less invocations fail closed', () => {
    expect(parseHarnessArgs(['--url', 'http://h/mcp', '--port', '3131']).error).toMatch(/not both/);
    expect(parseHarnessArgs(['--status', '--remove']).error).toMatch(/not both/);
    expect(parseHarnessArgs(['--token']).error).toMatch(/requires a value/);
    expect(parseHarnessArgs(['--url', '--yes']).error).toMatch(/requires a value/);
    // A dropped --project would silently WIDEN hook wiring to user scope.
    expect(parseHarnessArgs(['--project']).error).toMatch(/requires a directory value/);
    expect(parseHarnessArgs(['--project', '--no-capture', '--yes']).error).toMatch(/requires a directory value/);
  });
});

describe('parse helpers', () => {
  test('parseClaudeMcpGetUrl + parseClaudeMcpGetBearer read the live-verified shape', () => {
    const out = 'gbrain:\n  Scope: User config\n  Type: http\n  URL: http://127.0.0.1:3131/mcp\n  Headers:\n    Authorization: Bearer gbrain_abc123\n';
    expect(parseClaudeMcpGetUrl(out)).toEqual({ found: true, url: 'http://127.0.0.1:3131/mcp' });
    expect(parseClaudeMcpGetBearer(out)).toBe('gbrain_abc123');
    expect(parseClaudeMcpGetUrl('nothing here')).toEqual({ found: false });
  });

  test('parseCodexBlockBearer reads only OUR managed block', () => {
    const ours = [
      '[mcp_servers.other]',
      'http_headers = { Authorization = "Bearer not_ours" }',
      CODEX_TOML_BLOCK_BEGIN,
      '[mcp_servers.gbrain]',
      'url = "http://127.0.0.1:3131/mcp"',
      `http_headers = { Authorization = "Bearer ${TOKEN_A}" }`,
      `# gbrain:${GBRAIN_HARNESS_MARKER_VALUE} end`,
      '',
    ].join('\n');
    expect(parseCodexBlockBearer(ours)).toBe(TOKEN_A);
    expect(parseCodexBlockBearer('[mcp_servers.x]\nhttp_headers = { Authorization = "Bearer y" }\n')).toBeNull();
    // [C8] parity with the claude lane: with an expected url, a block pointing
    // at another brain's serve must NOT hand its bearer over.
    expect(parseCodexBlockBearer(ours, URL)).toBe(TOKEN_A);
    expect(parseCodexBlockBearer(ours, 'http://127.0.0.1:9999/mcp')).toBeNull();
  });

  test('parseCodexBlockBearer legacy fallback: pre-#4574 bearer_token blocks still recover', () => {
    // Machines wired by older gbrain carry `bearer_token = "<t>"` — status
    // and rotation must still read the token so the next apply can fix them.
    const legacy = [
      CODEX_TOML_BLOCK_BEGIN,
      '[mcp_servers.gbrain]',
      'url = "http://127.0.0.1:3131/mcp"',
      `bearer_token = "${TOKEN_A}"`,
      `# gbrain:${GBRAIN_HARNESS_MARKER_VALUE} end`,
      '',
    ].join('\n');
    expect(parseCodexBlockBearer(legacy)).toBe(TOKEN_A);
    expect(parseCodexBlockBearer(legacy, URL)).toBe(TOKEN_A);
    expect(parseCodexBlockBearer(legacy, 'http://127.0.0.1:9999/mcp')).toBeNull();
    // A hand-edited non-Bearer Authorization header is not ours to recover.
    const handEdited = legacy.replace(
      `bearer_token = "${TOKEN_A}"`,
      'http_headers = { Authorization = "Basic dXNlcjpwdw==" }',
    );
    expect(parseCodexBlockBearer(handEdited)).toBeNull();
  });

  test('codexBlockOwnsName: only a table INSIDE the managed block counts as ours', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-owns-'));
    const cfg = join(dir, 'config.toml');
    // Foreign stdio-lane table OUTSIDE the block + our block owning a
    // different name: the foreign name must NOT read as harness-owned.
    writeFileSync(
      cfg,
      [
        '[mcp_servers.gbrain]',
        'command = "gbrain"',
        CODEX_TOML_BLOCK_BEGIN,
        '[mcp_servers.other]',
        'url = "http://127.0.0.1:3131/mcp"',
        CODEX_TOML_BLOCK_END,
        '',
      ].join('\n'),
    );
    expect(codexBlockOwnsName(cfg, 'other')).toBe(true);
    expect(codexBlockOwnsName(cfg, 'gbrain')).toBe(false);
    expect(codexBlockOwnsName(join(dir, 'absent.toml'), 'gbrain')).toBe(false);
    writeFileSync(cfg, '[mcp_servers.gbrain]\nurl = "http://x/mcp"\n'); // no block at all
    expect(codexBlockOwnsName(cfg, 'gbrain')).toBe(false);
  });

  test('isServeOlderThanScopes boundary matrix — pinned to the first scope-aware release, NOT the moving CLI version', () => {
    expect(isServeOlderThanScopes(SCOPES_MIN_SERVE_VERSION)).toBe(false); // equal — not older
    expect(isServeOlderThanScopes(VERSION)).toBe(false); // the current CLI's own serve is always scope-aware
    expect(isServeOlderThanScopes('999.0.0')).toBe(false); // newer serve
    expect(isServeOlderThanScopes('0.1.0')).toBe(true); // clearly pre-scopes
    // The pin is what keeps the NEXT release honest: a 0.45.14.0 serve must
    // never be flagged pre-scopes once the CLI moves past it.
    expect(isServeOlderThanScopes('0.45.14.0')).toBe(false);
    expect(isServeOlderThanScopes('0.45.13.0')).toBe(true);
    // 3-segment historical form pads with 0: X.Y.Z === X.Y.Z.0.
    expect(isServeOlderThanScopes('0.45.14')).toBe(false);
  });
});

describe('plugin-lane collision WARN on the codex wire (never a refusal)', () => {
  test('pre-existing enabled gbrain plugin → loud WARNING, managed block still written', async () => {
    const f = makeFake();
    // Seed the codex config with an ENABLED gbrain plugin BEFORE the wire —
    // the harness lane (HTTP, framework-spawned sessions) may legitimately
    // coexist with the plugin's stdio serve, so the wire proceeds.
    writeFileSync(f.codexConfig, '[plugins."gbrain@gbrain"]\nenabled = true\n');
    const code = await applyHarness(flags(['--harness', 'codex']), f.deps);
    expect(code).toBe(0);
    const warn = f.err.find((l) => l.includes('codex plugin also provides an MCP server'));
    expect(warn).toBeDefined();
    expect(warn).toContain("'gbrain@gbrain'");
    expect(warn).toContain('codex plugin remove gbrain');
    // Write proceeded: the managed block landed next to the plugin entry.
    const toml = readFileSync(f.codexConfig, 'utf8');
    expect(toml).toContain(CODEX_TOML_BLOCK_BEGIN);
    expect(toml).toContain('[plugins."gbrain@gbrain"]');
  }, 30_000);

  test('no plugin entry → no collision WARNING (zero noise)', async () => {
    const f = makeFake();
    const code = await applyHarness(flags(['--harness', 'codex']), f.deps);
    expect(code).toBe(0);
    expect(f.err.some((l) => l.includes('plugin also provides'))).toBe(false);
  }, 30_000);
});

describe('opencode harness target (managed JSONC entry)', () => {
  test('apply --harness opencode: inline-bearer remote entry written 0600, receipt confirmed, exit 0', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'opencode']), f.deps)).toBe(0);
    const text = readFileSync(f.opencodeConfig, 'utf8');
    const parsed = JSON.parse(text) as { mcp: Record<string, { type: string; url: string; headers: Record<string, string>; enabled: boolean } > };
    expect(parsed.mcp.gbrain.type).toBe('remote');
    expect(parsed.mcp.gbrain.url).toBe(URL);
    expect(parsed.mcp.gbrain.headers.Authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(parsed.mcp.gbrain.enabled).toBe(true);
    expect(statSync(f.opencodeConfig).mode & 0o777).toBe(0o600);
    const state = readHarnessReceiptState(f.home);
    const receipt = (state as { receipt: { targets: Array<{ host: string; kind: string; state: string; mechanism?: string }> } }).receipt;
    const t = receipt.targets.find((x) => x.host === 'opencode');
    expect(t?.state).toBe('confirmed');
    expect(t?.mechanism).toBe('jsonc-entry');
    // No opencode CLI is ever execed — the writer IS the mechanism.
    expect(f.calls.some((argv) => argv[0] === 'opencode')).toBe(false);
    expect(f.out.join('\n')).toMatch(/opencode wired: mcp\.gbrain remote entry/);
    expect(f.out.join('\n')).toMatch(/Restart opencode/);
  });

  test('rotation across a url change: the prior receipt url classifies the old entry as ours and it is replaced', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'opencode']), f.deps)).toBe(0);
    // Re-apply against a DIFFERENT serve url — the existing entry carries the
    // old url and must be recognized via the prior receipt, not refused.
    expect(await applyHarness(flags(['--harness', 'opencode', '--url', 'http://127.0.0.1:4242/mcp']), f.deps)).toBe(0);
    const parsed = JSON.parse(readFileSync(f.opencodeConfig, 'utf8')) as { mcp: Record<string, { url: string; headers: Record<string, string> }> };
    expect(parsed.mcp.gbrain.url).toBe('http://127.0.0.1:4242/mcp');
    expect(parsed.mcp.gbrain.headers.Authorization).toBe(`Bearer ${TOKEN_B}`); // rotated mint
  });

  test('a FOREIGN mcp.gbrain entry refuses (failed target, exit 1) and survives untouched', async () => {
    const f = makeFake();
    const foreign = JSON.stringify({ mcp: { gbrain: { type: 'remote', url: 'https://other.example/mcp', headers: {} } } });
    writeFileSync(f.opencodeConfig, foreign);
    expect(await applyHarness(flags(['--harness', 'opencode']), f.deps)).toBe(1);
    expect(readFileSync(f.opencodeConfig, 'utf8')).toBe(foreign);
    expect(f.err.join('\n')).toMatch(/not a gbrain-managed entry/);
    // Impostor-guard economics hold: the fresh mint is revoked when wiring fails.
    const state = readHarnessReceiptState(f.home);
    const t = (state as { receipt: { targets: Array<{ host: string; state: string }> } }).receipt.targets.find((x) => x.host === 'opencode');
    expect(t?.state).toBe('failed');
  });

  test('failed smoke rolls the fresh opencode entry back and revokes the fresh mint', async () => {
    const f = makeFake({ probeOk: false });
    expect(await applyHarness(flags(['--harness', 'opencode']), f.deps)).toBe(1);
    // Fresh add (no prior entry) → rollback removes it entirely.
    const parsed = JSON.parse(readFileSync(f.opencodeConfig, 'utf8')) as { mcp?: Record<string, unknown> };
    expect(parsed.mcp?.gbrain).toBeUndefined();
    expect(f.revoked).toContain(ID_A);
    expect(f.out.join('\n') + f.err.join('\n')).toMatch(/rolled back to the previous opencode config/);
  });

  test('[X5] smoke failure on a RE-APPLY rolls the opencode config back byte-for-byte (codex-lane mirror)', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'opencode']), f.deps)).toBe(0); // entry with TOKEN_A
    const preRun = readFileSync(f.opencodeConfig, 'utf8');
    const f2deps: HarnessDeps = {
      ...f.deps,
      probeIdentity: async () => ({ ok: false, reason: 'unreachable', message: 'boom' }),
    };
    expect(await applyHarness(flags(['--harness', 'opencode']), f2deps)).toBe(1); // mints B, smoke fails
    expect(readFileSync(f.opencodeConfig, 'utf8')).toBe(preRun); // TOKEN_A entry restored, byte-identical
    // The OLD token (ID_A) stays live and wired; the FRESH mint (ID_B) — sent
    // to the unverified endpoint — is retired immediately.
    expect(f.revoked).toEqual([ID_B]);
  });

  test('a corrupt opencode config fails the target WITHOUT leaking the minted bearer (snippet placeholder + redaction)', async () => {
    const f = makeFake();
    writeFileSync(f.opencodeConfig, '{"mcp": {{{');
    expect(await applyHarness(flags(['--harness', 'opencode']), f.deps)).toBe(1);
    const err = f.err.join('\n');
    expect(err).toMatch(/does not parse as JSONC/);
    expect(err).not.toContain(TOKEN_A); // neither the snippet nor the message may carry the mint
    const state = readHarnessReceiptState(f.home);
    const t = (state as { receipt: { targets: Array<{ host: string; state: string; error?: string }> } }).receipt.targets.find(
      (x) => x.host === 'opencode',
    );
    expect(t?.state).toBe('failed');
    expect(t?.error ?? '').not.toContain(TOKEN_A); // the receipt is durable — no token in it either
    expect(readFileSync(f.opencodeConfig, 'utf8')).toBe('{"mcp": {{{'); // untouched
  });

  test('--status recovers the bearer from the opencode entry (url-matched) and verifies it', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'opencode']), f.deps)).toBe(0);
    expect(await statusHarness(parseHarnessArgs(['--status']), f.deps)).toBe(0);
    const out = f.out.join('\n');
    expect(out).toMatch(/token: OK \('bootstrap-harness' via opencode config entry/);
  });

  test('--remove removes OUR entry; an entry at a different url is skipped with a note', async () => {
    const f = makeFake();
    expect(await applyHarness(flags(['--harness', 'opencode']), f.deps)).toBe(0);
    expect(await removeHarness(parseHarnessArgs(['--remove']), f.deps)).toBe(0);
    const parsed = JSON.parse(readFileSync(f.opencodeConfig, 'utf8')) as { mcp?: Record<string, unknown> };
    expect(parsed.mcp?.gbrain).toBeUndefined();
    expect(f.out.join('\n')).toMatch(/opencode managed entry removed/);
    expect(f.revoked).toContain(ID_A);

    // Second install; then the entry is retargeted by "another install".
    const g = makeFake();
    expect(await applyHarness(flags(['--harness', 'opencode']), g.deps)).toBe(0);
    const hijacked = JSON.parse(readFileSync(g.opencodeConfig, 'utf8')) as { mcp: Record<string, { url: string }> };
    hijacked.mcp.gbrain.url = 'http://127.0.0.1:9999/mcp';
    writeFileSync(g.opencodeConfig, JSON.stringify(hijacked));
    expect(await removeHarness(parseHarnessArgs(['--remove']), g.deps)).toBe(0);
    expect(g.out.join('\n')).toMatch(/does not match this receipt's url .* skipping/);
    const kept = JSON.parse(readFileSync(g.opencodeConfig, 'utf8')) as { mcp: Record<string, unknown> };
    expect(kept.mcp.gbrain).toBeDefined(); // never delete what is not provably ours
  });
});

describe('ambient-writeback instruction blocks (kind: instructions, WP3)', () => {
  // Engine-free file-plane fake: memory.auto_writeback=salient enables the lane.
  const WB_ON = (): GBrainConfig => ({ engine: 'pglite', memory: { auto_writeback: 'salient' } });
  // resolveDeps derives the instruction-file paths from the INJECTED settings/
  // config paths' directory (production: the host-specs defaults), so both
  // land inside the fake's temp dir.
  const memoryPath = (f: Fake) => join(dirname(f.userSettings), 'CLAUDE.md');
  const agentsPath = (f: Fake) => join(dirname(f.codexConfig), 'AGENTS.md');
  const overridePath = (f: Fake) => join(dirname(f.codexConfig), 'AGENTS.override.md');
  const instrTargets = (home: string): HarnessTarget[] => {
    const state = readHarnessReceiptState(home);
    return state.state === 'ok' ? state.receipt.targets.filter((t) => t.kind === 'instructions') : [];
  };

  test('enabled config plans + confirms BOTH instructions targets; blocks carry sentinel + mode + serve url; consent names the files', async () => {
    const f = makeFake();
    const deps: HarnessDeps = { ...f.deps, loadFileConfig: WB_ON };
    expect(await applyHarness(flags(), deps)).toBe(0);
    for (const path of [memoryPath(f), agentsPath(f)]) {
      const text = readFileSync(path, 'utf8');
      expect(text).toContain(AMBIENT_WRITEBACK_BLOCK_BEGIN);
      expect(text).toContain('mode: salient');
      expect(text).toContain(`serve: ${URL}`); // [OV-A3] the header names the endpoint
    }
    const targets = instrTargets(f.home);
    expect(targets.map((t) => [t.host, t.state, t.mechanism]).sort()).toEqual([
      ['claude-code', 'confirmed', 'managed-block'],
      ['codex', 'confirmed', 'managed-block'],
    ]);
    // Consent names the writes before they happen [X7 parity].
    expect(f.out.join('\n')).toMatch(/Ambient memory writeback is ENABLED/);
    expect(f.out.join('\n')).toContain(memoryPath(f));
    expect(f.out.join('\n')).toContain(agentsPath(f));
  });

  test('a failed MCP registration blocks THAT host\'s instruction install; the other host proceeds (codex re-review)', async () => {
    const f = makeFake({ mcpAddCode: 1 }); // claude `mcp add` fails; codex toml write succeeds
    const deps: HarnessDeps = { ...f.deps, loadFileConfig: WB_ON };
    const code = await applyHarness(flags(), deps);
    expect(code).toBe(1);
    // No block may direct ambient saves through a registration that never
    // landed — the claude lane skips; codex (whose registration landed)
    // still converges normally.
    expect(existsSync(memoryPath(f))).toBe(false);
    const targets = instrTargets(f.home);
    const claude = targets.find((t) => t.host === 'claude-code');
    expect(claude?.state).toBe('failed');
    expect(String(claude?.error)).toContain('did not land');
  });

  test('a failed smoke rolls the instruction blocks back too — no block outlives its unverified registration (codex re-review)', async () => {
    const f = makeFake({ probeOk: false }); // apply succeeds, final smoke fails (auth)
    const deps: HarnessDeps = { ...f.deps, loadFileConfig: WB_ON };
    const code = await applyHarness(flags(), deps);
    expect(code).toBe(1);
    for (const path of [memoryPath(f), agentsPath(f)]) {
      if (!existsSync(path)) continue; // stripped block may leave an empty-of-ours file
      expect(readFileSync(path, 'utf8')).not.toContain(AMBIENT_WRITEBACK_BLOCK_BEGIN);
    }
    for (const t of instrTargets(f.home)) {
      expect(t.state).toBe('failed');
      expect(String(t.error)).toContain('failed smoke');
    }
  });

  test('registrar mode (non-loopback --url): NO instruction blocks even with local writeback on — the remote brain never opted in (adversarial review)', async () => {
    const f = makeFake();
    const deps: HarnessDeps = { ...f.deps, loadFileConfig: WB_ON };
    const code = await applyHarness(
      flags(['--url', 'http://192.168.1.50:3131/mcp', '--token', TOKEN_A, '--harness', 'codex']),
      deps,
    );
    expect(code).toBe(0);
    // The MCP registration lands; the block does NOT (the local file mirror
    // speaks for the LOCAL brain — a block here would order agents to save
    // into the remote brain without its brain-scoped opt-in).
    expect(readFileSync(f.codexConfig, 'utf8')).toContain('http://192.168.1.50:3131/mcp');
    expect(existsSync(agentsPath(f))).toBe(false);
    expect(instrTargets(f.home)).toEqual([]);
    expect(f.out.join('\n')).toContain('registrar mode: ambient-writeback instruction blocks are NOT installed');
  });

  test('re-apply is idempotent: both instruction files byte-identical', async () => {
    const f = makeFake();
    const deps: HarnessDeps = { ...f.deps, loadFileConfig: WB_ON };
    expect(await applyHarness(flags(), deps)).toBe(0);
    const claudeOnce = readFileSync(memoryPath(f), 'utf8');
    const agentsOnce = readFileSync(agentsPath(f), 'utf8');
    expect(await applyHarness(flags(), deps)).toBe(0);
    expect(readFileSync(memoryPath(f), 'utf8')).toBe(claudeOnce);
    expect(readFileSync(agentsPath(f), 'utf8')).toBe(agentsOnce);
  });

  test('[OV-A4] AGENTS.override.md present → codex target FAILS with the actionable error; claude target still succeeds', async () => {
    const f = makeFake();
    writeFileSync(overridePath(f), '# my override\n');
    const deps: HarnessDeps = { ...f.deps, loadFileConfig: WB_ON };
    expect(await applyHarness(flags(), deps)).toBe(1);
    const targets = instrTargets(f.home);
    const codex = targets.find((t) => t.host === 'codex');
    expect(codex?.state).toBe('failed');
    expect(codex?.error).toMatch(/AGENTS\.override\.md/);
    expect(codex?.error).toMatch(/ignores/);
    // Never a dead integration: AGENTS.md was NOT written.
    expect(existsSync(agentsPath(f))).toBe(false);
    // The claude lane is unaffected.
    expect(targets.find((t) => t.host === 'claude-code')?.state).toBe('confirmed');
    expect(readFileSync(memoryPath(f), 'utf8')).toContain(AMBIENT_WRITEBACK_BLOCK_BEGIN);
  });

  test('[OV-A2/OV2-2] config back OFF converges: blocks stripped (files kept), receipt cleared, advisory printed', async () => {
    const f = makeFake();
    writeFileSync(memoryPath(f), '# mine\n');
    writeFileSync(agentsPath(f), '# agents\n');
    expect(await applyHarness(flags(), { ...f.deps, loadFileConfig: WB_ON })).toBe(0);
    expect(readFileSync(memoryPath(f), 'utf8')).toContain(AMBIENT_WRITEBACK_BLOCK_BEGIN);
    // Second apply with the DEFAULT off config (makeFake injects none; the
    // preload-pinned GBRAIN_HOME scratch has no config.json → off).
    expect(await applyHarness(flags(), f.deps)).toBe(0);
    // Non-block content restored EXACTLY; the files are never deleted.
    expect(readFileSync(memoryPath(f), 'utf8')).toBe('# mine\n');
    expect(readFileSync(agentsPath(f), 'utf8')).toBe('# agents\n');
    expect(instrTargets(f.home)).toEqual([]);
    expect(f.out.join('\n')).toMatch(
      /ambient writeback off — enable with `gbrain config set memory\.auto_writeback salient` and re-run\./,
    );
  });

  test('--remove strips the blocks and leaves the files in place', async () => {
    const f = makeFake();
    writeFileSync(memoryPath(f), '# keep\n');
    expect(await applyHarness(flags(), { ...f.deps, loadFileConfig: WB_ON })).toBe(0);
    expect(await removeHarness(parseHarnessArgs(['--remove', '--yes']), f.deps)).toBe(0);
    expect(readFileSync(memoryPath(f), 'utf8')).toBe('# keep\n');
    // The codex agents file was created by the apply (block only) — emptied, NEVER deleted.
    expect(existsSync(agentsPath(f))).toBe(true);
    expect(readFileSync(agentsPath(f), 'utf8')).not.toContain(AMBIENT_WRITEBACK_BLOCK_BEGIN);
    expect(readHarnessReceiptState(f.home)).toEqual({ state: 'absent' });
  });

  test('--status probes sentinel presence: installed → missing → override-blocked (exit reflects it)', async () => {
    const f = makeFake();
    const deps: HarnessDeps = { ...f.deps, loadFileConfig: WB_ON };
    expect(await applyHarness(flags(), deps)).toBe(0);
    expect(await statusHarness(parseHarnessArgs(['--status']), deps)).toBe(0);
    expect(f.out.join('\n')).toMatch(/ambient-writeback block \(claude-code\): installed/);
    expect(f.out.join('\n')).toMatch(/ambient-writeback block \(codex\): installed/);
    // Hand-emptied AGENTS.md → missing, exit 1.
    writeFileSync(agentsPath(f), '# emptied\n');
    f.out.length = 0;
    expect(await statusHarness(parseHarnessArgs(['--status']), deps)).toBe(1);
    expect(f.out.join('\n')).toMatch(/ambient-writeback block \(codex\): missing/);
    // Override file appears → override-blocked (checked in status too), exit 1.
    writeFileSync(overridePath(f), '# override\n');
    f.out.length = 0;
    expect(await statusHarness(parseHarnessArgs(['--status', '--json']), deps)).toBe(1);
    const payload = JSON.parse(f.out[f.out.length - 1]) as {
      instructions_blocks: Array<{ host: string; probe: string }>;
    };
    expect(payload.instructions_blocks.find((p) => p.host === 'codex')?.probe).toBe('override-blocked');
    expect(payload.instructions_blocks.find((p) => p.host === 'claude-code')?.probe).toBe('installed');
  });

  test('default file-plane read honors GBRAIN_HOME: config.json with salient enables the target without an injected loader', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gb-wb-home-'));
    mkdirSync(join(parent, '.gbrain'), { recursive: true });
    writeFileSync(
      join(parent, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', memory: { auto_writeback: 'salient' } }),
    );
    const f = makeFake();
    await withEnv({ GBRAIN_HOME: parent }, async () => {
      expect(await applyHarness(flags(['--harness', 'claude-code', '--no-hooks']), f.deps)).toBe(0);
    });
    expect(readFileSync(memoryPath(f), 'utf8')).toContain(AMBIENT_WRITEBACK_BLOCK_BEGIN);
    // claude-only run: no codex target, no codex agents-file write.
    expect(existsSync(agentsPath(f))).toBe(false);
    expect(instrTargets(f.home).map((t) => t.host)).toEqual(['claude-code']);
  });
});
