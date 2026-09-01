/**
 * REAL-agent door test — Codex edition. Drives the ACTUAL `codex` binary (no
 * PATH shim) against a real gbrain, over the two seams that matter for Codex:
 *
 *   1. INSTALL — the real `gbrain bootstrap` CLI (keyless `gbrain init`,
 *      interview --set/--confirm, render, then `gbrain bootstrap hooks
 *      --harness codex` executing the REAL `codex mcp add` into a hermetic
 *      ~/.codex/config.toml). Asserts the registration landed (real `codex mcp
 *      get gbrain` + the temp config.toml carry our server + GBRAIN_SOURCE),
 *      `gbrain bootstrap verify` exits 0, and the rendered AGENTS.md carries the
 *      Gate-3 brain-first pull protocol — Codex's ONLY per-turn mechanism
 *      (gbrain wires SessionEnd capture only; per-turn stays pull). Also
 *      asserts the trust-gated hooks.json + config.toml pair landed in the
 *      hermetic CODEX_HOME.
 *
 *   2. SMOKE — a live `codex exec` turn. gbrain is registered as a Codex stdio
 *      MCP server (`bun run <repo>/src/cli.ts serve --surface full`) pinned to a
 *      seeded keyless brain. Codex is asked a single question whose answer only
 *      the brain holds; we assert a gbrain tool/command shows up in the turn AND
 *      the seeded fact surfaces in the final text. Proves: real codex → gbrain
 *      MCP → brain → fact. Falls back to the AGENTS.md pull protocol + a direct
 *      shell instruction (`gbrain query`) if headless stdio-MCP is unreliable;
 *      the assertion documents which path proved out.
 *
 *   3. BOUNDARY — a second live `codex exec` turn at a SESSION BOUNDARY
 *      (v0.45.7 ambient recall). The real bootstrap protocol is rendered into
 *      the cwd, the HEARTBEAT.md ambient-delta due-job is enabled (the
 *      documented operator ritual), gbrain is registered on `--surface verbs`
 *      (the seven frozen memory verbs, context_pack + delta included), and
 *      codex is told to follow its AGENTS.md session-start protocol. Asserts a
 *      boundary verb landed against OUR gbrain — an `mcp_tool_call` naming
 *      context_pack OR delta (either counts: boundary behavior, not one exact
 *      tool), or the CLI spelling via SMOKE's shell-fallback contract (the
 *      evidence documents which path proved out). Proves: rendered protocol →
 *      real codex → boundary verb → brain.
 *
 * A codex-FREE companion describe pins the rendered protocol content itself:
 * AGENTS.md routes session start through HEARTBEAT.md's due-job list, whose
 * ambient-delta row names context-pack (session start) + delta (heartbeat).
 * That block ALWAYS runs — template-source/docs pins live in
 * test/ambient-recall-templates.test.ts; this file owns the WORKSPACE-RENDERED
 * artifacts the codex door actually reads.
 *
 * EVERYTHING is hermetic (temp HOME / CODEX_HOME / GBRAIN_HOME per test) and the
 * live-codex describe self-SKIPS via describe.skipIf when the codex binary or
 * its auth is absent, so it is a clean no-op on a runner without them. Serial: PGLite cold
 * starts + a real codex spawn would starve parallel siblings; every test carries
 * an explicit timeout. Real turns cost API + take 30s–2min — prompts are minimal
 * (one seeded fact, one question) and capped at 240s.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolveCodexBinary,
  hasCodexAuth,
  codexExecTurn,
  seedBrainForAgent,
  hermeticChildEnv,
  resolveGbrainServerCommand,
} from '../helpers/agent-harness.ts';
import { runBootstrap } from '../../src/commands/bootstrap.ts';
import type { ExecRunner } from '../../src/core/bootstrap/repo.ts';
import { initState, setAnswer, confirm, readBackHash } from '../../src/core/bootstrap/interview.ts';
import { readManifest } from '../../src/core/bootstrap/format.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { addSource } from '../../src/core/sources-ops.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const CODEX_BIN = resolveCodexBinary();
const CAN_RUN = !!CODEX_BIN && hasCodexAuth();

const REQUIRED_ANSWERS: Record<string, string> = {
  AGENT_NAME: 'Lifeboat',
  PRINCIPAL_NAME: 'Pat Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research group; builds internal tooling; values signal over noise.',
  VOICE_REGISTER: 'Direct: three options, the second one wins.',
};

const ENV_KEYS = [
  'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_BOOTSTRAP_ABORT_AFTER',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_HOME', 'CODEX_SANDBOX', 'CODEX_CI',
];
const SAVED_ENV: Record<string, string | undefined> = {};

/** Seed a hermetic ~/.codex under `home` with ONLY the operator's real
 *  auth.json (read-only copy) so a spawned codex authenticates without ever
 *  touching the real config dir. Deliberately does NOT copy the operator's
 *  real config.toml: it defines the operator's private remote MCP servers
 *  (which require secrets we don't have and would fail the whole session), and
 *  copying private server names is a privacy smell. `codex mcp add` writes a
 *  fresh, gbrain-only config.toml on top of this. */
