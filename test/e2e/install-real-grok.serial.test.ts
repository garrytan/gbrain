/**
 * install-real-grok door e2e — drives the REAL `grok` binary (xAI Grok Build
 * CLI) against THIS checkout's gbrain over stdio MCP.
 *
 * WHAT THIS PROVES: gbrain WIRED INTO grok via the DOCUMENTED command shape
 * (`grok mcp add gbrain -- gbrain serve --surface verbs`, bare command
 * resolved via a PATH-staged bin dir) + recall through MCP. Every asserted
 * shape was observed against v1.0.4 — see docs/mcp/GROK-CLI-PIN.md; update
 * that file, the heavy-tests grok-door pins, and these assertions together.
 *
 * SPLIT GATING (divergence from the hermes door, deliberate): grok's mcp
 * add/list/doctor all run KEYLESS (observed), so the compat tier needs only
 * the binary — missing auth must not discard it. Two describes:
 *   - keyless tier (T1 version pin, T2 INSTALL, T2b provenance, T3 direct
 *     TOML): GBRAIN_REAL_GROK_E2E=1 + resolvable binary.
 *   - paid tier (T4 SMOKE): additionally hasGrokAuth() (non-empty
 *     XAI_API_KEY; blank CI secret ⇒ skip, never a paid failure).
 *
 * Isolation: every child gets BOTH HOME=<tmp> and GROK_HOME=<tmp>/.grok
 * (GROK_HOME honoring verified v1.0.4), an explicit tmp cwd on EVERY spawn
 * (grok reads vendor MCP configs — ~/.claude.json / project .mcp.json — for
 * trusted folders, and loads .envrc from the cwd by default; fresh tmp HOME +
 * cwd make both structurally inert: vendor entries report "folder untrusted",
 * observed). A bounded tripwire hashes the operator's real ~/.grok
 * config/credential files (NOT the volatile set — grok rewrites
 * active_sessions/logs/bin/docs on every run) before/after, and a checkout
 * guard asserts no .grok/ or .mcp.json appeared in the repo root.
 *
 * Observed-reality notes (docs/mcp/GROK-CLI-PIN.md, v1.0.4):
 *   - `grok mcp add` is LAZY: exit 0 always, no handshake, no prompt;
 *     `enabled = true` is written unconditionally. Neither its exit code nor
 *     the enabled flag proves anything about server viability.
 *   - THE honest discriminator: `grok mcp doctor <name> --json` SPAWNS the
 *     server — exit 0 + checks [command found, server started, handshake OK,
 *     "7 tools discovered"] on success; exit 1 + a failing check on a broken
 *     command. The verbs surface's seven verbs are proven keyless.
 *   - the env flag is repeatable, one KEY=value per flag.
 *   - `[cli] auto_update = false` must be seeded (config-only kill-switch,
 *     default ON); `mcp add` PRESERVES pre-existing config sections.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolveGrokBinary,
  hasGrokAuth,
  seedGrokConfig,
  grokChildEnv,
  grokOneShotTurn,
  hermeticChildEnv,
  stageGbrainBinDir,
  ensureCompiledGbrain,
  seedBrainForAgent,
} from '../helpers/agent-harness.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const GROK_BIN = resolveGrokBinary();
const CAN_RUN_KEYLESS = process.env.GBRAIN_REAL_GROK_E2E === '1' && !!GROK_BIN;
const CAN_RUN_PAID = CAN_RUN_KEYLESS && hasGrokAuth();

if (!CAN_RUN_KEYLESS) {
  const why = process.env.GBRAIN_REAL_GROK_E2E !== '1'
    ? 'GBRAIN_REAL_GROK_E2E is not 1 (explicit opt-in required)'
    : 'grok binary not found';
  console.warn(`[install-real-grok] SKIP (keyless tier): ${why}`);
} else if (!CAN_RUN_PAID) {
  console.warn('[install-real-grok] keyless tier runs; SKIP paid tier: no non-empty XAI_API_KEY');
}

const ENV_KEYS = [
  'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GROK_HOME',
];
const SAVED_ENV: Record<string, string | undefined> = {};

// Bounded tripwire over the operator's REAL ~/.grok: config/credential-class
// files ONLY (grok rewrites active_sessions/logs/bin/docs on every run — a
// whole-tree hash would false-positive on volatile churn, observed v1.0.4).
const REAL_GROK_HOME = join(homedir(), '.grok');
const TRIPWIRE_FILES = ['config.toml', 'mcp_credentials.json'];
let realManifestBefore: string | null = null;
function grokHomeManifest(): string | null {
  try {
    if (!existsSync(REAL_GROK_HOME)) return 'absent';
    const h = createHash('sha256');
    for (const f of TRIPWIRE_FILES) {
      const p = join(REAL_GROK_HOME, f);
      h.update(f);
      h.update(existsSync(p) ? readFileSync(p) : Buffer.from('<absent>'));
    }
    return h.digest('hex');
  } catch { return null; }
}

// Checkout guard: a grok child whose cwd escaped to the repo root would drop
// a .grok/ (project-scope add) or read/write .mcp.json there.
const CHECKOUT_MARKERS = [join(REPO_ROOT, '.grok'), join(REPO_ROOT, '.mcp.json')];
let checkoutMarkersBefore: boolean[] = [];

const EVIDENCE_DIR = process.env.GBRAIN_E2E_EVIDENCE_DIR;
const createdHomes: { label: string; home: string }[] = [];
function trackHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `gb-grok-${label}-`));
  createdHomes.push({ label, home });
  return home;
}
function copyEvidence(): void {
  if (!EVIDENCE_DIR) return;
  for (const { label, home } of createdHomes) {
    try {
      const dst = join(EVIDENCE_DIR, label);
      mkdirSync(dst, { recursive: true });
      // Copy-allowlist per the Phase-0 volatile inventory; the credential
      // inventory is pending auth — mcp_credentials.json is defensively
      // excluded rather than copied.
      for (const sub of ['.grok/logs', '.grok/config.toml', 'door-config.toml']) {
        const src = join(home, sub);
        if (existsSync(src)) {
          try { cpSync(src, join(dst, sub.replace(/\//g, '_')), { recursive: true }); } catch { /* best-effort */ }
        }
      }
      try { rmSync(join(dst, '.grok_mcp_credentials.json'), { force: true }); } catch { /* best-effort */ }
      // Same content-grep the CI scrub applies: a grok-written log that
      // embeds the key must never land in an artifact, local or uploaded.
      const key = process.env.XAI_API_KEY?.trim();
      if (key && key.length >= 8) {
        const walk = (d: string): string[] => {
          try {
            return require('node:fs').readdirSync(d, { withFileTypes: true }).flatMap((e: { name: string; isDirectory(): boolean; isFile(): boolean }) => {
              const p = join(d, e.name);
              return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
            });
          } catch { return []; }
        };
        for (const f of walk(dst)) {
          try {
            if (readFileSync(f, 'utf8').includes(key)) rmSync(f, { force: true });
          } catch { /* unreadable → leave */ }
        }
      }
    } catch { /* best-effort */ }
  }
}

