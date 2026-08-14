/**
 * REAL Claude Code "door" E2E — drives the ACTUAL `claude` binary (no PATH
 * shims), end to end, against a real keyless PGLite brain. Two proofs:
 *
 *   (1) SETUP+INSTALL — in a hermetic temp HOME + CLAUDE_CONFIG_DIR +
 *       GBRAIN_HOME + workspace, drive the real `gbrain` bootstrap CLI to an
 *       installed state: `gbrain init --pglite --no-embedding` (keyless),
 *       interview (--set required answers + --confirm), render, then
 *       `gbrain bootstrap hooks --harness claude-code` — which runs the REAL
 *       `claude mcp add` into the temp config (project-scope `.mcp.json` in the
 *       workspace). We then run the REAL `claude mcp get gbrain` and assert it
 *       shows OUR serve command + GBRAIN_SOURCE binding (real-registration
 *       proof), and `gbrain bootstrap verify` exits 0 in this hermetic HOME.
 *
 *   (2) SMOKE — the real-harness-in-the-loop proof: seed a distinctive,
 *       100%-synthetic fact into a keyless brain, write a `--mcp-config` that
 *       runs THIS repo's `gbrain serve` over stdio, and drive one headless
 *       `claude -p` turn asking about the seeded entity. Assert a gbrain MCP
 *       tool actually fired (real claude → real gbrain MCP → real brain) AND
 *       the seeded fact surfaced. This is the whole product in one turn.
 *
 * Every real-agent turn pays API cost and takes 30s–2min, so prompts are
 * minimal (one seeded fact, one question) and timeouts are capped. The whole
 * describe fail-SKIPs (never fail-HARD) on a machine without the `claude`
 * binary or its auth. Serial: PGLite cold starts + real subprocess spawns
 * would starve parallel siblings.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolveClaudeBinary,
  hasClaudeAuth,
  hermeticChildEnv,
  seedBrainForAgent,
  writeGbrainMcpConfig,
  claudeHeadlessTurn,
  resolveGbrainServerCommand,
} from '../helpers/agent-harness.ts';
import { runBootstrap } from '../../src/commands/bootstrap.ts';
import type { ExecRunner, ExecResult } from '../../src/core/bootstrap/repo.ts';
import { readBackHash } from '../../src/core/bootstrap/interview.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { addSource } from '../../src/core/sources-ops.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLAUDE_BIN = resolveClaudeBinary();
const CAN_RUN = !!CLAUDE_BIN && hasClaudeAuth();

/** Same required-answer set the shimmed lifecycle e2e uses (synthetic). */
const REQUIRED_ANSWERS: Record<string, string> = {
  AGENT_NAME: 'Lighthouse',
  PRINCIPAL_NAME: 'Pat Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research group; builds internal tooling; values signal over noise.',
  VOICE_REGISTER: 'Direct: three options, the second one wins.',
};

// ── Shared hermetic state (built once, torn down after) ─────────────────────
let tmpParent: string; // GBRAIN_HOME (parent — config appends `.gbrain`)
let home: string; // temp $HOME for the spawned claude
let claudeCfg: string; // temp CLAUDE_CONFIG_DIR
let ws: string; // the "installed" workspace
let binDir: string; // holds the dummy absolute gbrain binary path
let gbrainBin: string;

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'DATABASE_URL', 'GBRAIN_DATABASE_URL'];

/** Capture console.log around an async call (runBootstrap prints via console.log). */
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

/**
 * ExecRunner that spawns the REAL `claude` binary with a hermetic env pinned
 * at the temp HOME + CLAUDE_CONFIG_DIR, cwd=workspace (project-scope MCP config
 * lives in the workspace `.mcp.json`, and `mcp get`/`list` read it from cwd).
 * argv[0]==='claude' is rewritten to the resolved absolute binary so PATH quirks
 * never intercept it. Nothing else on the operator's box is touched.
 */