function seedCodexHome(home: string): string {
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  const src = join(homedir(), '.codex', 'auth.json');
  const dst = join(codexHome, 'auth.json');
  if (existsSync(src) && !existsSync(dst)) {
    try { cpSync(src, dst); } catch { /* best-effort */ }
  }
  // Placeholder global identity files so codexExecTurn's copy-if-missing loop
  // never pulls the operator's PRIVATE ~/.codex/{AGENTS,SOUL}.md into the turn
  // (behavior + privacy). The per-turn instruction rides the prompt instead.
  for (const f of ['AGENTS.md', 'SOUL.md']) {
    const p = join(codexHome, f);
    if (!existsSync(p)) {
      try { writeFileSync(p, '<!-- hermetic test placeholder -->\n'); } catch { /* best-effort */ }
    }
  }
  return codexHome;
}

/** Run the REAL `codex` binary under a hermetic HOME/CODEX_HOME. Used both as
 *  the bootstrap `hooks` exec runner (so `codex mcp add` writes the temp
 *  config.toml) and for direct `codex mcp get`/`list` probes. */
function makeCodexRunner(home: string): ExecRunner {
  const codexHome = join(home, '.codex');
  return async (argv: string[]) => {
    try {
      const proc = Bun.spawn(argv, {
        env: hermeticChildEnv(
          { HOME: home, CODEX_HOME: codexHome },
          { extraAllow: ['OPENAI_API_KEY', 'CODEX_*'] },
        ),
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    } catch (e) {
      return { code: 127, stdout: '', stderr: (e as Error).message };
    }
  };
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const orig = console.log;
  let out = '';
  console.log = (...args: unknown[]) => {
    out += args.map(String).join(' ') + '\n';
  };
  try {
    const result = await fn();
    return { result, out };
  } finally {
    console.log = orig;
  }
}

beforeAll(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  // Ambient-state strip: a dev/CI DATABASE_URL must not flip the sandboxed
  // brain to Postgres; stray GBRAIN_SOURCE/CODEX_* must not leak into a child.
  for (const k of ENV_KEYS) delete process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

/** Scripted interview (REQUIRED_ANSWERS) + full render into `ws` — the exact
 *  INSTALL steps (b)+(c), reused by the codex-free render pin and the live
 *  BOUNDARY turn. Caller pins GBRAIN_HOME first (render reads the repo
 *  receipt/config from it) and git-inits `ws` (no origin → the public-origin
 *  gate is a no-op). */
async function interviewAndRender(ws: string): Promise<void> {
  const init = initState(ws);
  if (!init.ok) throw new Error(init.message);
  for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
    const r = setAnswer(ws, key, value);
    if (!r.ok) throw new Error(r.message);
  }
  const h = readBackHash(ws);
  if (!h.ok) throw new Error(h.message);
  const c = confirm(ws, h.hash);
  if (!c.ok) throw new Error(c.message);
  const code = await runBootstrap(['render', '--workspace', ws]);
  if (code !== 0) throw new Error(`bootstrap render exited ${code}`);
}

// ── 0. RENDERED PROTOCOL PIN (always runs — needs NO codex binary) ──────────
// gbrain does not wire Codex hooks yet, so ambient recall (v0.45.7) reaches it ONLY via
// the rendered pull protocol. Pin the WORKSPACE-RENDERED chain the codex door
// reads: AGENTS.md's session startup routes through HEARTBEAT.md's due-job
// list, and the rendered ambient-delta row binds both boundary verbs to their
// boundaries. (Template-SOURCE + docs pins are owned by
// test/ambient-recall-templates.test.ts — deliberately not repeated here.)
describe('bootstrap rendered protocol — ambient boundaries (always runs)', () => {
  test('rendered AGENTS.md + HEARTBEAT.md name context-pack (session start) and delta (heartbeat)', async () => {
    const gbHome = mkdtempSync(join(tmpdir(), 'gb-rc-render-home-'));
    const ws = mkdtempSync(join(tmpdir(), 'gb-rc-render-ws-'));
    const savedHome = process.env.GBRAIN_HOME;
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ws });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ws });
      process.env.GBRAIN_HOME = gbHome;
      await interviewAndRender(ws);
      expect(readManifest(ws).state).toBe('initialized');

      // AGENTS.md — Codex's ONLY per-turn mechanism — wires the session
      // boundary to HEARTBEAT.md's due-job list (session start + turn
      // boundaries). This is the link the boundary verbs hang off.
      const agents = readFileSync(join(ws, 'AGENTS.md'), 'utf8');
      expect(agents).toContain('## Session startup');
      expect(agents).toMatch(/HEARTBEAT\.md[^\n]*due-job list/);
      expect(agents).toContain('turn boundaries');

      // ...and the RENDERED HEARTBEAT.md row it points to binds BOTH verbs to
      // their boundaries on one line: delta at every session start + turn
      // boundary (the heartbeat), context-pack paired at session start.
      const heartbeat = readFileSync(join(ws, 'HEARTBEAT.md'), 'utf8');
      const row = heartbeat.split('\n').find((l) => l.startsWith('| ambient-delta |'));
      expect(row, 'rendered HEARTBEAT.md lost its ambient-delta due-job row').toBeDefined();
      expect(row!).toContain('every session start + turn boundary');
      expect(row!).toMatch(/`gbrain delta[^`]*`/);
      expect(row!).toMatch(/`gbrain context-pack[^`]*` at session start/);
    } finally {
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      for (const d of [gbHome, ws]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 120_000);
});

