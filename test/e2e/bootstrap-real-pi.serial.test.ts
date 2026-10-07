/**
 * REAL-agent door test — pi edition. Drives the ACTUAL `pi` binary
 * (pi-coding-agent, no PATH shim) against a real gbrain over the seams that
 * matter for pi:
 *
 *   1. INSTALL — `gbrain bootstrap hooks --harness pi` into a hermetic
 *      PI_CODING_AGENT_DIR. Asserts the gbrain-owned extension landed at
 *      <agent-dir>/extensions/gbrain-hooks.ts with its line-1 ownership
 *      marker, the stdio MCP entry landed in <agent-dir>/mcp.json, and
 *      `gbrain bootstrap verify --harness pi` exits 0.
 *
 *   2. SMOKE — a live `pi -p` turn. gbrain is registered as a pi stdio MCP
 *      server pinned to a seeded keyless brain holding ONE nonce fact. The
 *      model is asked a question only the brain can answer; we assert the
 *      nonce surfaces in the final text. Proves: real pi → gbrain MCP →
 *      brain → fact.
 *
 *   3. HOOKS — the part no fake ExtensionAPI can prove. A live `pi -p` turn
 *      with the rendered extension installed fires gbrain's hook lane against
 *      a real session file: we assert the heartbeat recorded
 *      session-start/user-prompt for the pi lane, that the session file was
 *      discoverable by the id the extension read, and that a `gbrain-context`
 *      custom_message reached the session. Proves the extension's event map
 *      is bound to the real pi lifecycle, not our model of it.
 *
 * EVERYTHING is hermetic (temp HOME / PI_CODING_AGENT_DIR / GBRAIN_HOME per
 * test) and the live describes self-SKIP via describe.skipIf when the pi
 * binary or its auth is absent, so this is a clean no-op on a runner without
 * them. Serial: PGLite cold starts + a real model turn would starve parallel
 * siblings; every test carries an explicit timeout. Real turns cost API and
 * take ~10-60s — prompts are minimal (one seeded fact, one question) and
 * capped at 240s.
 *
 * The extension also has a FAKE-API unit suite (test/pi-hooks-extension.test.ts)
 * that runs everywhere; this file is the native half: it proves pi itself
 * loads the extension and emits the events we bound to.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolvePiBinary,
  hasPiAuth,
  hermeticChildEnv,
  seedBrainForAgent,
} from '../helpers/agent-harness.ts';
import { runBootstrap } from '../../src/commands/bootstrap.ts';
import { readPiHooksStatus, PI_HOOKS_MARKER } from '../../src/core/bootstrap/pi-hooks.ts';
import { piHooksExtensionPath, piMcpConfigPath } from '../../src/core/bootstrap/host-specs.ts';
import { resolveGbrainHome } from '../../src/core/gbrain-home.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const PI_BIN = resolvePiBinary();
const CAN_RUN = !!PI_BIN && hasPiAuth();

/**
 * A gbrain binary the extension can exec that resolves to the code under test.
 *
 * Why this exists: `gbrain bootstrap hooks` with no `--gbrain-bin` falls back
 * to `resolveGbrainBin()` → `Bun.which('gbrain')`, i.e. whatever the OPERATOR
 * has on PATH (~/.bun/bin/gbrain → their live checkout, usually a different
 * version). A door test that accepts that is testing the operator's install,
 * not this branch — the pi lane would be silently absent there, and the turn
 * would assert a different binary's behavior. `bin/` is gitignored, so pin an
 * executable shim onto `src/cli.ts` instead.
 */
