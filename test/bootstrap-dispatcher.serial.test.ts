/**
 * bootstrap dispatcher (src/commands/bootstrap.ts) — engine-free contract
 * tests against the REAL runBootstrap with a recording exec runner:
 *
 *  - consent-skip decline: `interview --skip HOOKS_CONSENT` must DECLINE hooks
 *    (the bank default 'yes' must not win over an explicit skip).
 *  - receipt overwrite guard [CX2-12] wired into every writer: a NEWER-format
 *    receipt refuses render/hooks/attach with an upgrade-first error; a
 *    CORRUPT receipt is backed up loudly to `.broken-<ts>` and rewritten fresh.
 *  - uninstall --delete-brain: the facts-export offer prints BEFORE deletion,
 *    and workspaceBrainStats feeds source/page enumeration engine-free.
 *
 * Serial: mutates GBRAIN_HOME.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBootstrap, workspaceBrainStats } from '../src/commands/bootstrap.ts';
import type { ExecRunner } from '../src/core/bootstrap/repo.ts';
import { attachWorkspace } from '../src/core/bootstrap/attach.ts';
import {
  harnessReceiptPath,
  readReceipt,
  receiptPath,
  writeHarnessReceipt,
  writeManifest,
  type HarnessReceipt,
  type InstallReceipt,
} from '../src/core/bootstrap/format.ts';
import { GBRAIN_HOOK_MARKER_KEY, GBRAIN_HOOK_MARKER_VALUE } from '../src/core/bootstrap/host-specs.ts';
import { deriveWorkspaceSourceId } from '../src/core/bootstrap/verify.ts';
import { initState, setAnswer, skipAnswer, confirm, readBackHash } from '../src/core/bootstrap/interview.ts';

let tmpParent: string; // GBRAIN_HOME parent (configDir appends .gbrain)
let home: string;
let ws: string;
let prevHome: string | undefined;

const REQUIRED_ANSWERS: Record<string, string> = {
  AGENT_NAME: 'Dispatch',
  PRINCIPAL_NAME: 'Pat Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research group; values signal over noise.',
  VOICE_REGISTER: 'Direct: three options, the second one wins.',
};

/** Recording fake runner — never spawns anything. */
function makeRunner(): { runner: ExecRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ExecRunner = async (argv: string[]) => {
    calls.push(argv);
    if (argv[1] === 'mcp' && argv[2] === 'list') return { code: 0, stdout: 'gbrain: stdio serve', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

/** Capture console.log + console.error around an async call. */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const origLog = console.log;
  const origErr = console.error;
  let out = '';
  let err = '';
  console.log = (...args: unknown[]) => {
    out += args.map(String).join(' ') + '\n';
  };
  console.error = (...args: unknown[]) => {
    err += args.map(String).join(' ') + '\n';
  };
  try {
    const result = await fn();
    return { result, out, err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

beforeAll(async () => {
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-dispatch-'));
  home = join(tmpParent, '.gbrain');
  mkdirSync(home, { recursive: true });
  ws = mkdtempSync(join(tmpdir(), 'gb-dispatch-ws-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpParent;

  // Interview: all required answers, MCP_SCOPE set, HOOKS_CONSENT SKIPPED.
  expect(initState(ws).ok).toBe(true);
  for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
    const r = setAnswer(ws, key, value);
    if (!r.ok) throw new Error(r.message);
  }
  expect(setAnswer(ws, 'MCP_SCOPE', 'project').ok).toBe(true);
  expect(skipAnswer(ws, 'HOOKS_CONSENT').ok).toBe(true);
  const h = readBackHash(ws);
  if (!h.ok) throw new Error(h.message);
  expect(confirm(ws, h.hash).ok).toBe(true);
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(tmpParent, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe('consent-skip is a decline (HOOKS_CONSENT)', () => {
  test('render succeeds; hooks phase refuses hook install with a clear message; MCP still registers', async () => {
    const render = await capture(() => runBootstrap(['render', '--workspace', ws]));
    expect(render.result).toBe(0);

    const { runner, calls } = makeRunner();
    const hooks = await capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'claude-code', '--gbrain-bin', process.execPath], {
        runner,
      }),
    );
    expect(hooks.result).toBe(0);
    // The skip DECLINED hooks — no settings file, an explicit declined message.
    expect(hooks.out).toContain('hooks declined');
    expect(existsSync(join(ws, '.claude', 'settings.local.json'))).toBe(false);
    // MCP registration still ran (consent-gated part is only the hooks).
    expect(calls.some((argv) => argv[0] === 'claude' && argv[1] === 'mcp' && argv[2] === 'add')).toBe(true);
    // Receipt records mcp-only wiring, not mcp+hooks.
    const receipt = readReceipt(home);
    expect(receipt?.registrations).toEqual([{ host: 'claude-code', scope: 'project', detail: 'mcp' }]);
  }, 30_000);
});

describe('hooks previews the source_id + creates brain/ eagerly [defect: multi-round-trip source registration]', () => {
  // Self-contained fixtures (same pattern as the flip block below): the
  // file-level `ws` is shared by other describes, so this needs its own.
  const scratch: string[] = [];
  function freshWorkspace(): { fws: string; fhome: string; fparent: string } {
    const fparent = mkdtempSync(join(tmpdir(), 'gb-srcid-'));
    const fhome = join(fparent, '.gbrain');
    mkdirSync(fhome, { recursive: true });
    const fws = mkdtempSync(join(tmpdir(), 'gb-srcid-ws-'));
    scratch.push(fparent, fws);
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = fparent;
    try {
      expect(initState(fws).ok).toBe(true);
      for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
        const r = setAnswer(fws, key, value);
        if (!r.ok) throw new Error(r.message);
      }
      expect(setAnswer(fws, 'MCP_SCOPE', 'project').ok).toBe(true);
      const h = readBackHash(fws);
      if (!h.ok) throw new Error(h.message);
      expect(confirm(fws, h.hash).ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
    }
    return { fws, fhome, fparent };
  }
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  async function withHome<T>(parent: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = parent;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
    }
  }

  test('hooks prints the exact `sources add` command up front and creates brain/ before verify ever runs', async () => {
    const { fws, fparent } = freshWorkspace();
    const brainDir = join(fws, 'brain');
    const out = await withHome(fparent, async () => {
      expect((await capture(() => runBootstrap(['render', '--workspace', fws]))).result).toBe(0);
      // render is engine-free and never touches brain/ — the gap this fix closes.
      expect(existsSync(brainDir)).toBe(false);
      const { runner } = makeRunner();
      return capture(() =>
        runBootstrap(['hooks', '--workspace', fws, '--harness', 'claude-code', '--gbrain-bin', process.execPath], {
          runner,
        }),
      );
    });
    expect(out.result).toBe(0);
    // brain/ now exists — ready for `sources add` without a manual mkdir
    // round trip.
    expect(existsSync(brainDir)).toBe(true);
    // The manifest's actual source_id (default: 'workspace' for a first
    // render) is spelled out verbatim — no guessing an "intuitive" name that
    // would only surface as an FK error three steps later at verify time.
    // --force is required and printed: brain/ is freshly created and has no
    // git history yet, so `sources add` without --force would fail-fast on
    // `not_a_git_repo` (#2707) the instant the printed command is pasted —
    // the exact same `{ force: true }` the engine-backed verify fixtures use
    // to register a brand new brain/ (test/bootstrap-verify.serial.test.ts).
    expect(out.out).toContain(`gbrain sources add workspace --path ${brainDir} --force`);
    // The collision-fallback id is previewed too, pinned to the SAME formula
    // verify.ts would derive (not just the id's shape) — so preview/verify
    // drift, or a change to the derivation formula, fails this test.
    expect(out.out).toContain(`'${deriveWorkspaceSourceId(fws)}'`);
    expect(deriveWorkspaceSourceId(fws)).toMatch(/^workspace-[0-9a-f]{8}$/);
  }, 30_000);

  test('a --repair re-run is idempotent: brain/ survives, the same preview reprints', async () => {
    const { fws, fparent } = freshWorkspace();
    const brainDir = join(fws, 'brain');
    await withHome(fparent, async () => {
      expect((await capture(() => runBootstrap(['render', '--workspace', fws]))).result).toBe(0);
      expect((await capture(() => runBootstrap(['hooks', '--workspace', fws, '--harness', 'claude-code', '--gbrain-bin', process.execPath], { runner: makeRunner().runner }))).result).toBe(0);
      // Simulate the human having already registered + committed into brain/.
      writeFileSync(join(brainDir, 'probe.md'), '# probe\n');
      const repaired = await capture(() =>
        runBootstrap(
          ['hooks', '--workspace', fws, '--harness', 'claude-code', '--repair', '--gbrain-bin', process.execPath],
          { runner: makeRunner().runner },
        ),
      );
      expect(repaired.result).toBe(0);
      expect(repaired.out).toContain(`gbrain sources add workspace --path ${brainDir} --force`);
      // Idempotent mkdir never clobbers what the human already committed.
      expect(existsSync(join(brainDir, 'probe.md'))).toBe(true);
    });
  }, 30_000);

  test('a workspace path containing a space is shell-quoted in the printed command', async () => {
    const fparent = mkdtempSync(join(tmpdir(), 'gb-srcid-space-'));
    scratch.push(fparent);
    const fhome = join(fparent, '.gbrain');
    mkdirSync(fhome, { recursive: true });
    const fwsRoot = mkdtempSync(join(tmpdir(), 'gb-srcid-space-root-'));
    scratch.push(fwsRoot);
    const fws = join(fwsRoot, 'has space');
    mkdirSync(fws, { recursive: true });
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = fparent;
    try {
      expect(initState(fws).ok).toBe(true);
      for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
        const r = setAnswer(fws, key, value);
        if (!r.ok) throw new Error(r.message);
      }
      expect(setAnswer(fws, 'MCP_SCOPE', 'project').ok).toBe(true);
      const h = readBackHash(fws);
      if (!h.ok) throw new Error(h.message);
      expect(confirm(fws, h.hash).ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
    }
    const brainDir = join(fws, 'brain');
    const out = await withHome(fparent, async () => {
      expect((await capture(() => runBootstrap(['render', '--workspace', fws]))).result).toBe(0);
      const { runner } = makeRunner();
      return capture(() =>
        runBootstrap(['hooks', '--workspace', fws, '--harness', 'claude-code', '--gbrain-bin', process.execPath], {
          runner,
        }),
      );
    });
    expect(out.result).toBe(0);
    // A bare, unquoted path with a space would split into two shell words —
    // the printed command must single-quote it so copy/paste actually works.
    expect(out.out).toContain(`--path '${brainDir}' --force`);
    expect(out.out).not.toContain(`--path ${brainDir} --force`);
  }, 30_000);
});

describe('per-turn hooks are ON by default (v0.45 flip); --no-hooks opts out', () => {
  // Self-contained fixtures: the file-level `ws` deliberately SKIPS
  // HOOKS_CONSENT (for the decline test), so the default-on path needs a
  // fresh workspace that LEAVES the consent at its bank default ('yes').
  const scratch: string[] = [];
  function freshWorkspace(): { fws: string; fhome: string; fparent: string } {
    const fparent = mkdtempSync(join(tmpdir(), 'gb-flip-'));
    const fhome = join(fparent, '.gbrain');
    mkdirSync(fhome, { recursive: true });
    const fws = mkdtempSync(join(tmpdir(), 'gb-flip-ws-'));
    scratch.push(fparent, fws);
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = fparent;
    try {
      expect(initState(fws).ok).toBe(true);
      for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
        const r = setAnswer(fws, key, value);
        if (!r.ok) throw new Error(r.message);
      }
      expect(setAnswer(fws, 'MCP_SCOPE', 'project').ok).toBe(true);
      // HOOKS_CONSENT left UNSET → bank default 'yes' applies (the flip).
      const h = readBackHash(fws);
      if (!h.ok) throw new Error(h.message);
      expect(confirm(fws, h.hash).ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
    }
    return { fws, fhome, fparent };
  }
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  async function withHome<T>(parent: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = parent;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
    }
  }

  test('a plain hooks run installs hooks without being asked (default yes) and surfaces the kill switch', async () => {
    const { fws, fhome, fparent } = freshWorkspace();
    const out = await withHome(fparent, async () => {
      expect((await capture(() => runBootstrap(['render', '--workspace', fws]))).result).toBe(0);
      const { runner } = makeRunner();
      return capture(() =>
        runBootstrap(['hooks', '--workspace', fws, '--harness', 'claude-code', '--gbrain-bin', process.execPath], { runner }),
      );
    });
    expect(out.result).toBe(0);
    expect(out.out).toContain('hooks installed');
    expect(out.out).toContain('GBRAIN_HOOKS=0'); // default-on is never silent
    expect(existsSync(join(fws, '.claude', 'settings.local.json'))).toBe(true);
    expect(readReceipt(fhome)?.registrations).toEqual([{ host: 'claude-code', scope: 'project', detail: 'mcp+hooks' }]);
  }, 30_000);

  test('--no-hooks opts out even when consent defaults yes; MCP still registers', async () => {
    const { fws, fhome, fparent } = freshWorkspace();
    const { out, calls } = await withHome(fparent, async () => {
      expect((await capture(() => runBootstrap(['render', '--workspace', fws]))).result).toBe(0);
      const r = makeRunner();
      const out = await capture(() =>
        runBootstrap(['hooks', '--workspace', fws, '--harness', 'claude-code', '--no-hooks', '--gbrain-bin', process.execPath], {
          runner: r.runner,
        }),
      );
      return { out, calls: r.calls };
    });
    expect(out.result).toBe(0);
    expect(out.out).toContain('--no-hooks');
    expect(existsSync(join(fws, '.claude', 'settings.local.json'))).toBe(false);
    expect(calls.some((argv) => argv[0] === 'claude' && argv[1] === 'mcp' && argv[2] === 'add')).toBe(true);
    expect(readReceipt(fhome)?.registrations).toEqual([{ host: 'claude-code', scope: 'project', detail: 'mcp' }]);
  }, 30_000);
});

describe('codex scope-note guard — Codex has no scope flag; stale MCP_SCOPE answers', () => {
  // Full branch matrix on the runHooks codex note: it must fire ONLY for an
  // explicit, non-skipped, string-valued 'project' answer (raw state read — the
  // consentAnswer resolver would default unset → 'project' and fire the note on
  // every Codex install where no one was ever asked).
  const NOTE = 'no effect on Codex';
  const scratch: string[] = [];
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  function scopeWorkspace(mcpScope: 'project' | 'user' | 'skip' | 'unset'): {
    fws: string;
    fhome: string;
    fparent: string;
  } {
    const fparent = mkdtempSync(join(tmpdir(), 'gb-scope-'));
    const fhome = join(fparent, '.gbrain');
    mkdirSync(fhome, { recursive: true });
    const fws = mkdtempSync(join(tmpdir(), 'gb-scope-ws-'));
    scratch.push(fparent, fws);
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = fparent;
    try {
      expect(initState(fws).ok).toBe(true);
      for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
        const r = setAnswer(fws, key, value);
        if (!r.ok) throw new Error(r.message);
      }
      if (mcpScope === 'skip') expect(skipAnswer(fws, 'MCP_SCOPE').ok).toBe(true);
      else if (mcpScope !== 'unset') expect(setAnswer(fws, 'MCP_SCOPE', mcpScope).ok).toBe(true);
      const h = readBackHash(fws);
      if (!h.ok) throw new Error(h.message);
      expect(confirm(fws, h.hash).ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
    }
    return { fws, fhome, fparent };
  }

  async function withScopeHome<T>(parent: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = parent;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
    }
  }

  async function renderThenHooks(
    fws: string,
    fparent: string,
    harness: 'codex' | 'claude-code',
    mutateAfterRender?: () => void,
  ) {
    return withScopeHome(fparent, async () => {
      expect((await capture(() => runBootstrap(['render', '--workspace', fws]))).result).toBe(0);
      mutateAfterRender?.();
      const { runner } = makeRunner();
      return capture(() =>
        runBootstrap(['hooks', '--workspace', fws, '--harness', harness, '--gbrain-bin', process.execPath], {
          runner,
        }),
      );
    });
  }

  test('codex + explicit project → note fires; hooks skipped; receipt records user scope', async () => {
    const { fws, fhome, fparent } = scopeWorkspace('project');
    const r = await renderThenHooks(fws, fparent, 'codex');
    expect(r.result).toBe(0);
    expect(r.err).toContain(NOTE);
    expect(r.err).toContain('user-global');
    expect(existsSync(join(fws, '.claude', 'settings.local.json'))).toBe(false);
    expect(readReceipt(fhome)?.registrations).toEqual([{ host: 'codex', scope: 'user', detail: 'mcp' }]);
  }, 30_000);

  test('codex + unset → NO note (raw read, not the project-defaulting resolver)', async () => {
    const { fws, fparent } = scopeWorkspace('unset');
    const r = await renderThenHooks(fws, fparent, 'codex');
    expect(r.result).toBe(0);
    expect(r.err).not.toContain(NOTE);
  }, 30_000);

  test('codex + explicitly skipped → NO note (skipped is not an answer)', async () => {
    const { fws, fparent } = scopeWorkspace('skip');
    const r = await renderThenHooks(fws, fparent, 'codex');
    expect(r.result).toBe(0);
    expect(r.err).not.toContain(NOTE);
  }, 30_000);

  test('codex + explicit user → NO note (nothing to correct)', async () => {
    const { fws, fparent } = scopeWorkspace('user');
    const r = await renderThenHooks(fws, fparent, 'codex');
    expect(r.result).toBe(0);
    expect(r.err).not.toContain(NOTE);
  }, 30_000);

  test('claude-code + explicit project → NO note (harness guard); hooks flow unchanged', async () => {
    const { fws, fhome, fparent } = scopeWorkspace('project');
    const r = await renderThenHooks(fws, fparent, 'claude-code');
    expect(r.result).toBe(0);
    expect(r.err).not.toContain(NOTE);
    expect(readReceipt(fhome)?.registrations).toEqual([{ host: 'claude-code', scope: 'project', detail: 'mcp+hooks' }]);
  }, 30_000);

  test('codex + corrupt interview.json → NO note, exit 0 (fail-open read.ok route)', async () => {
    const { fws, fparent } = scopeWorkspace('project');
    const r = await renderThenHooks(fws, fparent, 'codex', () => {
      writeFileSync(join(fws, 'state', 'interview.json'), '{ not json', 'utf8');
    });
    expect(r.result).toBe(0);
    expect(r.err).not.toContain(NOTE);
  }, 30_000);

  test('codex + malformed answer shape (value: 3) → NO note, no crash (typeof guard)', async () => {
    const { fws, fparent } = scopeWorkspace('unset');
    const r = await renderThenHooks(fws, fparent, 'codex', () => {
      const p = join(fws, 'state', 'interview.json');
      const state = JSON.parse(readFileSync(p, 'utf8')) as { answers: Record<string, unknown> };
      state.answers['MCP_SCOPE'] = { value: 3 };
      writeFileSync(p, JSON.stringify(state), 'utf8');
    });
    expect(r.result).toBe(0);
    expect(r.err).not.toContain(NOTE);
  }, 30_000);

  test('claude-code + malformed answer shape → consentAnswer falls to bank default; hooks flow completes', async () => {
    const { fws, fhome, fparent } = scopeWorkspace('unset');
    const r = await renderThenHooks(fws, fparent, 'claude-code', () => {
      const p = join(fws, 'state', 'interview.json');
      const state = JSON.parse(readFileSync(p, 'utf8')) as { answers: Record<string, unknown> };
      state.answers['MCP_SCOPE'] = { value: 3 };
      writeFileSync(p, JSON.stringify(state), 'utf8');
    });
    expect(r.result).toBe(0);
    // Pre-fix this crashed at mcpScope's .toLowerCase(); now the unusable
    // value fails CLOSED ('no' → project scope) — LOUDLY (a silent fall-through
    // could flip a damaged opt-out to consent).
    expect(r.err).toContain('invalid shape');
    expect(readReceipt(fhome)?.registrations).toEqual([{ host: 'claude-code', scope: 'project', detail: 'mcp+hooks' }]);
  }, 30_000);

  test('claude-code + malformed HOOKS_CONSENT → fail-closed: hooks DECLINED, note printed', async () => {
    const { fws, fhome, fparent } = scopeWorkspace('unset');
    const r = await renderThenHooks(fws, fparent, 'claude-code', () => {
      const p = join(fws, 'state', 'interview.json');
      const state = JSON.parse(readFileSync(p, 'utf8')) as { answers: Record<string, unknown> };
      // A merge-damaged boolean: previously crashed; a bank-default fall-through
      // would silently flip a possible opt-out to consent-granted. Fail closed.
      state.answers['HOOKS_CONSENT'] = { value: true };
      writeFileSync(p, JSON.stringify(state), 'utf8');
    });
    expect(r.result).toBe(0);
    expect(r.err).toContain('invalid shape');
    expect(r.out).toContain('hooks declined');
    expect(existsSync(join(fws, '.claude', 'settings.local.json'))).toBe(false);
    expect(readReceipt(fhome)?.registrations).toEqual([{ host: 'claude-code', scope: 'project', detail: 'mcp' }]);
  }, 30_000);
});

describe('MCP registration verification [FIX7]', () => {
  const gbrainBin = process.execPath;
  const OURS = `gbrain:\n  command: ${gbrainBin} serve --surface full\n  env: GBRAIN_SOURCE=workspace`;
  const FOREIGN = `gbrain:\n  command: /somewhere/else/gbrain serve --surface full\n  env: GBRAIN_SOURCE=other-workspace`;

  /** Stateful recording MCP host: models add/remove/get/list against a single
   * current registration string so `mcp get` reflects reality across re-adds. */
  function mcpHost(opts: { initialReg?: string | null; getSupported?: boolean }): {
    runner: ExecRunner;
    calls: string[][];
  } {
    const calls: string[][] = [];
    let currentReg: string | null = opts.initialReg ?? null;
    const getSupported = opts.getSupported ?? true;
    const runner: ExecRunner = async (argv: string[]) => {
      calls.push(argv);
      const sub = argv[1];
      const verb = argv[2];
      if (sub !== 'mcp') return { code: 0, stdout: '', stderr: '' };
      if (verb === 'add') {
        if (currentReg !== null) return { code: 1, stdout: '', stderr: 'MCP server gbrain already exists' };
        currentReg = OURS; // a fresh add registers THIS workspace
        return { code: 0, stdout: '', stderr: '' };
      }
      if (verb === 'remove') {
        currentReg = null;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (verb === 'get') {
        if (!getSupported) return { code: 1, stdout: '', stderr: 'unknown command: get' };
        if (currentReg === null) return { code: 1, stdout: '', stderr: 'no such MCP server' };
        return { code: 0, stdout: currentReg, stderr: '' };
      }
      if (verb === 'list') {
        return { code: 0, stdout: currentReg ? 'gbrain: stdio serve' : '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    return { runner, calls };
  }

  async function runHooks(runner: ExecRunner) {
    return capture(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'claude-code', '--gbrain-bin', gbrainBin], { runner }),
    );
  }

  test('fresh registration → smoke verifies the server targets THIS workspace', async () => {
    const { runner, calls } = mcpHost({ initialReg: null });
    const r = await runHooks(runner);
    expect(r.result).toBe(0);
    expect(r.out).toContain('verified targeting this workspace');
    expect(calls.some((c) => c[1] === 'mcp' && c[2] === 'remove')).toBe(false);
  }, 30_000);

  test('already registered AND points at this workspace → kept, no re-register', async () => {
    const { runner, calls } = mcpHost({ initialReg: OURS });
    const r = await runHooks(runner);
    expect(r.result).toBe(0);
    expect(r.out).toContain('already registered for this workspace — kept');
    expect(calls.some((c) => c[1] === 'mcp' && c[2] === 'remove')).toBe(false);
    const adds = calls.filter((c) => c[1] === 'mcp' && c[2] === 'add').length;
    expect(adds).toBe(1); // only the initial (already-exists) attempt
  }, 30_000);

  test('already registered but points ELSEWHERE → remove + re-add, never silently blessed', async () => {
    const { runner, calls } = mcpHost({ initialReg: FOREIGN });
    const r = await runHooks(runner);
    expect(r.result).toBe(0);
    expect(r.err).toContain('targets a DIFFERENT workspace');
    // The remove must be SCOPED on claude-code: a scope-less remove can resolve
    // to a different scope's registration and leave the blocker in place.
    const removes = calls.filter((c) => c[1] === 'mcp' && c[2] === 'remove' && c[3] === 'gbrain');
    expect(removes.length).toBeGreaterThan(0);
    for (const c of removes) {
      const scopeIdx = c.indexOf('--scope');
      expect(scopeIdx).toBeGreaterThan(3);
      expect(c[scopeIdx + 1]).toBe('project');
    }
    const adds = calls.filter((c) => c[1] === 'mcp' && c[2] === 'add').length;
    expect(adds).toBe(2); // initial (foreign) + re-add after remove
    // After the fix, the smoke confirms the corrected registration.
    expect(r.out).toContain('verified targeting this workspace');
  }, 30_000);

  test('mismatch + failed remove → exit 1 with the by-hand fix instruction; add never retried', async () => {
    // Stateful failure host: add refuses ("already exists"), get shows a
    // FOREIGN registration (mismatch), and the scoped remove itself fails.
    const calls: string[][] = [];
    const runner: ExecRunner = async (argv: string[]) => {
      calls.push(argv);
      if (argv[1] !== 'mcp') return { code: 0, stdout: '', stderr: '' };
      if (argv[2] === 'add') return { code: 1, stdout: '', stderr: 'MCP server gbrain already exists' };
      if (argv[2] === 'get') return { code: 0, stdout: FOREIGN, stderr: '' };
      if (argv[2] === 'remove') return { code: 1, stdout: '', stderr: 'nope' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await runHooks(runner);
    expect(r.result).toBe(1);
    expect(r.err).toContain('targets a DIFFERENT workspace');
    // Fail LOUD, not the old silent no-op loop: the message hands the human
    // the manual off-ramp instead of re-failing the add.
    expect(r.err).toContain('remove the stale registration by hand');
    const adds = calls.filter((c) => c[1] === 'mcp' && c[2] === 'add').length;
    expect(adds).toBe(1); // the failed remove halts the flow before any re-add
  }, 30_000);

  test('host without `mcp get` → inconclusive, kept with a note (never a false bless)', async () => {
    const { runner } = mcpHost({ initialReg: OURS, getSupported: false });
    const r = await runHooks(runner);
    expect(r.result).toBe(0);
    expect(r.out).toContain('could not confirm it targets this workspace');
    // Falls back to the list-substring probe for the smoke line.
    expect(r.out).toContain('full target unverified');
  }, 30_000);
});

describe('MCP host failure × hooks at the dispatcher (exit-127 skip / broken settings fail-closed)', () => {
  // Self-contained fixtures (the flip pattern): HOOKS_CONSENT left at its bank
  // default ('yes') so the hooks half of the phase is live in both tests.
  const scratch: string[] = [];
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  function failWorkspace(): { fws: string; fhome: string; fparent: string } {
    const fparent = mkdtempSync(join(tmpdir(), 'gb-fail-'));
    const fhome = join(fparent, '.gbrain');
    mkdirSync(fhome, { recursive: true });
    const fws = mkdtempSync(join(tmpdir(), 'gb-fail-ws-'));
    scratch.push(fparent, fws);
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = fparent;
    try {
      expect(initState(fws).ok).toBe(true);
      for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
        const r = setAnswer(fws, key, value);
        if (!r.ok) throw new Error(r.message);
      }
      expect(setAnswer(fws, 'MCP_SCOPE', 'project').ok).toBe(true);
      const h = readBackHash(fws);
      if (!h.ok) throw new Error(h.message);
      expect(confirm(fws, h.hash).ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
    }
    return { fws, fhome, fparent };
  }

  async function withFailHome<T>(parent: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = parent;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = prev;
    }
  }

  test('`claude` missing (exit 127 on mcp add) → MCP skipped, hooks STILL install, exit 2, receipt detail hooks', async () => {
    const { fws, fhome, fparent } = failWorkspace();
    const r = await withFailHome(fparent, async () => {
      expect((await capture(() => runBootstrap(['render', '--workspace', fws]))).result).toBe(0);
      const runner: ExecRunner = async (argv: string[]) => {
        if (argv[0] === 'claude' && argv[1] === 'mcp' && argv[2] === 'add') {
          return { code: 127, stdout: '', stderr: 'claude: command not found' };
        }
        return { code: 0, stdout: '', stderr: '' };
      };
      return capture(() =>
        runBootstrap(['hooks', '--workspace', fws, '--harness', 'claude-code', '--gbrain-bin', process.execPath], {
          runner,
        }),
      );
    });
    expect(r.result).toBe(2);
    expect(r.err).toContain('is not on PATH');
    // The old early-return silently dropped hooks; now they install anyway
    // (hooks only write settings.local.json and need no host binary).
    expect(r.out).toContain('hooks installed');
    const settingsPath = join(fws, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>;
    };
    const entries = Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks ?? []));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e[GBRAIN_HOOK_MARKER_KEY] === GBRAIN_HOOK_MARKER_VALUE)).toBe(true);
    // Receipt records what actually landed: hooks only, no MCP.
    expect(readReceipt(fhome)?.registrations).toEqual([{ host: 'claude-code', scope: 'project', detail: 'hooks' }]);
  }, 30_000);

  test('unparseable settings.local.json → hooks fail CLOSED (exit 1), file byte-identical, receipt detail mcp', async () => {
    const { fws, fhome, fparent } = failWorkspace();
    const broken = '{ definitely broken';
    const settingsPath = join(fws, '.claude', 'settings.local.json');
    const r = await withFailHome(fparent, async () => {
      expect((await capture(() => runBootstrap(['render', '--workspace', fws]))).result).toBe(0);
      mkdirSync(join(fws, '.claude'), { recursive: true });
      writeFileSync(settingsPath, broken, 'utf8');
      const { runner } = makeRunner();
      return capture(() =>
        runBootstrap(['hooks', '--workspace', fws, '--harness', 'claude-code', '--gbrain-bin', process.execPath], {
          runner,
        }),
      );
    });
    expect(r.result).toBe(1);
    // The refusal explains WHY (the file may carry permissions/allowlist
    // entries gbrain must not clobber) and names the repair path.
    expect(r.err).toContain('not valid JSON');
    expect(readFileSync(settingsPath, 'utf8')).toBe(broken);
    // MCP (step 1) landed before the hook failure — the receipt says exactly that.
    expect(readReceipt(fhome)?.registrations).toEqual([{ host: 'claude-code', scope: 'project', detail: 'mcp' }]);
  }, 30_000);
});

describe('receipt overwrite guard wired into every writer [CX2-12]', () => {
  function writeNewerReceipt(dir: string): void {
    mkdirSync(join(dir, 'bootstrap'), { recursive: true });
    writeFileSync(
      receiptPath(dir),
      JSON.stringify({ receipt_version: 2, workspace_dir: ws, created_paths: ['/somewhere/important'] }),
      'utf8',
    );
  }

  test('render: newer-format receipt → refusal naming the upgrade path; receipt untouched', async () => {
    const before = readFileSync(receiptPath(home), 'utf8');
    writeNewerReceipt(home);
    try {
      const r = await capture(() => runBootstrap(['render', '--workspace', ws, '--force']));
      expect(r.result).toBe(1);
      expect(r.err).toContain('newer gbrain');
      expect(r.err).toContain('upgrade gbrain');
      // The newer receipt survives byte-for-byte (nothing clobbered it).
      const after = JSON.parse(readFileSync(receiptPath(home), 'utf8')) as { receipt_version: number };
      expect(after.receipt_version).toBe(2);
    } finally {
      writeFileSync(receiptPath(home), before, 'utf8');
    }
  }, 30_000);

  test('hooks: newer-format receipt → refusal, registration record not written', async () => {
    const before = readFileSync(receiptPath(home), 'utf8');
    writeNewerReceipt(home);
    try {
      const { runner } = makeRunner();
      const r = await capture(() =>
        runBootstrap(['hooks', '--workspace', ws, '--harness', 'codex', '--gbrain-bin', process.execPath], {
          runner,
        }),
      );
      expect(r.result).toBe(1);
      expect(r.err).toContain('upgrade gbrain');
    } finally {
      writeFileSync(receiptPath(home), before, 'utf8');
    }
  }, 30_000);

  test('attach: newer-format receipt → refusal (upgrade-first), created_paths not stranded', async () => {
    const isoHome = mkdtempSync(join(tmpdir(), 'gb-dispatch-attach-home-'));
    try {
      writeNewerReceipt(isoHome);
      expect(() => attachWorkspace(ws, { gbrainHomeDir: isoHome })).toThrow(/upgrade gbrain/);
      const surviving = JSON.parse(readFileSync(receiptPath(isoHome), 'utf8')) as { created_paths: string[] };
      expect(surviving.created_paths).toEqual(['/somewhere/important']);
    } finally {
      rmSync(isoHome, { recursive: true, force: true });
    }
  });

  test('corrupt receipt: loud .broken-<ts> backup + fresh receipt written', async () => {
    const before = readFileSync(receiptPath(home), 'utf8');
    writeFileSync(receiptPath(home), 'not json {{{', 'utf8');
    try {
      const r = await capture(() => runBootstrap(['render', '--workspace', ws, '--force']));
      expect(r.result).toBe(0);
      expect(r.err).toContain('WARNING');
      expect(r.err).toContain('.broken-');
      const backups = readdirSync(join(home, 'bootstrap')).filter((n) => n.startsWith('receipt.json.broken-'));
      expect(backups.length).toBeGreaterThan(0);
      expect(readFileSync(join(home, 'bootstrap', backups[0]!), 'utf8')).toBe('not json {{{');
      // A fresh, valid receipt exists.
      const fresh = readReceipt(home);
      expect(fresh?.agent_name).toBe('Dispatch');
    } finally {
      for (const n of readdirSync(join(home, 'bootstrap'))) {
        if (n.startsWith('receipt.json.broken-')) rmSync(join(home, 'bootstrap', n), { force: true });
      }
      writeFileSync(receiptPath(home), before, 'utf8');
    }
  }, 30_000);
});

describe('uninstall --delete-brain ordering + engine-free stats', () => {
  test('workspaceBrainStats counts committed brain pages and names the manifest source', () => {
    const statsWs = mkdtempSync(join(tmpdir(), 'gb-dispatch-stats-'));
    try {
      mkdirSync(join(statsWs, 'brain', 'wiki'), { recursive: true });
      writeFileSync(join(statsWs, 'brain', 'a.md'), '# a', 'utf8');
      writeFileSync(join(statsWs, 'brain', 'wiki', 'b.md'), '# b', 'utf8');
      writeFileSync(join(statsWs, 'brain', 'not-a-page.txt'), 'x', 'utf8');
      writeManifest(statsWs, {
        format_version: 1,
        initialized: true,
        agent_name: 'Dispatch',
        created_by: 'test',
        created_at: new Date().toISOString(),
        source_id: 'workspace-abcd1234',
      });
      expect(workspaceBrainStats(statsWs)).toEqual({ sources: ['workspace-abcd1234'], pages: 2 });
      // No brain/ dir → null (module falls back to its receipt-only text).
      expect(workspaceBrainStats(join(statsWs, 'nope'))).toBeNull();
    } finally {
      rmSync(statsWs, { recursive: true, force: true });
    }
  });

  test('facts-export offer prints BEFORE deletion output; brain deleted via isolated --home; durability wiring torn down [B6]', async () => {
    // Isolated-style home INSIDE the workspace (the S3#5 shape --home requires
    // while GBRAIN_HOME is set): config.json + brain.pglite signature + receipt.
    const ws2 = mkdtempSync(join(tmpdir(), 'gb-dispatch-ws2-'));
    const isoHome = join(ws2, '.gbrain');
    // HOME redirected for the plist/crontab teardown probes — the real
    // machine's LaunchAgents must never be touched by a test.
    const savedHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'gb-dispatch-home-'));
    try {
      mkdirSync(join(isoHome, 'brain.pglite'), { recursive: true });
      mkdirSync(join(isoHome, 'bootstrap'), { recursive: true });
      writeFileSync(join(isoHome, 'config.json'), '{"engine":"pglite"}', 'utf8');
      writeFileSync(join(isoHome, 'brain.pglite', 'PG_VERSION'), '16', 'utf8');
      const receipt: InstallReceipt = {
        receipt_version: 1,
        workspace_dir: ws2,
        source_id: 'workspace',
        agent_name: 'Dispatch',
        created_at: new Date().toISOString(),
        created_by: 'test',
        brain_created_by_bootstrap: true,
        created_paths: [],
        registrations: [],
      };
      writeFileSync(receiptPath(isoHome), JSON.stringify(receipt), 'utf8');
      mkdirSync(join(ws2, 'brain'), { recursive: true });
      writeFileSync(join(ws2, 'brain', 'page.md'), '# page', 'utf8');
      // Durability wiring fixture [B6]: a gbrain post-commit hook that
      // uninstall previously left behind.
      execFileSync('git', ['init', '-q'], { cwd: ws2 });
      const hookPath = join(ws2, '.git', 'hooks', 'post-commit');
      mkdirSync(join(ws2, '.git', 'hooks'), { recursive: true });
      writeFileSync(
        hookPath,
        '#!/bin/bash\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n',
        { mode: 0o755 },
      );

      const r = await capture(() =>
        runBootstrap(['uninstall', '--workspace', ws2, '--delete-brain', '--yes', '--home', isoHome]),
      );
      expect(r.result).toBe(0);
      const offerIdx = r.out.indexOf('offered: export facts before deletion');
      const deletedIdx = r.out.indexOf('brain DELETED');
      expect(offerIdx).toBeGreaterThanOrEqual(0);
      expect(deletedIdx).toBeGreaterThan(offerIdx);
      // The offer is printed exactly once (not repeated from the module steps).
      expect(r.out.indexOf('offered: export facts', offerIdx + 1)).toBe(-1);
      expect(existsSync(join(isoHome, 'brain.pglite'))).toBe(false);
      // [B6] the untracked post-commit hook is gone and the teardown said so.
      expect(existsSync(hookPath)).toBe(false);
      expect(r.out).toContain('durability wiring removed');
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(ws2, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('uninstall × harness receipt (#4043 harness-first composition)', () => {
  function harnessReceiptFor(overrides: Partial<HarnessReceipt> = {}): HarnessReceipt {
    return {
      harness_receipt_version: 1,
      created_at: new Date().toISOString(),
      created_by: 'gbrain@test',
      url: 'http://127.0.0.1:19999/mcp',
      source_id: 'default',
      token: { name: 'bootstrap-harness', minted: false },
      targets: [{ host: 'claude-code', kind: 'mcp', state: 'confirmed', scope: 'user', name: 'gbrain' }],
      ...overrides,
    };
  }

  test('harness-only box: harness removed FIRST, NO_RECEIPT tolerated, exit 0', async () => {
    const ws3 = mkdtempSync(join(tmpdir(), 'gb-harness-only-ws-'));
    const isoHome = join(ws3, '.gbrain');
    mkdirSync(join(isoHome, 'bootstrap'), { recursive: true });
    // removeHarness locks the user-settings dir [X11] — sandbox it so the
    // test never touches (or contends on) the operator's real ~/.claude.
    const savedCfgDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(ws3, 'claude-cfg');
    try {
      writeHarnessReceipt(isoHome, harnessReceiptFor());
      const { runner } = makeRunner();
      const r = await capture(() =>
        runBootstrap(['uninstall', '--workspace', ws3, '--yes', '--home', isoHome], { runner }),
      );
      expect(r.result).toBe(0);
      expect(r.out).toContain('harness wiring detected — removing it first');
      // GBRAIN_HOME points elsewhere in this suite, so the refusal lands as
      // HOME_GUARD here; NO_RECEIPT fires when homes align. Both are in the
      // tolerated set — pin that one of them is named.
      expect(r.out).toMatch(/no workspace install on this machine \(naming the refusal: (NO_RECEIPT|HOME_GUARD)\)/);
      // Ordering: harness removal output precedes the no-workspace message.
      expect(r.out.indexOf('harness wiring detected')).toBeLessThan(r.out.indexOf('no workspace install'));
      expect(existsSync(harnessReceiptPath(isoHome))).toBe(false); // receipt consumed
    } finally {
      if (savedCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedCfgDir;
      rmSync(ws3, { recursive: true, force: true });
    }
  }, 30_000);

  test('harness removal that does not converge ABORTS before workspace teardown (exit 1)', async () => {
    const ws4 = mkdtempSync(join(tmpdir(), 'gb-harness-abort-ws-'));
    const isoHome = join(ws4, '.gbrain');
    mkdirSync(join(isoHome, 'bootstrap'), { recursive: true });
    const savedCfgDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(ws4, 'claude-cfg');
    try {
      // A hooks target whose settings file is parse-broken: the remove path
      // refuses to touch what it cannot read → target stays failed → exit 1.
      const brokenSettings = join(ws4, 'settings.json');
      writeFileSync(brokenSettings, '{ not json', 'utf8');
      writeHarnessReceipt(
        isoHome,
        harnessReceiptFor({
          targets: [
            { host: 'claude-code', kind: 'hooks', state: 'confirmed', scope: 'user', path: brokenSettings, marker: 'bootstrap-harness-v1' },
          ],
        }),
      );
      // A workspace receipt that WOULD be torn down if the abort failed.
      const receipt: InstallReceipt = {
        receipt_version: 1,
        workspace_dir: ws4,
        source_id: 'workspace',
        agent_name: 'Dispatch',
        created_at: new Date().toISOString(),
        created_by: 'test',
        brain_created_by_bootstrap: false,
        created_paths: [],
        registrations: [],
      };
      writeFileSync(receiptPath(isoHome), JSON.stringify(receipt), 'utf8');
      const { runner } = makeRunner();
      const r = await capture(() =>
        runBootstrap(['uninstall', '--workspace', ws4, '--yes', '--home', isoHome], { runner }),
      );
      expect(r.result).toBe(1);
      expect(r.err).toContain('harness removal did not fully converge');
      // Aborted BEFORE teardown: both receipts survive for the retry.
      expect(existsSync(harnessReceiptPath(isoHome))).toBe(true);
      expect(existsSync(receiptPath(isoHome))).toBe(true);
    } finally {
      if (savedCfgDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedCfgDir;
      rmSync(ws4, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('cloud-setup-script emitter [D16]', () => {
  test('prints the paste-ready script: npm-based (never bun fetching, never the npm squatter), launcher + attach flow', async () => {
    const r = await capture(() => runBootstrap(['cloud-setup-script']));
    expect(r.result).toBe(0);
    const s = r.out;
    // npm transport (bun fetching is proxy-incompatible in cloud sandboxes)…
    expect(s).toContain('npm install -g bun');
    expect(s).toContain('github.com/garrytan/gbrain');
    // …but NEVER the unrelated npm registry package.
    expect(s).not.toMatch(/npm install -g gbrain(\s|$)/m);
    // PATH-resolved launcher + in-session follow-ups.
    expect(s).toContain('/usr/local/bin/gbrain');
    expect(s).toContain('bootstrap attach');
    expect(s).toContain('cloud-setup-script');
  });
});
