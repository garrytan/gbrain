/**
 * install-real-opencode door e2e — drives the REAL `opencode` binary (SST,
 * opencode.ai) against THIS checkout's gbrain over stdio MCP.
 *
 * WHAT THIS PROVES: gbrain WIRED INTO opencode via the DOCUMENTED command
 * shape (`opencode mcp add gbrain --env … -- gbrain serve --surface verbs`,
 * bare command resolved via a PATH-staged bin dir), the direct-JSONC-writer
 * parity lane (gbrain's own opencode-json.ts output handshakes through the
 * real binary), and recall through MCP. Every asserted shape was observed
 * against v1.18.18 — see docs/mcp/OPENCODE-CLI-PIN.md; update that file, the
 * heavy-tests opencode-door pins, and these assertions together.
 *
 * SPLIT GATING (a step beyond the grok door, deliberate): opencode's
 * anonymous FREE TIER answers headless runs AND drives MCP tool calls with
 * zero credentials (observed — load-bearing), so even the nonce SMOKE runs
 * keyless. Two describes:
 *   - keyless tier (T1 version pin, T2 INSTALL + list handshake, T2b
 *     spawn-gate canary, T3 writer parity + preservation, T4 free-tier
 *     SMOKE): GBRAIN_REAL_OPENCODE_E2E=1 + resolvable binary.
 *   - paid tier (T5 anthropic leg): additionally hasOpencodeAuth()
 *     (non-empty ANTHROPIC_API_KEY; blank CI secret ⇒ skip, never a paid
 *     failure). Self-validating: the authed `opencode models` list must
 *     carry the pinned model id BEFORE any spend.
 *
 * Isolation: every child gets HOME=<tmp> + XDG_CONFIG_HOME + XDG_DATA_HOME
 * under the tmp home (full XDG honoring verified on macOS) and an explicit
 * tmp cwd on EVERY spawn (a project opencode.json in the cwd spawns its
 * local servers with NO trust gate — observed; fresh cwds keep that channel
 * ours to control). A bounded tripwire hashes the operator's real
 * ~/.config/opencode configs + ~/.local/share/opencode/auth.json
 * before/after (NOT the volatile set — the opencode.db family plus the log
 * and repos dirs churn every run), and a checkout guard asserts no
 * opencode.json or .opencode/ appeared in the repo root.
 *
 * Observed-reality notes (docs/mcp/OPENCODE-CLI-PIN.md, v1.18.18):
 *   - `opencode mcp add` is LAZY (exit 0, no spawn, even for a nonexistent
 *     command) and ALWAYS writes the user-global opencode.jsonc.
 *   - THE honest discriminator: `opencode mcp list` SPAWNS every configured
 *     server — `✓ <name> connected` / `✗ <name> failed` per server — but
 *     exits 0 REGARDLESS; the text is the assertion surface, never $?.
 *     `mcp debug` is OAuth-only diagnostics (NOT a handshake probe).
 *   - `--format json` events: {type, timestamp, sessionID, part} with
 *     part.text (text) / part.tool + part.state (tool_use) —
 *     parseOpencodeJsonl pins these; the SMOKE asserts tool mediation
 *     STRUCTURALLY (a gbrain_* tool_use event), not just the nonce.
 *   - autoupdate double kill: `"autoupdate": false` seed + the env var.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolveOpencodeBinary,
  hasOpencodeAuth,
  seedOpencodeConfig,
  opencodeChildEnv,
  opencodeOneShotTurn,
  parseOpencodeJsonl,
  hermeticChildEnv,
  stageGbrainBinDir,
  ensureCompiledGbrain,
  seedBrainForAgent,
} from '../helpers/agent-harness.ts';
import { writeOpencodeMcpEntry, parseOpencodeConfig } from '../../src/core/bootstrap/opencode-json.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const OPENCODE_BIN = resolveOpencodeBinary();
const CAN_RUN_KEYLESS = process.env.GBRAIN_REAL_OPENCODE_E2E === '1' && !!OPENCODE_BIN;
const CAN_RUN_PAID = CAN_RUN_KEYLESS && hasOpencodeAuth();

/** Pinned anthropic model for the paid leg (provider/model, models.dev
 *  convention). PROVISIONAL until the authed models list confirms it — the
 *  T5 models-gate asserts presence BEFORE any spend and names the fix. */
const PAID_MODEL = 'anthropic/claude-haiku-4-5';