describe.skipIf(!CAN_RUN)('bootstrap real-codex door (serial e2e)', () => {
  // ── 1. INSTALL ────────────────────────────────────────────────────────────
  test('INSTALL: keyless init → interview → render → real `codex mcp add` → verify', async () => {
    const gbHome = mkdtempSync(join(tmpdir(), 'gb-rc-home-'));
    const ws = mkdtempSync(join(tmpdir(), 'gb-rc-ws-'));
    const codexHost = mkdtempSync(join(tmpdir(), 'gb-rc-codex-'));
    const shimDir = mkdtempSync(join(tmpdir(), 'gb-rc-bin-'));
    const savedHome = process.env.GBRAIN_HOME;
    const savedCodexHome = process.env.CODEX_HOME;
    try {
      // The in-process hooks writer resolves CODEX_HOME || ~/.codex — pin it
      // to the hermetic host dir so the trust-gated pair lands (and is
      // asserted) there, never in the runner's real ~/.codex.
      process.env.CODEX_HOME = join(codexHost, '.codex');
      // A fresh git workspace (the cwd the human pasted into) with a brain/ dir.
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ws });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ws });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ws });
      mkdirSync(join(ws, 'brain'), { recursive: true });

      // Hermetic ~/.codex for the real `codex mcp add`.
      seedCodexHome(codexHost);
      const codexRunner = makeCodexRunner(codexHost);

      // A dummy absolute gbrain binary the registration records (never executed
      // by INSTALL — the mcp-add just writes its path into config.toml).
      const gbrainBin = join(shimDir, 'gbrain');
      Bun.write(gbrainBin, '#!/bin/sh\nexit 0\n');
      execFileSync('chmod', ['+x', gbrainBin]);

      process.env.GBRAIN_HOME = gbHome;

      // (a) Keyless init — the REAL CLI, non-interactive, no embedding provider.
      const init = spawnSync('bun', ['run', CLI, 'init', '--pglite', '--no-embedding', '--non-interactive'], {
        cwd: ws,
        env: { ...process.env, GBRAIN_HOME: gbHome },
        encoding: 'utf8',
        timeout: 120_000,
      });
      expect(init.status).toBe(0);
      const dbPath = join(gbHome, '.gbrain', 'brain.pglite');
      expect(existsSync(dbPath)).toBe(true);

      // Register the workspace source the interview's default GBRAIN_SOURCE
      // routes to (verify's write-through needs a source with a localPath).
      const engineConfig = { engine: 'pglite' as const, database_path: dbPath };
      const engine = await createEngine(engineConfig);
      await engine.connect(engineConfig);
      await engine.initSchema();
      await addSource(engine, { id: 'workspace', localPath: join(ws, 'brain'), force: true });
      await engine.disconnect();

      // (b) Interview — scripted answers, read-back hash confirm.
      expect(initState(ws).ok).toBe(true);
      for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
        const r = setAnswer(ws, key, value);
        if (!r.ok) throw new Error(r.message);
      }
      const h = readBackHash(ws);
      if (!h.ok) throw new Error(h.message);
      expect(confirm(ws, h.hash).ok).toBe(true);

      // (c) Render — identity files + manifest.
      expect(await runBootstrap(['render', '--workspace', ws])).toBe(0);
      expect(readManifest(ws).state).toBe('initialized');

      // AGENTS.md carries the Gate-3 brain-first pull protocol (Codex's only
      // per-turn mechanism — gbrain does not wire Codex hooks yet).
      const agents = readFileSync(join(ws, 'AGENTS.md'), 'utf8');
      expect(agents).toContain('Gate 3');
      expect(agents.toLowerCase()).toContain('brain first');
      expect(agents).toContain('recall');

      // (d) hooks --harness codex → REAL `codex mcp add` via the runner seam.
      const { result: hooksCode, out: hooksOut } = await captureStdout(() =>
        runBootstrap(['hooks', '--workspace', ws, '--harness', 'codex', '--gbrain-bin', gbrainBin], {
          runner: codexRunner,
        }),
      );
      expect(hooksCode).toBe(0);
      // SessionEnd capture is wired (trust-gated pair); per-turn stays pull.
      expect(hooksOut).toContain('codex SessionEnd hook installed');
      expect(hooksOut).toContain('per-turn context on codex stays the AGENTS.md pull protocol');
      const hooksJson = readFileSync(join(codexHost, '.codex', 'hooks.json'), 'utf8');
      expect(hooksJson).toContain('hook session-end --harness codex');
      expect(hooksJson).not.toContain('GBRAIN_SOURCE'); // machine-global file: runtime payload resolution only

      // Real `codex mcp get gbrain` shows our server (env values are masked in
      // the human view, so the source binding is asserted on config.toml below).
      const get = await codexRunner(['codex', 'mcp', 'get', 'gbrain']);
      expect(get.code).toBe(0);
      expect(get.stdout).toContain('gbrain');
      expect(get.stdout).toContain('serve');
      expect(get.stdout).toContain('GBRAIN_SOURCE');

      // The hermetic config.toml the real codex wrote carries our server +
      // the exact GBRAIN_SOURCE binding (the [G1] workspace-source routing).
      const toml = readFileSync(join(codexHost, '.codex', 'config.toml'), 'utf8');
      expect(toml).toContain('[mcp_servers.gbrain]');
      expect(toml).toContain(gbrainBin);
      expect(toml).toContain('GBRAIN_SOURCE = "workspace"');
      // The hooks trust entry — without it codex silently never runs the hook.
      expect(toml).toContain('gbrain:codex-hooks-trust');
      expect(toml).toMatch(/trusted_hash = "sha256:[0-9a-f]{64}"/);

      // (e) verify → exit 0 (keyless PGLite; no repo/hooks for the codex path).
      const { result: verifyCode, out: verifyOut } = await captureStdout(() =>
        runBootstrap(['verify', '--workspace', ws, '--json']),
      );
      expect(verifyCode).toBe(0);
      const payload = JSON.parse(verifyOut) as { ok: boolean; checks: Array<{ id: string; ok: boolean }> };
      expect(payload.ok).toBe(true);
      const roundtrip = payload.checks.find((c) => c.id === 'roundtrip');
      expect(roundtrip?.ok).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
      for (const d of [gbHome, ws, codexHost, shimDir]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 300_000);

  // ── 2. SMOKE ────────────────────────────────────────────────────────────────
  test('SMOKE: real `codex exec` → gbrain MCP → brain → seeded fact', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-rc-smoke-'));
    try {
      // `codex exec` refuses an untrusted cwd ("Not inside a trusted
      // directory"); a git repo satisfies the check. The turn runs with
      // cwd=home, so make home a repo (never committed to).
      execFileSync('git', ['init', '-q', home]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: home });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: home });

      // Seed a keyless brain the spawned `gbrain serve` will read.
      const sourceId = 'workspace';
      const seeded = await seedBrainForAgent(home, sourceId);

      // Hermetic ~/.codex (auth + model settings), then register gbrain as a
      // stdio MCP server pinned to the seeded brain via the REAL `codex mcp add`
      // (exact shape from docs/mcp/CODEX.md + registerCodexMcp). Prefer a
      // compiled binary so MCP startup is fast enough that codex's tool-call
      // window doesn't close before the server is ready (the "the available
      // gbrain mcp calls were cancelled" flake); fall back to `bun run
      // src/cli.ts serve` otherwise.
      seedCodexHome(home);
      const runner = makeCodexRunner(home);
      const server = resolveGbrainServerCommand(REPO_ROOT, ['--surface', 'full']);
      const add = await runner([
        'codex', 'mcp', 'add', 'gbrain',
        '--env', `GBRAIN_HOME=${home}`,
        '--env', `GBRAIN_SOURCE=${sourceId}`,
        '--', server.command, ...server.args,
      ]);
      expect(add.code).toBe(0);

      // The prompt names the shell fallback explicitly: if the MCP tool is
      // unavailable, run `gbrain query` — which resolves to $HOME/.gbrain
      // (== the seeded brain, since HOME is the temp dir).
      const prompt =
        `You have a gbrain MCP tool connected to a knowledge brain. ` +
        `Using ONLY that brain (do not guess, do not use general knowledge), answer: ` +
        `${seeded.query} Report exactly what the brain says. ` +
        `If no gbrain MCP tool is available, run the shell command ` +
        `\`bun run ${CLI} query "${seeded.query}"\` and answer from its output.`;

      // Bounded retry (max 2) rides out a transient MCP-startup cancellation.
      // PASS only when an attempt lands BOTH a gbrain tool/command AND the
      // seeded fact; never pass on zero tool calls, never soften.
      const fact = 'rivermouth';
      const perAttemptTimeout = server.kind === 'compiled' ? 190_000 : 230_000;
      const maxAttempts = 2;
      let passed = false;
      let lastEvidence = '';

      for (let attempt = 1; attempt <= maxAttempts && !passed; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 3_000));
        const turn = await codexExecTurn({ prompt, cwd: home, home, timeoutMs: perAttemptTimeout });
        const raw = turn.rawLines.join('\n');
        // The harness JSONL parser only captures command_execution/agent_message/
        // reasoning — a Codex MCP tool call is a distinct `mcp_tool_call` item, so
        // detect it on the raw stream. server:"gbrain" proves the call hit OUR
        // registered brain server (not general knowledge).
        const usedMcp = /"type"\s*:\s*"mcp_tool_call"[^\n]*"server"\s*:\s*"gbrain"/.test(raw);
        // Shell fallback: codex ran our `gbrain query` command (surfaced in the
        // parsed command_execution toolCalls). Either path is a valid proof of
        // real codex → real gbrain → brain.
        const usedShell = turn.toolCalls.some((c) => /gbrain|cli\.ts\s+query|\bquery\b/i.test(c));
        const usedGbrain = usedMcp || usedShell;
        const gotFact = turn.finalText.toLowerCase().includes(fact);

        lastEvidence =
          `[smoke codex attempt ${attempt}/${maxAttempts}] server=${server.kind} ` +
          `exit=${turn.exitCode} timedOut=${turn.timedOut} usedMcp=${usedMcp} usedShell=${usedShell} gotFact=${gotFact}\n` +
          `toolCalls=${JSON.stringify(turn.toolCalls)}\n` +
          `finalText=${turn.finalText.slice(0, 800)}`;
        console.log(lastEvidence);

        if (usedGbrain && gotFact) passed = true;
      }

      expect(passed, `SMOKE failed on all ${maxAttempts} attempts.\n${lastEvidence}`).toBe(true);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 480_000);

  // ── 3. BOUNDARY ─────────────────────────────────────────────────────────────
  test('BOUNDARY: real `codex exec` session start → context_pack/delta over MCP', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-rc-boundary-'));
    const savedHome = process.env.GBRAIN_HOME;
    try {
      // Trusted-cwd git repo (same `codex exec` requirement as SMOKE).
      execFileSync('git', ['init', '-q', home]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: home });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: home });

      // A real brain behind the MCP server: context_pack/delta reach
      // migration v126's session_context_state through the production engine.
      const sourceId = 'workspace';
      await seedBrainForAgent(home, sourceId);

      // Hermetic ~/.codex + real `codex mcp add` (SMOKE's registration shape,
      // but on `--surface verbs`: the SEVEN frozen memory verbs — context_pack
      // + delta included — are servable alone, and the small tool list keeps a
      // codex client from truncating them out of a 100+-tool full surface).
      seedCodexHome(home);
      const runner = makeCodexRunner(home);
      const server = resolveGbrainServerCommand(REPO_ROOT, ['--surface', 'verbs']);
      const add = await runner([
        'codex', 'mcp', 'add', 'gbrain',
        '--env', `GBRAIN_HOME=${home}`,
        '--env', `GBRAIN_SOURCE=${sourceId}`,
        '--', server.command, ...server.args,
      ]);
      expect(add.code).toBe(0);

      // Render the REAL bootstrap protocol into the cwd — the same
      // AGENTS.md + HEARTBEAT.md chain the always-run pin above asserts on is
      // what this codex actually reads at its session boundary.
      process.env.GBRAIN_HOME = home;
      await interviewAndRender(home);

      // Enable the ambient-delta due-job (every job ships DISABLED; flipping
      // the Enabled cell is the documented operator ritual) so the
      // session-start protocol has a due boundary job to run.
      const hbPath = join(home, 'HEARTBEAT.md');
      const hb = readFileSync(hbPath, 'utf8');
      const enabled = hb.replace(/^(\| ambient-delta \|[^|]*\|) no \|/m, '$1 yes |');
      expect(enabled).not.toBe(hb);
      writeFileSync(hbPath, enabled);

      // The per-turn steer mirrors SMOKE's: name the MCP path explicitly (the
      // HEARTBEAT row spells the CLI form) AND give SMOKE's shell fallback —
      // headless codex stdio-MCP is unreliable (the SMOKE flake), and the CLI
      // spelling exercises the exact command the shipped HEARTBEAT row tells
      // agents to run.
      const prompt =
        'You are starting a new session. Follow your AGENTS.md session-start protocol for memory: ' +
        `check HEARTBEAT.md's due-job list and run what is due at a session-start boundary. ` +
        'The gbrain MCP server is connected; its context_pack and delta tools are the MCP form of the ' +
        '`gbrain context-pack` / `gbrain delta` commands. Use "codex-boundary" as the session id. ' +
        'If no gbrain MCP tool is available, run the shell command ' +
        `\`bun run ${CLI} delta --session-id codex-boundary --budget-tokens 2000\` instead. ` +
        'After the boundary pull, reply with one line.';

      // Bounded retry (max 2, same as SMOKE) rides out a transient
      // MCP-startup cancellation. PASS only when an attempt lands a boundary
      // verb against OUR gbrain — over MCP (an `mcp_tool_call` naming
      // context_pack or delta; EITHER verb counts, boundary behavior over
      // exact tool) or through the real CLI (SMOKE's fallback contract; the
      // evidence line documents which path proved out). Never pass on zero
      // boundary calls, never soften.
      const perAttemptTimeout = server.kind === 'compiled' ? 190_000 : 230_000;
      const maxAttempts = 2;
      let passed = false;
      let lastEvidence = '';

      for (let attempt = 1; attempt <= maxAttempts && !passed; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 3_000));
        const turn = await codexExecTurn({ prompt, cwd: home, home, timeoutMs: perAttemptTimeout });
        // A Codex MCP tool call is a distinct `mcp_tool_call` item on the raw
        // stream (the harness parser only captures command_execution/
        // agent_message/reasoning). Field ORDER and the tool-name key inside
        // the item are not pinned across codex versions, so match the parts
        // per line rather than one order-dependent regex.
        const usedMcp = turn.rawLines.some(
          (l) =>
            /"type"\s*:\s*"mcp_tool_call"/.test(l) &&
            l.includes('gbrain') &&
            /context_pack|\bdelta\b/.test(l),
        );
        // Shell fallback: codex INVOKED a boundary verb through the real CLI
        // (`… cli.ts delta --session-id …` / `… context-pack …`), surfaced in
        // the parsed command_execution toolCalls. Anchored on the CLI so a
        // mere `grep ambient-delta HEARTBEAT.md` read can never count.
        const usedShell = turn.toolCalls.some((c) =>
          /(?:cli\.ts|gbrain)\s+(?:delta|context-pack)\b/i.test(c),
        );
        const boundaryCall = usedMcp || usedShell;
        lastEvidence =
          `[boundary codex attempt ${attempt}/${maxAttempts}] server=${server.kind} ` +
          `exit=${turn.exitCode} timedOut=${turn.timedOut} usedMcp=${usedMcp} usedShell=${usedShell}\n` +
          `toolCalls=${JSON.stringify(turn.toolCalls)}\n` +
          `finalText=${turn.finalText.slice(0, 800)}`;
        console.log(lastEvidence);
        if (boundaryCall) passed = true;
      }

      expect(passed, `BOUNDARY failed on all ${maxAttempts} attempts.\n${lastEvidence}`).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 480_000);
});