beforeAll(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  realManifestBefore = grokHomeManifest();
  checkoutMarkersBefore = CHECKOUT_MARKERS.map((p) => existsSync(p));
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
  // Tripwires LAST — scream, don't silently mutate the operator's agent.
  const after = grokHomeManifest();
  if (realManifestBefore !== after) {
    throw new Error(
      'HERMETICITY BREACH: the operator\'s real ~/.grok config/credential files changed during ' +
      'the door run — GROK_HOME isolation failed; investigate before trusting this suite again. ' +
      '(Volatile paths are excluded from this manifest; a fire means config.toml or credentials moved.)',
    );
  }
  const markersAfter = CHECKOUT_MARKERS.map((p) => existsSync(p));
  for (let i = 0; i < CHECKOUT_MARKERS.length; i++) {
    if (markersAfter[i] && !checkoutMarkersBefore[i]) {
      throw new Error(`HERMETICITY BREACH: ${CHECKOUT_MARKERS[i]} appeared in the checkout during the door run.`);
    }
  }
});

/** Run the real grok binary under a hermetic home with a REQUIRED tmp cwd
 *  (never the checkout: vendor-config + .envrc channels). `binDir`, when
 *  given, is PATH-prepended so bare `gbrain` resolves to the staged binary —
 *  both for grok's own resolution and for the server it spawns. */