if (!CAN_RUN_KEYLESS) {
  const why = process.env.GBRAIN_REAL_OPENCODE_E2E !== '1'
    ? 'GBRAIN_REAL_OPENCODE_E2E is not 1 (explicit opt-in required)'
    : 'opencode binary not found';
  console.warn(`[install-real-opencode] SKIP (keyless tier): ${why}`);
} else if (!CAN_RUN_PAID) {
  console.warn('[install-real-opencode] keyless tier runs; SKIP paid tier: no non-empty ANTHROPIC_API_KEY');
}

const ENV_KEYS = [
  'GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID',
  'GBRAIN_SOURCE', 'GBRAIN_HOOKS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
];
const SAVED_ENV: Record<string, string | undefined> = {};

// Bounded tripwire over the operator's REAL opencode state: config +
// credential files ONLY (opencode.db*/log/repos churn on every run —
// volatile inventory per OPENCODE-CLI-PIN.md §Path seams).
const REAL_OC_CONFIG_DIR = join(homedir(), '.config', 'opencode');
const REAL_OC_AUTH = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
const TRIPWIRE_FILES = [
  join(REAL_OC_CONFIG_DIR, 'opencode.json'),
  join(REAL_OC_CONFIG_DIR, 'opencode.jsonc'),
  REAL_OC_AUTH,
];
let realManifestBefore: string | null = null;
function opencodeStateManifest(): string | null {
  try {
    const h = createHash('sha256');
    for (const p of TRIPWIRE_FILES) {
      h.update(p);
      h.update(existsSync(p) ? readFileSync(p) : Buffer.from('<absent>'));
    }
    return h.digest('hex');
  } catch { return null; }
}

// Checkout guard: an opencode child whose cwd escaped to the repo root would
// read (and a registration bug could write) a project opencode.json there.
const CHECKOUT_MARKERS = [join(REPO_ROOT, 'opencode.json'), join(REPO_ROOT, '.opencode')];
let checkoutMarkersBefore: boolean[] = [];