// ── 4. AMBIENT-WRITEBACK door (WP8/OV-A12 — NON-GATING evidence) ─────────────
// The hermetic lifecycle fixture (test/ambient-writeback-lifecycle.serial.
// test.ts) proves the wiring deterministically with a scripted agent; THIS
// door proves the headline behavior with the real model: a managed
// ambient-writeback AGENTS.md block + a plain user statement → codex saves
// the preference through gbrain WITHOUT being told to in the prompt. Auth-
// gated skip; bounded retry; never in required CI (flaky-model tolerance is
// the retry, not a softened assertion).
describe.skipIf(!CAN_RUN)('real codex — ambient writeback door (non-gating)', () => {
  test('managed block + plain user statement → unprompted remember lands the fact', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-rc-wb-'));
    try {
      execFileSync('git', ['init', '-q', home]);
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: home });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: home });

      const sourceId = 'workspace';
      await seedBrainForAgent(home, sourceId);

      // Enable ambient writeback on the seeded brain's DB plane — what the
      // spawned serve's boot resolver reads (WP2 stdio lane).
      {
        const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
        const eng = new PGLiteEngine();
        await eng.connect({ database_path: join(home, '.gbrain', 'brain.pglite') });
        await eng.setConfig('memory.auto_writeback', 'salient');
        await eng.disconnect();
      }

      // The PRODUCTION block (exact renderer) over seedCodexHome's placeholder
      // AGENTS.md — the only instruction surface telling codex to save.
      seedCodexHome(home);
      const { installAmbientWritebackBlockAt, renderAmbientInstructionBlock } =
        await import('../../src/core/bootstrap/instructions-block.ts');
      installAmbientWritebackBlockAt(
        join(home, '.codex', 'AGENTS.md'),
        renderAmbientInstructionBlock({ mode: 'salient', transientTtl: '3d', visibility: 'world', serveUrl: 'stdio:test' }),
      );

      const runner = makeCodexRunner(home);
      const server = resolveGbrainServerCommand(REPO_ROOT, ['--surface', 'full']);
      const add = await runner([
        'codex', 'mcp', 'add', 'gbrain',
        '--env', `GBRAIN_HOME=${home}`,
        '--env', `GBRAIN_SOURCE=${sourceId}`,
        '--', server.command, ...server.args,
      ]);
      expect(add.code).toBe(0);

      // A plain user statement — the prompt NEVER mentions saving, memory,
      // gbrain, or tools. Only the AGENTS.md block carries the contract.
      const prompt = 'I prefer dark mode in every editor — that is my standing preference going forward. A one-line acknowledgement is enough.';

      const maxAttempts = 2;
      let passed = false;
      let lastEvidence = '';
      for (let attempt = 1; attempt <= maxAttempts && !passed; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 3_000));
        const turn = await codexExecTurn({ prompt, cwd: home, home, timeoutMs: 230_000 });
        const raw = turn.rawLines.join('\n');
        const usedWriteTool = /"type"\s*:\s*"mcp_tool_call"[^\n]*"server"\s*:\s*"gbrain"[^\n]*"tool"\s*:\s*"(remember|extract_facts)"/.test(raw)
          || (/"server"\s*:\s*"gbrain"/.test(raw) && /"tool"\s*:\s*"(remember|extract_facts)"/.test(raw));

        // Ground truth: did a fact land in the brain? (codex's MCP server
        // exits with the turn, so the PGLite lock is free again.)
        await new Promise((r) => setTimeout(r, 1_000));
        let factRow = false;
        try {
          const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
          const eng = new PGLiteEngine();
          await eng.connect({ database_path: join(home, '.gbrain', 'brain.pglite') });
          const rows = await eng.executeRaw<{ n: number | string }>(
            `SELECT count(*)::int AS n FROM facts WHERE lower(fact) LIKE '%dark mode%'`,
          );
          factRow = Number(rows[0]?.n ?? 0) > 0;
          await eng.disconnect();
        } catch { /* lock contention — evidence line carries it */ }

        lastEvidence =
          `[wb door attempt ${attempt}/${maxAttempts}] exit=${turn.exitCode} timedOut=${turn.timedOut} ` +
          `usedWriteTool=${usedWriteTool} factRow=${factRow}\n` +
          `finalText=${turn.finalText.slice(0, 400)}`;
        console.log(lastEvidence);
        if (factRow || usedWriteTool) passed = true;
      }
      expect(passed, `ambient-writeback door failed on all ${maxAttempts} attempts.\n${lastEvidence}`).toBe(true);
    } finally {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 480_000);
});