function gbrainBinShim(dir: string): string {
  const p = join(dir, 'gbrain');
  writeFileSync(p, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}

const ENV_KEYS = [
  'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_HOOK_LANE',
  'PI_CODING_AGENT', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR',
];
const SAVED_ENV: Record<string, string | undefined> = {};

/**
 * Seed a hermetic <agent-dir> for a spawned pi. Copies ONLY the operator's
 * real auth.json (read-only copy) so pi authenticates without ever touching
 * the real ~/.pi/agent. Deliberately does NOT copy models.json, settings.json
 * or any installed extensions: the operator's private MCP servers and
 * extension set would both leak into the turn and change its behavior.
 */
function seedPiAgentDir(root: string): string {
  const agentDir = join(root, 'agent');
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  mkdirSync(join(agentDir, 'sessions'), { recursive: true });
  const src = join(homedir(), '.pi', 'agent', 'auth.json');
  const dst = join(agentDir, 'auth.json');
  if (existsSync(src) && !existsSync(dst)) {
    try { cpSync(src, dst); } catch { /* best-effort */ }
  }
  return agentDir;
}

/** A live non-interactive pi turn under a hermetic HOME/agent dir.
 *  `--mode json` so the transcript rows (including extension-delivered
 *  custom_message entries) are machine-readable. */
async function piTurn(opts: {
  home: string;
  agentDir: string;
  cwd: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<{ finalText: string; rows: Array<Record<string, unknown>>; exitCode: number }> {
  const proc = Bun.spawn(
    [PI_BIN!, '-p', '--mode', 'json', '--session-dir', join(opts.agentDir, 'sessions'), opts.prompt],
    {
      cwd: opts.cwd,
      env: hermeticChildEnv({ HOME: opts.home, PI_CODING_AGENT_DIR: opts.agentDir }),
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    },
  );
  const timer = setTimeout(() => { try { proc.kill(9); } catch { /* gone */ } }, opts.timeoutMs ?? 240_000);
  let out = '';
  let err = '';
  try {
    [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const exitCode = await proc.exited;
  const rows: Array<Record<string, unknown>> = [];
  let finalText = '';
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      rows.push(row);
      if (row.type === 'message' && typeof row.text === 'string') finalText += row.text;
      if (row.type === 'result' && typeof row.text === 'string') finalText += row.text;
    } catch { /* banner line, not JSON */ }
  }
  if (!finalText) finalText = out + err;
  return { finalText, rows, exitCode };
}

beforeAll(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  // Ambient-state strip: a dev/CI DATABASE_URL must not flip the sandboxed
  // brain to Postgres, and a stray PI_CODING_AGENT* must not let a child
  // resolve the operator's real agent dir.
  for (const k of ENV_KEYS) delete process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

// ── 1. INSTALL (always runs — needs NO pi binary) ───────────────────────────
describe('bootstrap harness pi — install into a hermetic agent dir (always runs)', () => {
  test('hooks --harness pi writes the marker extension + stdio MCP entry, and verify passes', async () => {
    const gbHome = mkdtempSync(join(tmpdir(), 'gb-pi-install-home-'));
    const agentRoot = mkdtempSync(join(tmpdir(), 'gb-pi-install-agent-'));
    const gbrainBin = gbrainBinShim(agentRoot);
    const agentDir = seedPiAgentDir(agentRoot);
    const savedHome = process.env.GBRAIN_HOME;
    const savedAgent = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.GBRAIN_HOME = gbHome;
      process.env.PI_CODING_AGENT_DIR = agentDir;

      const code = await runBootstrap(['hooks', '--harness', 'pi', '--gbrain-bin', gbrainBin]);
      expect(code).toBe(0);

      // The extension is gbrain-owned: line-1 marker, and it is the file the
      // host-specs resolution names (so bootstrap and the hook lane agree).
      const extPath = piHooksExtensionPath();
      expect(existsSync(extPath)).toBe(true);
      const src = readFileSync(extPath, 'utf8');
      expect(src.split('\n')[0]).toContain(PI_HOOKS_MARKER);
      expect(src).toContain(gbrainBin);

      // Ownership probe agrees.
      expect(readPiHooksStatus().owned).toBe(true);

      // The stdio MCP entry landed, resolving the same binary.
      const mcpPath = piMcpConfigPath();
      expect(existsSync(mcpPath)).toBe(true);
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
        mcpServers: Record<string, { command?: string; args?: string[]; description?: string }>;
      };
      const entry = mcp.mcpServers.gbrain;
      expect(entry, 'pi mcp.json is missing the gbrain entry').toBeDefined();
      expect(entry.command).toBe(gbrainBin);

      const verify = await runBootstrap(['verify', '--harness', 'pi']);
      expect(verify).toBe(0);
    } finally {
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgent;
      for (const d of [gbHome, agentRoot]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 120_000);

  test('a foreign extension at the target path is never overwritten', async () => {
    const gbHome = mkdtempSync(join(tmpdir(), 'gb-pi-foreign-home-'));
    const agentRoot = mkdtempSync(join(tmpdir(), 'gb-pi-foreign-agent-'));
    const agentDir = seedPiAgentDir(agentRoot);
    const savedHome = process.env.GBRAIN_HOME;
    const savedAgent = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.GBRAIN_HOME = gbHome;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const extPath = piHooksExtensionPath();
      const foreign = '// the operator hand-rolled this\nexport default function () {}\n';
      writeFileSync(extPath, foreign);

      const code = await runBootstrap(['hooks', '--harness', 'pi', '--gbrain-bin', gbrainBinShim(agentRoot)]);
      expect(code).not.toBe(0);
      expect(readFileSync(extPath, 'utf8')).toBe(foreign);
      expect(readPiHooksStatus().owned).toBe(false);
    } finally {
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgent;
      for (const d of [gbHome, agentRoot]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 120_000);
});

// ── 2+3. LIVE pi (self-skips without the binary + auth) ─────────────────────
describe.skipIf(!CAN_RUN)('real pi door — live turn, MCP recall + hook lane (serial e2e)', () => {
  test('SMOKE: a live pi turn recalls a nonce fact seeded only in the brain', async () => {
    const gbHome = mkdtempSync(join(tmpdir(), 'gb-pi-smoke-home-'));
    const agentRoot = mkdtempSync(join(tmpdir(), 'gb-pi-smoke-agent-'));
    const cwd = mkdtempSync(join(tmpdir(), 'gb-pi-smoke-cwd-'));
    const savedHome = process.env.GBRAIN_HOME;
    const savedAgent = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.GBRAIN_HOME = gbHome;
      const agentDir = seedPiAgentDir(agentRoot);
      process.env.PI_CODING_AGENT_DIR = agentDir;

      // A nonce fact: pi has filesystem/shell tools, so a committed string
      // would prove nothing (it is greppable in this checkout).
      const nonce = `ZQG-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
      const seeded = await seedBrainForAgent(gbHome, 'default', {
        entity: 'Northwind Marine',
        fact: `Northwind Marine stores its replacement propeller in locker ${nonce}.`,
        query: 'Where does Northwind Marine store its replacement propeller?',
        slug: 'projects/northwind-marine',
      });

      // Register the brain over stdio, pinned to the seeded source. The
      // binary is pinned to THIS checkout: a bare install would register the
      // operator's PATH gbrain and test their version instead of this branch.
      const code = await runBootstrap(['hooks', '--harness', 'pi', '--source', 'default', '--gbrain-bin', gbrainBinShim(agentRoot)]);
      expect(code).toBe(0);

      const turn = await piTurn({
        home: gbHome,
        agentDir,
        cwd,
        prompt: `Using the gbrain MCP tools, answer: ${seeded.query} Reply with the locker code only.`,
      });

      expect(turn.exitCode).toBe(0);
      expect(turn.finalText).toContain(nonce);
    } finally {
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgent;
      for (const d of [gbHome, agentRoot, cwd]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 300_000);

  test('HOOKS: a live pi turn fires the gbrain lane and leaves a discoverable session file', async () => {
    const gbHome = mkdtempSync(join(tmpdir(), 'gb-pi-hooks-home-'));
    const agentRoot = mkdtempSync(join(tmpdir(), 'gb-pi-hooks-agent-'));
    const cwd = mkdtempSync(join(tmpdir(), 'gb-pi-hooks-cwd-'));
    const savedHome = process.env.GBRAIN_HOME;
    const savedAgent = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.GBRAIN_HOME = gbHome;
      const agentDir = seedPiAgentDir(agentRoot);
      process.env.PI_CODING_AGENT_DIR = agentDir;

      // Install the extension; the brain itself stays empty so this test is
      // about the LIFECYCLE, not retrieval. Binary pinned for the same reason
      // as SMOKE: the heartbeat below is only evidence about THIS branch.
      const code = await runBootstrap(['hooks', '--harness', 'pi', '--gbrain-bin', gbrainBinShim(agentRoot)]);
      expect(code).toBe(0);
      expect(readPiHooksStatus().owned).toBe(true);

      const turn = await piTurn({
        home: gbHome,
        agentDir,
        cwd,
        prompt: 'Reply with exactly: READY',
      });
      expect(turn.exitCode).toBe(0);

      // pi wrote a session file under the hermetic session dir, and the id in
      // its header is the id the extension passed to the hook lane.
      const sessionsDir = join(agentDir, 'sessions');
      const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
      expect(files.length).toBeGreaterThan(0);

      // The heartbeat is the native proof: the extension really ran inside a
      // real pi process and reached a real gbrain. Assert the pi lane recorded
      // the events we bound (session-start + user-prompt) with no transcript
      // refusal — the exact failure mode the lane was written to fix.
      //
      // The path goes through the same resolver the hook child uses: GBRAIN_HOME
      // is a PARENT dir and `.gbrain` is always appended to it.
      const savedHomeForResolve = process.env.GBRAIN_HOME;
      process.env.GBRAIN_HOME = gbHome;
      const hbPath = join(resolveGbrainHome(), 'integrations', 'hooks', 'heartbeat.jsonl');
      if (savedHomeForResolve === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHomeForResolve;
      expect(existsSync(hbPath), `no hook heartbeat at ${hbPath}`).toBe(true);
      const entries = readFileSync(hbPath, 'utf8').split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as { event?: string; outcome?: string; reason?: string; harness?: string; hook_lane?: string });
      const events = entries.map((e) => e.event);
      expect(events).toContain('session-start');
      expect(events).toContain('user-prompt');

      // No transcript refusal: the whole point of the pi confinement root.
      const refused = entries.filter((e) => (e.reason ?? '').startsWith('transcript_'));
      expect(refused, `pi lane refused its own session file: ${JSON.stringify(refused)}`).toEqual([]);
    } finally {
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgent;
      for (const d of [gbHome, agentRoot, cwd]) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }, 300_000);
});