const EVIDENCE_DIR = process.env.GBRAIN_E2E_EVIDENCE_DIR;
const createdHomes: { label: string; home: string }[] = [];
function trackHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `gb-opencode-${label}-`));
  createdHomes.push({ label, home });
  return home;
}
function copyEvidence(): void {
  if (!EVIDENCE_DIR) return;
  for (const { label, home } of createdHomes) {
    try {
      const dst = join(EVIDENCE_DIR, label);
      mkdirSync(dst, { recursive: true });
      // Copy-allowlist: configs + door transcripts only. auth.json is
      // defensively excluded (the paid leg is env-only, but a future login
      // flow must never land credentials in an artifact).
      for (const sub of ['.config/opencode/opencode.json', '.config/opencode/opencode.jsonc', 'door-turn.jsonl']) {
        const src = join(home, sub);
        if (existsSync(src)) {
          try { cpSync(src, join(dst, sub.replace(/\//g, '_')), { recursive: true }); } catch { /* best-effort */ }
        }
      }
      // Same content-grep the CI scrub applies: an opencode-written file
      // that embeds the key must never land in an artifact.
      const key = process.env.ANTHROPIC_API_KEY?.trim();
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
  realManifestBefore = opencodeStateManifest();
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
  const after = opencodeStateManifest();
  if (realManifestBefore !== after) {
    throw new Error(
      "HERMETICITY BREACH: the operator's real opencode config/credential files changed during " +
      'the door run — XDG isolation failed; investigate before trusting this suite again. ' +
      '(Volatile paths are excluded from this manifest; a fire means a config or auth.json moved.)',
    );
  }
  const markersAfter = CHECKOUT_MARKERS.map((p) => existsSync(p));
  for (let i = 0; i < CHECKOUT_MARKERS.length; i++) {
    if (markersAfter[i] && !checkoutMarkersBefore[i]) {
      throw new Error(`HERMETICITY BREACH: ${CHECKOUT_MARKERS[i]} appeared in the checkout during the door run.`);
    }
  }
});

/** Strip ANSI + clack UI glyphs so text assertions see plain content
 *  (`mcp list` output is a styled tree — observed). */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

/** Run the real opencode binary under a hermetic home with a REQUIRED tmp
 *  cwd (never the checkout: the project-config channel). `--pure` on every
 *  non-turn spawn: `mcp list` autoloads external plugins otherwise (it is a
 *  code-execution surface — OPENCODE-CLI-PIN.md §Probes). */
function runOpencode(
  home: string,
  cwd: string,
  argv: string[],
  binDir?: string,
): { code: number | null; stdout: string; stderr: string } {
  // `--pure` must land on OPENCODE's argv, never inside a `--`-delimited
  // server command (a trailing append after `mcp add … -- gbrain serve`
  // registers `--pure` as a gbrain flag — caught live).
  const sep = argv.indexOf('--');
  const withPure = sep === -1 ? [...argv, '--pure'] : [...argv.slice(0, sep), '--pure', ...argv.slice(sep)];
  const res = spawnSync(OPENCODE_BIN!, withPure, {
    cwd,
    env: opencodeChildEnv(home, binDir ? { binDir } : undefined),
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

/** Documented registration shape (OPENCODE.md): bare `gbrain` via staged
 *  PATH; `--env` repeatable; the `-- command` form (real but absent from
 *  --help — observed). */
function registerGbrainIntoOpencode(
  home: string,
  cwd: string,
  binDir: string,
  gbrainHome: string,
  sourceId: string,
): { code: number | null; stdout: string; stderr: string } {
  return runOpencode(home, cwd, [
    'mcp', 'add', 'gbrain',
    '--env', `GBRAIN_HOME=${gbrainHome}`,
    '--env', `GBRAIN_SOURCE=${sourceId}`,
    '--', 'gbrain', 'serve', '--surface', 'verbs',
  ], binDir);
}

/** THE honest discriminator: `mcp list` spawns every server; parse the text
 *  (exit 0 even on failure — observed). */
function listProbe(home: string, cwd: string, binDir?: string): { code: number | null; text: string } {
  const res = runOpencode(home, cwd, ['mcp', 'list'], binDir);
  return { code: res.code, text: plain(`${res.stdout}\n${res.stderr}`) };
}

function readGlobalConfig(home: string): Record<string, unknown> {
  const dir = join(home, '.config', 'opencode');
  for (const f of ['opencode.jsonc', 'opencode.json']) {
    const p = join(dir, f);
    if (existsSync(p)) return parseOpencodeConfig(readFileSync(p, 'utf-8'), p);
  }
  throw new Error(`no opencode config found under ${dir}`);
}

describe.skipIf(!CAN_RUN_KEYLESS)('install real-opencode door — keyless tier (serial e2e)', () => {
  test('T1 version pin: bare semver; matches OPENCODE_VERSION when the CI pin is set', () => {
    const pinned = process.env.OPENCODE_VERSION;
    const home = trackHome('ver');
    seedOpencodeConfig(home);
    const res = runOpencode(home, home, ['--version']);
    expect(res.code).toBe(0);
    const version = res.stdout.trim();
    // BARE semver — no binary name, no build hash (the SST-vs-claimant
    // discriminator: colliding `opencode` binaries answer differently).
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    if (pinned) expect(version).toBe(pinned);
  }, 120_000);

  test('T2 INSTALL: keyless init → documented-shape `opencode mcp add` → JSONC carries entry + env → `mcp list` handshakes ✓ connected', () => {
    const home = trackHome('install');
    seedOpencodeConfig(home);
    const ws = join(home, 'ws');
    mkdirSync(ws, { recursive: true });

    const init = initBrain(home);
    expect(init.code).toBe(0);
    expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(true);

    const binDir = join(home, 'staged-bin');
    const staged = stageGbrainBinDir(REPO_ROOT, binDir);
    console.warn(`[install-real-opencode] staged gbrain kind=${staged.kind}`);

    const add = registerGbrainIntoOpencode(home, ws, binDir, home, 'default');
    // Add is LAZY (observed): exit 0 proves only that the config was
    // written. The handshake proof is `mcp list` below.
    expect(add.code).toBe(0);

    const cfg = readGlobalConfig(home);
    const mcp = cfg.mcp as Record<string, { type?: string; command?: string[]; environment?: Record<string, string> }>;
    expect(mcp.gbrain).toBeDefined();
    expect(mcp.gbrain.type).toBe('local');
    expect(mcp.gbrain.command).toEqual(['gbrain', 'serve', '--surface', 'verbs']);
    expect(mcp.gbrain.environment?.GBRAIN_HOME).toBe(home);
    expect(mcp.gbrain.environment?.GBRAIN_SOURCE).toBe('default');
    // Seeded kill-switch survived registration (observed: add rewrites via a
    // comment/key-preserving editor).
    expect(cfg.autoupdate).toBe(false);

    const probe = listProbe(home, ws, binDir);
    expect(probe.code).toBe(0);
    expect(probe.text).toMatch(/✓\s+gbrain\s+connected/);
    expect(probe.text).not.toMatch(/✗\s+gbrain/);
  }, 300_000);

  test('T2b spawn-gate canary: a PROJECT-config local server is spawn-attempted with NO trust prompt (the scope-inversion fact)', () => {
    const home = trackHome('gate');
    seedOpencodeConfig(home);
    const ws = join(home, 'ws');
    mkdirSync(ws, { recursive: true });
    // Project-scope decoy with a nonexistent command: if opencode still has
    // no trust gate (observed 1.18.18), `mcp list` ATTEMPTS the spawn and
    // reports ✗ failed. If this ever flips to a gated/untrusted state,
    // gbrain's user-global-default rationale changed — re-observe and
    // revisit the bootstrap scope default (OPENCODE-CLI-PIN.md §Probes).
    writeFileSync(
      join(ws, 'opencode.json'),
      JSON.stringify({ mcp: { 'gb-door-decoy': { type: 'local', command: ['/nonexistent/gb-door-decoy-bin'] } } }),
    );
    const probe = listProbe(home, ws);
    expect(probe.code).toBe(0);
    expect(probe.text).toContain('gb-door-decoy');
    expect(probe.text).toMatch(/✗\s+gb-door-decoy\s+failed/);
  }, 180_000);

  test('T3 writer parity: gbrain\'s direct JSONC writer output handshakes through the real binary; cross-tool preservation both ways', () => {
    const home = trackHome('writer');
    seedOpencodeConfig(home);
    const ws = join(home, 'ws');
    mkdirSync(ws, { recursive: true });

    const init = initBrain(home);
    expect(init.code).toBe(0);

    const binDir = join(home, 'staged-bin');
    stageGbrainBinDir(REPO_ROOT, binDir);

    // The bootstrap workspace lane's exact write path: PATH-resolved command
    // (the committed-candidate posture) + env binding, into the config file
    // the real binary then reads.
    const cfgPath = join(home, '.config', 'opencode', 'opencode.json');
    const w = writeOpencodeMcpEntry(cfgPath, {
      kind: 'local',
      name: 'gbrain',
      command: ['gbrain', 'serve', '--surface', 'verbs'],
      environment: { GBRAIN_HOME: home, GBRAIN_SOURCE: 'default' },
    }, { expect: { sourceId: 'default' } });
    expect(w.replacedPrior).toBe(false);

    const probe = listProbe(home, ws, binDir);
    expect(probe.text).toMatch(/✓\s+gbrain\s+connected/);

    // Cross-tool preservation: a subsequent CLI `mcp add` of another server
    // must not clobber the writer's entry or the autoupdate seed…
    const add2 = runOpencode(home, ws, ['mcp', 'add', 'door-second', '--url', 'https://door-second.invalid/mcp']);
    expect(add2.code).toBe(0);
    const cfg = readGlobalConfig(home);
    const mcp = cfg.mcp as Record<string, { command?: string[] }>;
    expect(mcp.gbrain?.command).toEqual(['gbrain', 'serve', '--surface', 'verbs']);
    expect((cfg.autoupdate as boolean)).toBe(false);
    // …and the writer must preserve the CLI-written entry in return.
    writeOpencodeMcpEntry(cfgPath, {
      kind: 'local',
      name: 'gbrain',
      command: ['gbrain', 'serve', '--surface', 'verbs'],
      environment: { GBRAIN_HOME: home, GBRAIN_SOURCE: 'default' },
    }, { expect: { sourceId: 'default' } });
    const cfg2 = readGlobalConfig(home);
    expect((cfg2.mcp as Record<string, unknown>)['door-second']).toBeDefined();
  }, 300_000);

  test('T4 SMOKE (keyless free tier): per-run nonce recalled via a STRUCTURAL gbrain tool_use event', async () => {
    const home = trackHome('smoke');
    seedOpencodeConfig(home);
    const ws = join(home, 'ws');
    mkdirSync(ws, { recursive: true });

    // Per-run nonce: opencode has fs/shell tools, so a committed fixture
    // string would be greppable from the checkout — recall of a nonce
    // seeded into THIS run's brain proves tool mediation, not memory.
    const nonce = `kestrel-${Math.random().toString(16).slice(2, 10)}`;
    await seedBrainForAgent(home, 'default', {
      entity: 'Door Probe',
      fact: `The secret door codeword is ${nonce}.`,
      query: 'What is the secret door codeword?',
      slug: 'facts/door-probe',
    });

    const binDir = join(home, 'staged-bin');
    stageGbrainBinDir(REPO_ROOT, binDir);
    const add = registerGbrainIntoOpencode(home, ws, binDir, home, 'default');
    expect(add.code).toBe(0);

    // list preflight gates the turn — never burn a model turn (even a free
    // one) on a broken registration.
    const pre = listProbe(home, ws, binDir);
    expect(pre.text).toMatch(/✓\s+gbrain\s+connected/);

    const prompt =
      'You have gbrain memory tools available over MCP. Use them to find the secret door ' +
      'codeword (search or recall: door codeword). Reply with ONLY the codeword string. ' +
      'If you have no gbrain tools at all, reply exactly: NO-GBRAIN-TOOL';

    // Two attempts with backoff: the free tier rides opencode's gateway and
    // a transient 5xx must not red the door; asserts NEVER soften.
    let finalText = '';
    let toolCalls: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const turn = await opencodeOneShotTurn({
        prompt,
        cwd: ws,
        home,
        timeoutMs: 240_000,
        format: 'json',
        binDir,
      });
      const parsed = parseOpencodeJsonl(turn.finalText.split('\n'));
      finalText = parsed.finalText;
      toolCalls = parsed.toolCalls;
      try { writeFileSync(join(home, 'door-turn.jsonl'), turn.finalText); } catch { /* evidence */ }
      if (turn.exitCode === 0 && finalText.includes(nonce)) break;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 3_000));
    }

    expect(finalText).toContain(nonce);
    expect(finalText).not.toContain('NO-GBRAIN-TOOL');
    // Structural tool-mediation proof: at least one gbrain MCP tool fired
    // (MCP tool naming `<server>_<tool>` observed — e.g. gbrain_recall).
    expect(toolCalls.some((t) => t.startsWith('gbrain_'))).toBe(true);
  }, 600_000);
});

describe.skipIf(!CAN_RUN_PAID)('install real-opencode door — paid tier (anthropic leg, serial e2e)', () => {
  test('T5 models-gate + paid turn: the pinned model id exists in the authed list BEFORE any spend, then recalls the nonce', async () => {
    const home = trackHome('paid');
    seedOpencodeConfig(home, { defaultModel: PAID_MODEL });
    const ws = join(home, 'ws');
    mkdirSync(ws, { recursive: true });

    // Self-validating gate: never spend against a guessed model id. When
    // this fails, update PAID_MODEL from this authed list + the PIN doc.
    const models = runOpencode(home, ws, ['models']);
    expect(models.code).toBe(0);
    if (!models.stdout.includes(PAID_MODEL)) {
      throw new Error(
        `pinned paid model '${PAID_MODEL}' is not in the authed \`opencode models\` output — ` +
        'update the pin here and in OPENCODE-CLI-PIN.md §Pending auth (no spend attempted).',
      );
    }

    const nonce = `heron-${Math.random().toString(16).slice(2, 10)}`;
    await seedBrainForAgent(home, 'default', {
      entity: 'Door Probe Paid',
      fact: `The paid-lane door codeword is ${nonce}.`,
      query: 'What is the paid-lane door codeword?',
      slug: 'facts/door-probe-paid',
    });
    const binDir = join(home, 'staged-bin');
    stageGbrainBinDir(REPO_ROOT, binDir);
    expect(registerGbrainIntoOpencode(home, ws, binDir, home, 'default').code).toBe(0);
    expect(listProbe(home, ws, binDir).text).toMatch(/✓\s+gbrain\s+connected/);

    const turn = await opencodeOneShotTurn({
      prompt:
        'Use your gbrain memory tools to find the paid-lane door codeword. Reply with ONLY the ' +
        'codeword string. If you have no gbrain tools at all, reply exactly: NO-GBRAIN-TOOL',
      cwd: ws,
      home,
      timeoutMs: 240_000,
      model: PAID_MODEL,
      binDir,
    });
    expect(turn.exitCode).toBe(0);
    expect(turn.finalText).toContain(nonce);
    expect(turn.finalText).not.toContain('NO-GBRAIN-TOOL');
  }, 600_000);
});