function runGrok(
  home: string,
  cwd: string,
  argv: string[],
  binDir?: string,
): { code: number | null; stdout: string; stderr: string } {
  const env = grokChildEnv(home);
  if (binDir) env.PATH = `${binDir}:${env.PATH ?? ''}`;
  // The bun-run fallback server cold-transpiles the CLI; grok's default
  // startup timeout is 30s (observed schema) — widen via the observed env.
  env.GROK_MCP_STARTUP_TIMEOUT_SECS = '90';
  const res = spawnSync(GROK_BIN!, argv, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Keyless PGLite brain init (compiled binary preferred, bun-run fallback). */
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

interface GrokMcpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  startup_timeout_sec?: number;
}
interface GrokConfig {
  cli?: { auto_update?: boolean };
  mcp_servers?: Record<string, GrokMcpServerEntry>;
}

function readGrokConfig(home: string): GrokConfig {
  const p = join(home, '.grok', 'config.toml');
  expect(existsSync(p)).toBe(true);
  // Bun.TOML.parse — same parser codex-toml.ts uses; zero new deps.
  return (Bun as unknown as { TOML: { parse(s: string): unknown } }).TOML
    .parse(readFileSync(p, 'utf-8')) as GrokConfig;
}

interface DoctorCheck { label: string; passed: boolean; detail?: string; hint?: string }
interface DoctorReport {
  sources?: { path: string; status: { status: string; server_count?: number } }[];
  servers?: { name: string; source?: string; checks?: DoctorCheck[] }[];
}

/** The honest discriminator: doctor SPAWNS the server (observed). */
function doctorProbe(home: string, cwd: string, name: string, binDir?: string): { code: number | null; report: DoctorReport } {
  const res = runGrok(home, cwd, ['mcp', 'doctor', name, '--json'], binDir);
  let report: DoctorReport = {};
  try { report = JSON.parse(res.stdout) as DoctorReport; } catch { /* asserted by callers */ }
  return { code: res.code, report };
}

/** Documented registration shape (GROK.md): bare `gbrain` via staged PATH. */
function registerGbrainIntoGrok(
  home: string,
  cwd: string,
  binDir: string,
  gbrainHome: string,
  sourceId: string,
): { code: number | null; stdout: string; stderr: string } {
  return runGrok(home, cwd, [
    'mcp', 'add', 'gbrain',
    '-e', `GBRAIN_HOME=${gbrainHome}`,
    '-e', `GBRAIN_SOURCE=${sourceId}`,
    '--', 'gbrain', 'serve', '--surface', 'verbs',
  ], binDir);
}

describe.skipIf(!CAN_RUN_KEYLESS)('install real-grok door — keyless tier (serial e2e)', () => {
  test('version pin: grok --version matches GROK_VERSION when the CI pin is set', () => {
    const pinned = process.env.GROK_VERSION;
    const home = trackHome('ver');
    seedGrokConfig(home);
    const res = runGrok(home, home, ['--version']);
    expect(res.code).toBe(0);
    if (pinned) {
      expect(res.stdout).toContain(`grok ${pinned}`);
    } else {
      // Local run without a pin: assert the observed shape — also the
      // discriminator against the colliding community grok-cli binary.
      expect(res.stdout).toMatch(/grok \d+\.\d+\.\d+ \([0-9a-f]+\)/);
    }
  }, 120_000);

  test('INSTALL: keyless init → documented-shape `grok mcp add` → TOML carries server + env → doctor handshakes 7 verbs', () => {
    const home = trackHome('install');
    seedGrokConfig(home);
    const ws = join(home, 'ws');
    mkdirSync(ws, { recursive: true });

    const init = initBrain(home);
    expect(init.code).toBe(0);
    expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(true);

    const binDir = join(home, 'staged-bin');
    const staged = stageGbrainBinDir(REPO_ROOT, binDir);
    console.warn(`[install-real-grok] staged gbrain kind=${staged.kind}`);

    const add = registerGbrainIntoGrok(home, ws, binDir, home, 'default');
    // Add is LAZY (observed): exit 0 proves only that the config was written
    // — a nonexistent command also exits 0. The handshake proof is doctor.
    expect(add.code).toBe(0);

    const cfg = readGrokConfig(home);
    try { cpSync(join(home, '.grok', 'config.toml'), join(home, 'door-config.toml')); } catch { /* evidence */ }
    expect(cfg.mcp_servers?.gbrain).toBeDefined();
    expect(cfg.mcp_servers!.gbrain.command).toBe('gbrain');
    expect(cfg.mcp_servers!.gbrain.args).toEqual(['serve', '--surface', 'verbs']);
    expect(cfg.mcp_servers!.gbrain.env?.GBRAIN_HOME).toBe(home);
    expect(cfg.mcp_servers!.gbrain.env?.GBRAIN_SOURCE).toBe('default');
    // Seeded kill-switch survived registration (observed: add preserves
    // pre-existing sections).
    expect(cfg.cli?.auto_update).toBe(false);

    const { code, report } = doctorProbe(home, ws, 'gbrain', binDir);
    expect(code).toBe(0);
    const checks = report.servers?.find((s) => s.name === 'gbrain')?.checks ?? [];
    expect(checks.every((c) => c.passed)).toBe(true);
    expect(checks.some((c) => /handshake OK/i.test(c.label))).toBe(true);
    // The verbs surface end-to-end, keyless: seven verbs discovered.
    expect(checks.some((c) => /7 tools discovered/i.test(c.label))).toBe(true);

    // Soft probe (exit-0-only; shape logged, not asserted).
    const list = runGrok(home, ws, ['mcp', 'list', '--json'], binDir);
    expect(list.code).toBe(0);
    if (!list.stdout.includes('gbrain')) {
      console.warn('[install-real-grok] mcp list --json did not mention gbrain — shape drift? output:', list.stdout.slice(0, 400));
    }
  }, 420_000);

  test('INSTALL 2b: provenance — the entry is grok-native and vendor fallback is structurally inert here', () => {
    const home = trackHome('prov');
    seedGrokConfig(home);
    const ws = join(home, 'ws');
    mkdirSync(ws, { recursive: true });

    const binDir = join(home, 'staged-bin');
    stageGbrainBinDir(REPO_ROOT, binDir);
    const init = initBrain(home);
    expect(init.code).toBe(0);
    registerGbrainIntoGrok(home, ws, binDir, home, 'default');

    // Decoy vendor entry in the fresh cwd: grok SEES it but must not
    // activate it — fresh home ⇒ folder untrusted (observed).
    writeFileSync(join(ws, '.mcp.json'), JSON.stringify({
      mcpServers: { 'gbrain-vendor-decoy': { command: join(binDir, 'gbrain'), args: ['serve'] } },
    }), 'utf-8');

    const { code, report } = doctorProbe(home, ws, 'gbrain', binDir);
    expect(code).toBe(0);
    const gbrain = report.servers?.find((s) => s.name === 'gbrain');
    expect(gbrain?.source).toBe('config'); // grok-native, not a vendor pickup
    const decoy = report.servers?.find((s) => s.name === 'gbrain-vendor-decoy');
    if (decoy) {
      // When doctor reports the decoy at all, it must be inert (untrusted).
      expect(decoy.checks?.some((c) => /untrusted/i.test(c.label))).toBe(true);
    }
  }, 420_000);

  test('INSTALL 3: the direct config.toml surface (documented, not a fallback) is accepted independently', () => {
    const home = trackHome('toml');
    const ws = join(home, 'ws');
    mkdirSync(ws, { recursive: true });

    const init = initBrain(home);
    expect(init.code).toBe(0);

    const binDir = join(home, 'staged-bin');
    stageGbrainBinDir(REPO_ROOT, binDir);

    // Full document (not just the server block): the kill-switch and the
    // observed schema keys, startup_timeout_sec=60 for the bun-run
    // cold-transpile flake. Parse-validated before write (Bun.TOML has no
    // stringify — the literal IS the surface users hand-write).
    const doc = [
      '[cli]',
      'auto_update = false',
      '',
      '[mcp_servers.gbrain]',
      'command = "gbrain"',
      'args = ["serve", "--surface", "verbs"]',
      'startup_timeout_sec = 60',
      'enabled = true',
      '',
      '[mcp_servers.gbrain.env]',
      `GBRAIN_HOME = "${home}"`,
      'GBRAIN_SOURCE = "default"',
      '',
    ].join('\n');
    expect(() => (Bun as unknown as { TOML: { parse(s: string): unknown } }).TOML.parse(doc)).not.toThrow();
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(join(home, '.grok', 'config.toml'), doc, 'utf-8');

    const { code, report } = doctorProbe(home, ws, 'gbrain', binDir);
    expect(code).toBe(0);
    const checks = report.servers?.find((s) => s.name === 'gbrain')?.checks ?? [];
    expect(checks.some((c) => /handshake OK/i.test(c.label))).toBe(true);

    // Config-preservation pin: a subsequent CLI add must not clobber the
    // hand-written sections (observed; the eng review predicted the clobber).
    const add2 = runGrok(home, ws, ['mcp', 'add', 'second', '-e', 'A=1', '--', join(binDir, 'gbrain'), 'serve'], binDir);
    expect(add2.code).toBe(0);
    const cfg = readGrokConfig(home);
    expect(cfg.cli?.auto_update).toBe(false);
    expect(cfg.mcp_servers?.gbrain?.startup_timeout_sec).toBe(60);
  }, 420_000);
});

describe.skipIf(!CAN_RUN_PAID)('install real-grok door — paid tier (serial e2e)', () => {
  test('SMOKE: real grok -p answers the per-run nonce fact through the gbrain MCP server', async () => {
    const home = trackHome('smoke');
    const ws = join(home, 'ws');
    mkdirSync(ws, { recursive: true });

    // PER-RUN nonce fact (never the committed Summit/Rivermouth string): grok
    // has filesystem/shell tools, so recall of a string that is greppable in
    // ANY reachable file proves nothing. The nonce exists only in the
    // hermetic brain — which lives under this same hermetic HOME, so an agent
    // that greps $HOME/.gbrain could still surface it without MCP; web search
    // is flag-disabled, fs/shell are prompt-forbidden only. The planned
    // streaming-json toolCall assertion (pending the authed observation) is
    // what upgrades this to proof of tool mediation.
    const nonce = `kestrel-${randomBytes(4).toString('hex')}`;
    const seeded = await seedBrainForAgent(home, 'workspace', {
      entity: 'Kestrel Logistics',
      fact: `The Kestrel Logistics staging depot is codenamed ${nonce}.`,
      query: 'What is the codename of the Kestrel Logistics staging depot?',
      slug: 'companies/kestrel-logistics',
    });
    seedGrokConfig(home);

    const binDir = join(home, 'staged-bin');
    stageGbrainBinDir(REPO_ROOT, binDir);
    registerGbrainIntoGrok(home, ws, binDir, home, 'workspace');

    // Doctor pre-flight — the observed-honest discriminator gates the paid
    // loop: never enter a paid attempt on a broken registration.
    const pre = doctorProbe(home, ws, 'gbrain', binDir);
    if (pre.code !== 0) {
      console.error('[install-real-grok] doctor pre-flight failed; not spending a paid attempt:',
        JSON.stringify(pre.report).slice(0, 600));
    }
    expect(pre.code).toBe(0);

    const prompt =
      'You have an MCP server named gbrain connected to a knowledge brain. ' +
      `Using ONLY that brain (no general knowledge, no web search, no filesystem or shell tools), answer: ${seeded.query} ` +
      'Report exactly what the brain says. If no gbrain tool is available to you, reply with exactly: NO-GBRAIN-TOOL';

    let finalText = '';
    let lastExit: number | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const turn = await grokOneShotTurn({
        prompt,
        cwd: ws,
        home,
        timeoutMs: 240_000,
        disableWebSearch: true,
        // The MCP registration is the DOCUMENTED bare `gbrain` — the turn's
        // own child env must resolve it too, or grok can't start the server
        // mid-turn on a clean runner (doctor passing is not enough).
        binDir,
      });
      finalText = turn.finalText;
      lastExit = turn.exitCode;
      if (turn.exitCode === 0 && finalText.toLowerCase().includes(nonce)) break;
      console.warn(`[install-real-grok] SMOKE attempt ${attempt}: exit=${turn.exitCode} text=${finalText.slice(0, 200)} stderr=${turn.stderrText.slice(0, 200)}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3_000));
    }

    // Never-soften criteria: the nonce surfaced AND the no-tool control
    // token did not.
    expect(lastExit).toBe(0);
    expect(finalText.toLowerCase()).toContain(nonce);
    expect(finalText).not.toContain('NO-GBRAIN-TOOL');

    // NOTE (pending observation, GROK-CLI-PIN.md): the JSON event-stream
    // shapes are unobserved keyless. Once the first authed run pins the
    // streaming-json tool-call event shape, add the separate non-retried
    // toolCall test here (one extra paid turn) and a parseGrokJson helper
    // with fixtures.
  }, 600_000);
});
