/**
 * install-real-hermes door e2e — drives the REAL `hermes` binary (NousResearch
 * hermes-agent) against THIS checkout's gbrain over stdio MCP.
 *
 * WHAT THIS PROVES: gbrain WIRED INTO hermes + recall through MCP, using the
 * dev tree / compiled binary — the same posture as the claude/codex doors.
 * It does NOT prove (a) gbrain's own cold install (bun global install, PATH,
 * migrations — that's the networkless-container placeholder in
 * heavy-tests.yml), nor (b) an agent FOLLOWING INSTALL_FOR_AGENTS.md
 * end-to-end (guide-following is the claw-test live lane's job).
 *
 * GATING (fail-SKIP, never fail-hard): requires ALL of
 *   - GBRAIN_REAL_HERMES_E2E=1  — explicit opt-in. This file matches the
 *     ordinary test/e2e glob, and unlike the claude/codex doors (whose auth
 *     probes die with a redirected HOME) an env-key auth gate alone would fire
 *     paid multi-minute turns on any dev box with hermes + a key. CI's
 *     hermes-door job and provisioned boxes set the var deliberately;
 *     run-e2e.sh scrubs GBRAIN_* so this suite structurally cannot fire there.
 *   - a resolvable hermes binary
 *   - hermes auth with a NON-EMPTY provider key (blank CI secret ⇒ skip)
 *
 * Isolation: every child gets BOTH HOME=<tmp> and HERMES_HOME=<tmp>/.hermes
 * (HERMES_HOME honoring verified against v0.20.0; the double-set covers either
 * derivation). A tripwire hashes the operator's real ~/.hermes/config.yaml
 * before/after — if isolation ever breaks, the suite fails loudly instead of
 * silently mutating the operator's agent.
 *
 * Observed-reality notes (B0, docs/mcp/HERMES-CLI-PIN.md, v0.20.0):
 *   - `hermes mcp add` does a REAL MCP handshake + tool discovery at add time,
 *     then prompts to enable tools; a piped "Y" answers it non-interactively.
 *     Its EXIT CODE IS 0 EVEN ON FAILURE/CANCEL — and a piped "Y" saves the
 *     entry EVEN when the handshake failed (the save-anyway prompt), just with
 *     `enabled: false`. So the hard success discriminators are
 *     (1) `mcp_servers.gbrain.enabled === true` in config.yaml (only a
 *     successful handshake enables) and (2) `hermes mcp test gbrain` exits 0.
 *   - the args flag must be the LAST option (later options are swallowed into
 *     the server argv).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';

import {
  resolveHermesBinary,
  hasHermesAuth,
  seedHermesHome,
  pinHermesModel,
  hermesOneShotTurn,
  hermeticChildEnv,
  hermesChildEnv,
  resolveGbrainServerCommand,
  ensureCompiledGbrain,
  seedBrainForAgent,
} from '../helpers/agent-harness.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const HERMES_BIN = resolveHermesBinary();
const CAN_RUN = process.env.GBRAIN_REAL_HERMES_E2E === '1' && !!HERMES_BIN && hasHermesAuth();

if (!CAN_RUN) {
  const why = process.env.GBRAIN_REAL_HERMES_E2E !== '1'
    ? 'GBRAIN_REAL_HERMES_E2E is not 1 (explicit opt-in required — paid agent turns)'
    : !HERMES_BIN
      ? 'hermes binary not found'
      : 'no non-empty hermes provider key (env or ~/.hermes/.env)';
  console.warn(`[install-real-hermes] SKIP: ${why}`);
}

const ENV_KEYS = [
  'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'HERMES_HOME',
];
const SAVED_ENV: Record<string, string | undefined> = {};

// Tripwire over the operator's REAL hermes config: hash before, compare after.
const REAL_HERMES_CONFIG = join(homedir(), '.hermes', 'config.yaml');
let realConfigHashBefore: string | null = null;
function hashFile(p: string): string | null {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; }
}

// Evidence trail: homes created during the run get copied (minus .env) into
// GBRAIN_E2E_EVIDENCE_DIR when set. The CI workflow uploads that stable path
// on failure; copying unconditionally is fine (upload is failure-gated) and
// avoids per-test failure plumbing.
const EVIDENCE_DIR = process.env.GBRAIN_E2E_EVIDENCE_DIR;
const createdHomes: { label: string; home: string }[] = [];
function trackHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `gb-hermes-${label}-`));
  createdHomes.push({ label, home });
  return home;
}
function copyEvidence(): void {
  if (!EVIDENCE_DIR) return;
  for (const { label, home } of createdHomes) {
    try {
      const dst = join(EVIDENCE_DIR, label);
      mkdirSync(dst, { recursive: true });
      for (const sub of ['.hermes/logs', '.hermes/sessions', 'usage.json', 'door-config.yaml']) {
        const src = join(home, sub);
        if (existsSync(src)) {
          try { cpSync(src, join(dst, sub.replace(/\//g, '_')), { recursive: true }); } catch { /* best-effort */ }
        }
      }
      // Defensive: never let a provider key land in the artifact.
      try { rmSync(join(dst, '.env'), { force: true }); } catch { /* best-effort */ }
    } catch { /* best-effort */ }
  }
}