const claudeRunner: ExecRunner = async (argv: string[]): Promise<ExecResult> => {
  const real = argv[0] === 'claude' && CLAUDE_BIN ? [CLAUDE_BIN, ...argv.slice(1)] : argv;
  try {
    const proc = Bun.spawn(real, {
      cwd: ws,
      env: hermeticChildEnv({ HOME: home, CLAUDE_CONFIG_DIR: claudeCfg }),
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

beforeAll(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  // Ambient DATABASE_URL must not flip the sandboxed brain to Postgres.
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.GBRAIN_SOURCE;
  delete process.env.GBRAIN_HOOKS;

  // Short prefix — the IPC socket for the hooks smoke lives under database_path
  // and unix socket paths cap ~104 bytes on macOS.
  tmpParent = mkdtempSync(join(tmpdir(), 'gb-rc-'));
  home = mkdtempSync(join(tmpdir(), 'gb-rc-home-'));
  claudeCfg = mkdtempSync(join(tmpdir(), 'gb-rc-cfg-'));
  ws = mkdtempSync(join(tmpdir(), 'gb-rc-ws-'));
  mkdirSync(join(ws, 'brain'), { recursive: true });

  // A dummy absolute gbrain binary for the MCP registration + hook command
  // strings (never executed here — the registration only records the path, and
  // `claude mcp get` reads config without launching the server).
  binDir = mkdtempSync(join(tmpdir(), 'gb-rc-bin-'));
  gbrainBin = join(binDir, 'gbrain');
  writeFileSync(gbrainBin, '#!/bin/sh\nexit 0\n');
  chmodSync(gbrainBin, 0o755);

  // In-process bootstrap subcommands resolve the home from this env.
  process.env.GBRAIN_HOME = tmpParent;
}, 60_000);

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  for (const dir of [tmpParent, home, claudeCfg, ws, binDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe.skipIf(!CAN_RUN)('bootstrap real Claude Code door (serial e2e)', () => {
  test('SETUP+INSTALL: real `gbrain` bootstrap → real `claude mcp add` → verify exit 0', async () => {
    // 1. Engine phase: real keyless PGLite init as a subprocess (no API keys).
    const init = spawnSync(
      'bun',
      ['run', join(REPO_ROOT, 'src', 'cli.ts'), 'init', '--pglite', '--no-embedding', '--non-interactive'],
      {
        cwd: ws,
        env: { ...process.env, GBRAIN_HOME: tmpParent, HOME: home } as Record<string, string>,
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    expect(init.status).toBe(0);
    const cfgPath = join(tmpParent, '.gbrain', 'config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { engine: string; database_path: string; embedding_disabled?: boolean };
    expect(cfg.engine).toBe('pglite');
    expect(cfg.embedding_disabled).toBe(true);

    // Register the workspace source with its brain/ dir so put_page write-through
    // (the roundtrip check) lands files in the repo — the installed-state that
    // `gbrain sources add workspace --path <ws>/brain` produces.
    const engineConfig = { engine: 'pglite' as const, database_path: cfg.database_path };
    const engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    await addSource(engine, { id: 'workspace', localPath: join(ws, 'brain'), force: true });
    await engine.disconnect();

    // 2. Interview: real CLI, scripted answers, read-back-hash confirm.
    expect(await runBootstrap(['interview', '--init', '--workspace', ws])).toBe(0);
    for (const [key, value] of Object.entries(REQUIRED_ANSWERS)) {
      expect(await runBootstrap(['interview', '--set', key, value, '--workspace', ws])).toBe(0);
    }
    expect(await runBootstrap(['interview', '--set', 'MCP_SCOPE', 'project', '--workspace', ws])).toBe(0);
    expect(await runBootstrap(['interview', '--set', 'HOOKS_CONSENT', 'yes', '--workspace', ws])).toBe(0);
    const h = readBackHash(ws);
    if (!h.ok) throw new Error(h.message);
    expect(await runBootstrap(['interview', '--confirm', h.hash, '--workspace', ws])).toBe(0);

    // 3. Render identity files from the confirmed answers.
    expect(await runBootstrap(['render', '--workspace', ws])).toBe(0);

    // 4. Hooks: REAL `claude mcp add` (project scope) via the hermetic runner,
    // plus per-turn hooks written into the workspace settings.
    const { result: hooksCode, out: hooksOut } = await captureStdout(() =>
      runBootstrap(['hooks', '--workspace', ws, '--harness', 'claude-code', '--gbrain-bin', gbrainBin], {
        runner: claudeRunner,
      }),
    );
    expect(hooksCode).toBe(0);
    // The registration smoke VERIFIED (via real `claude mcp get`) that the
    // recorded server carries our binary + this workspace's source.
    expect(hooksOut).toContain('verified targeting this workspace');

    // 5. Real-registration PROOF: query the actual `claude` config back.
    const got = await claudeRunner(['claude', 'mcp', 'get', 'gbrain']);
    expect(got.code).toBe(0);
    const registered = `${got.stdout}\n${got.stderr}`;
    expect(registered).toContain(gbrainBin); // OUR serve binary, absolute path
    expect(registered).toContain('serve');
    expect(registered).toContain('GBRAIN_SOURCE=workspace'); // the source binding

    // 6. `gbrain bootstrap verify` — the whole install contract — exits 0 in
    // this real hermetic HOME (keyless: magic moment via the zero-LLM fence).
    const { result: verifyCode, out: verifyOut } = await captureStdout(() =>
      runBootstrap(['verify', '--workspace', ws, '--json']),
    );
    if (verifyCode !== 0) {
      // Surface the report so a failure is diagnosable, not a bare exit code.
      throw new Error(`verify failed (exit ${verifyCode}):\n${verifyOut}`);
    }
    expect(verifyCode).toBe(0);
    const payload = JSON.parse(verifyOut) as { ok: boolean; checks: Array<{ id: string; ok: boolean; warn?: boolean }> };
    expect(payload.ok).toBe(true);
    const byId = (id: string) => payload.checks.find((c) => c.id === id);
    expect(byId('roundtrip')?.ok).toBe(true);
    expect(byId('magic_moment')?.ok).toBe(true);
  }, 300_000);

  test('SMOKE: real `claude -p` → real gbrain MCP → real brain → surfaced fact', async () => {
    // Independent hermetic brain for the recall proof (its own home + workspace).
    const smokeHome = mkdtempSync(join(tmpdir(), 'gb-rc-smoke-'));
    const smokeWs = mkdtempSync(join(tmpdir(), 'gb-rc-smoke-ws-'));
    const mcpCfgPath = join(smokeHome, 'gbrain-mcp.json');
    try {
      const seeded = await seedBrainForAgent(smokeHome, 'workspace');
      // Prefer a compiled binary (fast MCP startup) so the child's first tool
      // call isn't cancelled; fall back to `bun run src/cli.ts serve` with a
      // wider readiness window if the compile is unavailable in this sandbox.
      const server = resolveGbrainServerCommand(REPO_ROOT);
      writeGbrainMcpConfig({
        path: mcpCfgPath,
        server,
        gbrainHome: smokeHome,
        sourceId: 'workspace',
      });

      // Bounded retry (max 2) rides out a transient MCP-startup cancellation.
      // PASS only when an attempt lands BOTH a gbrain tool AND the seeded fact;
      // never pass on zero tool calls, never soften to "answered something".
      const perAttemptTimeout = server.kind === 'compiled' ? 150_000 : 190_000;
      const maxAttempts = 2;
      let passed = false;
      let lastEvidence = '';

      for (let attempt = 1; attempt <= maxAttempts && !passed; attempt++) {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 3_000));
        const turn = await claudeHeadlessTurn({
          prompt:
            `Use your gbrain memory tools to answer: ${seeded.query} ` +
            `Answer only from the brain, in one short sentence.`,
          cwd: smokeWs,
          home,
          claudeConfigDir: claudeCfg,
          mcpConfigPath: mcpCfgPath,
          timeoutMs: perAttemptTimeout,
        });

        // Real claude actually invoked OUR MCP server over stdio: a gbrain tool
        // name (e.g. `mcp__gbrain__search`) appears in the tool-call trace.
        // `toolCalls` holds tool NAMES only, so this can't false-positive on a
        // stray "gbrain" substring in a file path or the raw event stream.
        const firedGbrainTool = turn.toolCalls.some((t) => /gbrain/i.test(t));
        // And the seeded, brain-ONLY fact reached the final answer. Only
        // "rivermouth" proves recall — the entity "Summit Robotics" is echoed
        // from the question, so matching it would be a false positive.
        const gotFact = /rivermouth/i.test(turn.finalText);

        lastEvidence =
          `[smoke claude attempt ${attempt}/${maxAttempts}] server=${server.kind} ` +
          `exit=${turn.exitCode} timedOut=${turn.timedOut} firedGbrainTool=${firedGbrainTool} gotFact=${gotFact}\n` +
          `toolCalls=${JSON.stringify(turn.toolCalls)}\n` +
          `finalText=${turn.finalText.slice(0, 800)}\n` +
          `raw tail=${turn.rawLines.slice(-6).join('\n')}`;
        console.log(lastEvidence);

        if (firedGbrainTool && gotFact) passed = true;
      }

      expect(passed, `SMOKE failed on all ${maxAttempts} attempts.\n${lastEvidence}`).toBe(true);
    } finally {
      for (const dir of [smokeHome, smokeWs]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }, 420_000);
});