beforeAll(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  realConfigHashBefore = hashFile(REAL_HERMES_CONFIG);
});

afterAll(() => {
  copyEvidence();
  for (const { home } of createdHomes) {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  // Tripwire LAST: if any child escaped the hermetic HERMES_HOME, the
  // operator's real config changed and this run must scream about it.
  const after = hashFile(REAL_HERMES_CONFIG);
  if (realConfigHashBefore !== after) {
    throw new Error(
      'HERMETICITY BREACH: the operator\'s real ~/.hermes/config.yaml changed during the door run — ' +
      'HERMES_HOME isolation failed; investigate before trusting this suite again.',
    );
  }
});

/** Run the real hermes binary under a hermetic home. `stdinText` answers
 *  interactive prompts (the enable-tools "Y"). All provider keys are scrubbed
 *  from the child env (hermesChildEnv) — the seeded .env is the single auth
 *  source; a stray second provider key mis-routes hermes's provider-auto
 *  (observed "HTTP 401: Missing Authentication header"). */
function runHermes(home: string, argv: string[], stdinText?: string): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync(HERMES_BIN!, argv, {
    env: hermesChildEnv(home),
    encoding: 'utf8',
    timeout: 180_000,
    input: stdinText,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Keyless PGLite brain init via the preferred launcher (compiled binary when
 *  the PGLite-embed probe passes, matching resolveGbrainServerCommand's
 *  preference; bun-run fallback otherwise). */
function initBrain(home: string): { code: number | null; stderr: string } {
  const { binPath } = ensureCompiledGbrain(REPO_ROOT);
  const argv = binPath
    ? [binPath, 'init', '--pglite', '--no-embedding', '--non-interactive']
    : ['bun', 'run', CLI, 'init', '--pglite', '--no-embedding', '--non-interactive'];
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: REPO_ROOT,
    env: hermeticChildEnv({ HOME: home, GBRAIN_HOME: home, GBRAIN_SKIP_STARTUP_HOOKS: '1' }),
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { code: res.status, stderr: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
}

interface HermesMcpConfig {
  mcp_servers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }>;
}

function readHermesConfig(home: string): HermesMcpConfig {
  const p = join(home, '.hermes', 'config.yaml');
  expect(existsSync(p)).toBe(true);
  return (yaml.safeLoad(readFileSync(p, 'utf-8')) ?? {}) as HermesMcpConfig;
}

/** Shared registration: real `hermes mcp add` with the piped-Y confirmation.
 *  Observed gotchas (door run + isolation, v0.20.0):
 *  - the env flag takes MULTIPLE KEY=VALUE values after ONE flag; REPEATING
 *    the flag replaces the first occurrence (argparse), which drops
 *    GBRAIN_HOME, kills the server handshake, and the piped Y then answers
 *    the save-anyway prompt as enabled:false — a silently-disabled entry.
 *  - the args flag must be the LAST option (later options are swallowed
 *    into the server argv). */
function registerGbrainIntoHermes(
  home: string,
  server: { command: string; args: string[] },
  sourceId: string,
): { code: number | null; stdout: string; stderr: string } {
  return runHermes(home, [
    'mcp', 'add', 'gbrain',
    '--env', `GBRAIN_HOME=${home}`, `GBRAIN_SOURCE=${sourceId}`,
    '--connect-timeout', '60',
    '--command', server.command,
    '--args', ...server.args,
  ], 'Y\n');
}

describe.skipIf(!CAN_RUN)('install real-hermes door (serial e2e)', () => {
  test('version pin: hermes --version matches HERMES_VERSION when the CI pin is set', () => {
    const pinned = SAVED_ENV.HERMES_VERSION ?? process.env.HERMES_VERSION;
    const res = runHermes(trackHome('ver'), ['--version']);
    expect(res.code).toBe(0);
    if (pinned) {
      expect(res.stdout).toContain(`v${pinned}`);
    } else {
      // Local run without a pin: still assert the observed output shape.
      expect(res.stdout).toMatch(/Hermes Agent v\d+\.\d+\.\d+/);
    }
  }, 120_000);

  test('INSTALL: keyless init → real `hermes mcp add` handshake → config carries server + env → mcp test passes', () => {
    const home = trackHome('install');
    seedHermesHome(home);

    const init = initBrain(home);
    expect(init.code).toBe(0);
    expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(true);

    const server = resolveGbrainServerCommand(REPO_ROOT);
    const add = registerGbrainIntoHermes(home, server, 'default');
    // Deliberately NO assertion on add.code: observed 0 even on failure — and
    // the piped Y saves even a FAILED handshake (as enabled:false via the
    // save-anyway prompt). The handshake success is asserted via
    // enabled===true below plus the independent mcp test probe…
    expect(add.stdout).toContain('tool(s)'); // discovery banner fired
    const cfg = readHermesConfig(home);
    try { cpSync(join(home, '.hermes', 'config.yaml'), join(home, 'door-config.yaml')); } catch { /* evidence */ }
    expect(cfg.mcp_servers?.gbrain).toBeDefined();
    expect(cfg.mcp_servers!.gbrain.command).toBe(server.command);
    expect(cfg.mcp_servers!.gbrain.args).toEqual(server.args);
    expect(cfg.mcp_servers!.gbrain.env?.GBRAIN_HOME).toBe(home);
    expect(cfg.mcp_servers!.gbrain.env?.GBRAIN_SOURCE).toBe('default');
    expect(cfg.mcp_servers!.gbrain.enabled).toBe(true);

    // …and a second, independent connection: `hermes mcp test` re-spawns the
    // server and lists tools (observed exit 0 + tool list).
    const probe = runHermes(home, ['mcp', 'test', 'gbrain']);
    expect(probe.code).toBe(0);

    // Soft probe (exit-0-only; output shape logged, not asserted).
    const list = runHermes(home, ['mcp', 'list']);
    expect(list.code).toBe(0);
    if (!list.stdout.includes('gbrain')) {
      console.warn('[install-real-hermes] mcp list output did not mention gbrain — shape drift? output:', list.stdout.slice(0, 400));
    }
  }, 300_000);

  test('INSTALL 1b: the direct config.yaml surface (documented, not a fallback) is accepted independently', () => {
    const home = trackHome('yaml');
    seedHermesHome(home);

    const init = initBrain(home);
    expect(init.code).toBe(0);

    const server = resolveGbrainServerCommand(REPO_ROOT);
    const configPath = join(home, '.hermes', 'config.yaml');
    const doc = {
      mcp_servers: {
        gbrain: {
          command: server.command,
          args: server.args,
          env: { GBRAIN_HOME: home, GBRAIN_SOURCE: 'default' },
          connect_timeout: 60,
          enabled: true,
        },
      },
    };
    writeFileSync(configPath, yaml.safeDump(doc), 'utf-8');

    // Targeted probe, asserted HARD (eng D3): `mcp test` connects to exactly
    // the entry under test. Global `doctor` is NOT asserted here — it
    // diagnoses hermes-wide health and can fail a hermetic home for reasons
    // unrelated to our entry; run it as logged evidence only.
    const probe = runHermes(home, ['mcp', 'test', 'gbrain']);
    expect(probe.code).toBe(0);
    expect(probe.stdout.length).toBeGreaterThan(0);

    const doctor = runHermes(home, ['doctor']);
    console.warn(`[install-real-hermes] doctor (evidence only): exit ${doctor.code}`);
  }, 300_000);

  test('SMOKE: real hermes -z answers the seeded fact through the gbrain MCP server', async () => {
    const home = trackHome('smoke');
    const seeded = await seedBrainForAgent(home, 'workspace');
    seedHermesHome(home);
    const pin = pinHermesModel(HERMES_BIN!, home);
    expect(pin.code).toBe(0);

    const server = resolveGbrainServerCommand(REPO_ROOT);
    registerGbrainIntoHermes(home, server, 'workspace');
    const cfg = readHermesConfig(home);
    expect(cfg.mcp_servers?.gbrain?.enabled).toBe(true);

    // Negative-control channel: hermes's one-shot prints only final text (no
    // tool-call stream to parse), so the prompt makes tool-absence loudly
    // detectable. The fact is 100% synthetic and the turn's cwd is the TEMP
    // HOME — never the repo checkout, where the committed fact in
    // agent-harness.ts would be greppable without MCP.
    const prompt =
      'You have an MCP server named gbrain connected to a knowledge brain. ' +
      `Using ONLY that brain (no general knowledge, no filesystem search), answer: ${seeded.query} ` +
      'Report exactly what the brain says. If no gbrain tool is available to you, reply with exactly: NO-GBRAIN-TOOL';

    let finalText = '';
    let lastExit: number | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const turn = await hermesOneShotTurn({
        prompt,
        cwd: home,
        home,
        timeoutMs: 240_000,
        usageFile: join(home, 'usage.json'),
      });
      finalText = turn.finalText;
      lastExit = turn.exitCode;
      if (turn.exitCode === 0 && finalText.toLowerCase().includes('rivermouth')) break;
      console.warn(`[install-real-hermes] SMOKE attempt ${attempt}: exit=${turn.exitCode} text=${finalText.slice(0, 200)}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3_000));
    }

    // Never-soften criteria: the synthetic fact surfaced AND the no-tool
    // control token did not.
    expect(lastExit).toBe(0);
    expect(finalText.toLowerCase()).toContain('rivermouth');
    expect(finalText).not.toContain('NO-GBRAIN-TOOL');

    // Best-effort evidence sweep (logged, not asserted — first provisioned
    // run tells us whether session artifacts are promotable to hard asserts).
    try {
      const usage = JSON.parse(readFileSync(join(home, 'usage.json'), 'utf-8'));
      console.warn('[install-real-hermes] usage:', JSON.stringify(usage).slice(0, 300));
    } catch { /* absent — fine */ }
  }, 480_000);
});
