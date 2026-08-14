/**
 * dx-explore — drive the REAL fresh-user experience under a PTY and record it.
 *
 * The e2e door tests (test/e2e/bootstrap-real-{claude,codex}.serial.test.ts)
 * prove the install WORKS headlessly. This script captures what installing
 * FEELS like: every picker, prompt, spinner, silence window, and line of copy
 * a fresh user sees, as timestamped transcripts ready for a
 * Don't-Make-Me-Think DX audit. It is a developer instrument, not a test —
 * transcripts land in .context/dx-runs/ (gitignored) and nothing asserts.
 *
 * Scenarios (all hermetic — temp HOME/GBRAIN_HOME/CLAUDE_CONFIG_DIR/CODEX_HOME;
 * the operator's real config is never WRITTEN. Two narrow reads exist for
 * auth: codex-install copies ~/.codex/auth.json into the temp CODEX_HOME, and
 * the claude seed records the API key's last 20 chars — both copies are
 * scrubbed at cleanup even under --keep, so no credential material outlives
 * the run):
 *
 *   help            First-touch comprehension surfaces: bare `gbrain`,
 *                   `gbrain --help`, `gbrain init --help`, `gbrain bootstrap
 *                   --help`, `gbrain bootstrap` bare. Cheap, no keys.
 *   init            Interactive `gbrain init` (keyless) with a naive-user
 *                   autopilot: wait for each screen to settle, snapshot it,
 *                   press Enter (accept the default), repeat. What a user who
 *                   "just hits Enter" experiences, with stall timing.
 *   claude-install  REAL interactive `claude` in a fresh empty workspace,
 *                   driven by the README paste block pointed at THIS repo's
 *                   BOOTSTRAP_FOR_AGENTS.md, with a scripted persona appendix
 *                   so the interview completes unattended. Pays real API cost;
 *                   takes 10-25 min. Run in background and watch session/screen.txt.
 *   codex-install   Same for REAL `codex` (interactive TUI).
 *   drive -- <cmd>  Manual mode: spawn ANY command under the PTY and steer it
 *                   across separate shell calls via a file control channel:
 *                     watch:  cat  <dir>/session/screen.txt
 *                     type:   echo '{"line":"hello"}' >> <dir>/session/input.jsonl
 *                     keys:   echo '{"key":"Down"}'   >> <dir>/session/input.jsonl
 *                     note:   echo '{"note":"picker confuses me"}' >> ...
 *                     stop:   echo '{"stop":true}'    >> ...
 *                   {"line": ...} sends text + Enter; {"send": ...} sends raw
 *                   bytes (mind that zsh `echo` mangles \r — prefer "line").
 *                   Launch as a background task; this is how an agent in
 *                   Conductor explores a live TUI across tool calls.
 *
 * Usage:
 *   bun run scripts/dx-explore.ts help
 *   bun run scripts/dx-explore.ts init
 *   bun run scripts/dx-explore.ts claude-install
 *   bun run scripts/dx-explore.ts codex-install
 *   bun run scripts/dx-explore.ts drive [--no-hermetic-home] -- gbrain init
 *   Options: --dir <out>   transcript dir (default .context/dx-runs/<scenario>-<ts>)
 *            --gbrain <bin> use an existing gbrain binary (default: compile+cache)
 *            --rebuild      force recompile of the cached binary
 *            --keep         keep hermetic temp homes for forensics
 *
 * Output bundle per scenario dir: meta.json, raw.txt, visible.txt,
 * frames.jsonl, stalls.md, events.jsonl (inputs/notes timeline), steps.md
 * (autopilot screen-by-screen), session/ (live: screen.txt, status.json).
 *
 * Progress prints to stderr; the transcript dir path is the only stdout line
 * (pipe-friendly), matching the repo's progress discipline.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  launchTty,
  saveTranscript,
  seedClaudeTuiConfig,
  parseDriveCommand,
  type TtySession,
} from '../test/helpers/tty-harness.ts';

const REPO_ROOT = path.resolve(import.meta.dir, '..');

/** Screen patterns that mean the paste-in install reached a passing verify —
 *  ONE list shared by the claude-install and codex-install scenarios so the
 *  two can't drift when the bootstrap's success copy changes. */
const VERIFY_SUCCESS_PATTERNS: Array<RegExp | string> = [
  /bootstrap verify.*exit(?:ed|s)? 0/i,
  /verify\b.*\b(passed|0\b)/i,
  /All checks passed/i,
];

// Same synthetic persona the door tests use — the interview can complete
// unattended and nothing real about the operator ever enters a transcript.
const PERSONA = {
  AGENT_NAME: 'Lighthouse',
  PRINCIPAL_NAME: 'Pat Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
  AGENT_TOP_JOBS: 'corpus upkeep; weekly memo; meeting prep',
  PRINCIPAL_CONTEXT: 'Runs a small research group; builds internal tooling; values signal over noise.',
  VOICE_REGISTER: 'Direct: three options, the second one wins.',
};

function log(msg: string): void {
  process.stderr.write(`[dx-explore] ${msg}\n`);
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
}

// ── arg parsing ──────────────────────────────────────────────────────────────

interface CliArgs {
  scenario: string;
  dir?: string;
  gbrainBin?: string;
  rebuild: boolean;
  keep: boolean;
  /** Strip provider API keys from the child env — the TRUE keyless posture.
   *  Without this, a Conductor session's ANTHROPIC_API_KEY leaks into the
   *  hermetic run and the keyless first-touch path is never exercised. */
  keyless: boolean;
  hermeticHome: boolean;
  driveArgv: string[];
}

/** Provider keys the hermetic base allows through; --keyless drops them. */
const PROVIDER_KEY_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'GSTACK_ANTHROPIC_API_KEY',
  'GSTACK_OPENAI_API_KEY',
];

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    scenario: '',
    rebuild: false,
    keep: false,
    keyless: false,
    hermeticHome: true,
    driveArgv: [],
  };
  let i = 0;
  const sep = argv.indexOf('--');
  const own = sep >= 0 ? argv.slice(0, sep) : argv;
  out.driveArgv = sep >= 0 ? argv.slice(sep + 1) : [];
  while (i < own.length) {
    const a = own[i]!;
    if (a === '--dir') out.dir = own[++i];
    else if (a === '--gbrain') out.gbrainBin = own[++i];
    else if (a === '--rebuild') out.rebuild = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--keyless') out.keyless = true;
    else if (a === '--no-hermetic-home') out.hermeticHome = false;
    else if (!out.scenario && !a.startsWith('--')) out.scenario = a;
    else {
      log(`unknown argument: ${a}`);
      process.exit(2);
    }
    i++;
  }
  return out;
}

// ── compiled gbrain binary (what a real user runs) ───────────────────────────

/** Compile (or reuse) a standalone gbrain binary. `bun run src/cli.ts` adds a
 *  multi-second transpile stall to EVERY invocation that a real install never
 *  has — a compiled binary keeps the timing honest. Cached under
 *  .context/dx-runs/bin/ keyed on nothing (use --rebuild after code changes). */
function ensureGbrainBinary(explicit: string | undefined, rebuild: boolean): string {
  if (explicit) {
    fs.accessSync(explicit, fs.constants.X_OK);
    return path.resolve(explicit);
  }
  const binDir = path.join(REPO_ROOT, '.context', 'dx-runs', 'bin');
  const binPath = path.join(binDir, 'gbrain');
  if (!rebuild && fs.existsSync(binPath)) {
    log(`reusing compiled gbrain at ${binPath} (--rebuild to refresh)`);
    return binPath;
  }
  fs.mkdirSync(binDir, { recursive: true });
  log('compiling gbrain (bun build --compile)…');
  const res = spawnSync('bun', ['build', '--compile', '--outfile', binPath, 'src/cli.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0 || !fs.existsSync(binPath)) {
    throw new Error(`bun build --compile failed (exit ${res.status}):\n${(res.stderr ?? '').slice(-2000)}`);
  }
  log(`compiled ${binPath}`);
  return binPath;
}

// ── scenario plumbing ────────────────────────────────────────────────────────

interface ScenarioCtx {
  outDir: string;
  gbrainBin: string;
  keep: boolean;
  /** temp dirs to remove on completion unless --keep */
  cleanups: string[];
  /** Files carrying credential material (copied auth.json, seeded key
   *  suffixes). ALWAYS deleted at cleanup — --keep keeps transcripts and
   *  hermetic dirs for forensics, never credentials. */
  secretPaths: string[];
  events: Array<{ tMs: number; kind: 'input' | 'note' | 'screen'; data: string }>;
  t0: number;
}

function newCtx(args: CliArgs, needsGbrain: boolean): ScenarioCtx {
  const outDir = path.resolve(
    args.dir ?? path.join(REPO_ROOT, '.context', 'dx-runs', `${args.scenario}-${nowStamp()}`),
  );
  fs.mkdirSync(outDir, { recursive: true });
  const ctx: ScenarioCtx = {
    outDir,
    gbrainBin: needsGbrain ? ensureGbrainBinary(args.gbrainBin, args.rebuild) : '',
    keep: args.keep,
    cleanups: [],
    secretPaths: [],
    events: [],
    t0: Date.now(),
  };
  installSignalScrub(ctx);
  return ctx;
}

function tmp(ctx: ScenarioCtx, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ctx.cleanups.push(dir);
  return dir;
}

function event(ctx: ScenarioCtx, kind: 'input' | 'note' | 'screen', data: string): void {
  ctx.events.push({ tMs: Date.now() - ctx.t0, kind, data });
}

/** Delete every credential copy. Idempotent; safe to call from a signal
 *  handler AND from finishCtx (a second call is a no-op). This is the
 *  "no credential outlives the run" guarantee — it must run even when a
 *  10-25min install is Ctrl-C'd (finally does NOT run on SIGINT default). */
function scrubSecrets(ctx: ScenarioCtx): void {
  for (const p of ctx.secretPaths) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Wire SIGINT/SIGTERM so an interrupted run still scrubs credentials before
 *  the process dies. Registered once per scenario ctx. */
function installSignalScrub(ctx: ScenarioCtx): void {
  const handler = (sig: NodeJS.Signals) => {
    scrubSecrets(ctx);
    process.stderr.write(`\n[dx-explore] ${sig}: scrubbed credential copies, exiting.\n`);
    process.exit(130);
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

function finishCtx(ctx: ScenarioCtx): void {
  // Scrub credentials FIRST — before any other I/O that could throw (an
  // events.jsonl write failure must not strand auth files).
  scrubSecrets(ctx);
  fs.writeFileSync(
    path.join(ctx.outDir, 'events.jsonl'),
    ctx.events.map((e) => JSON.stringify(e)).join('\n') + (ctx.events.length ? '\n' : ''),
  );
  if (ctx.keep && ctx.secretPaths.length > 0) {
    log(`--keep: retained hermetic dirs, but scrubbed ${ctx.secretPaths.length} credential file(s)`);
  }
  if (!ctx.keep) {
    for (const d of ctx.cleanups) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  } else {
    fs.writeFileSync(
      path.join(ctx.outDir, 'hermetic-dirs.json'),
      JSON.stringify(ctx.cleanups, null, 2),
    );
  }
  // The one stdout line: where the transcript landed.
  console.log(ctx.outDir);
}

/** Live session mirror so a watcher (or a Conductor agent) can follow along:
 *  session/screen.txt (latest visible tail) + session/status.json. */
function mirrorSession(dir: string, session: TtySession): () => void {
  const sessDir = path.join(dir, 'session');
  fs.mkdirSync(sessDir, { recursive: true });
  const timer = setInterval(() => {
    try {
      fs.writeFileSync(path.join(sessDir, 'screen.txt'), session.visible().slice(-8000));
      fs.writeFileSync(
        path.join(sessDir, 'status.json'),
        JSON.stringify(
          {
            running: !session.exited(),
            exitCode: session.exitCode(),
            elapsedMs: Date.now() - session.startedAtMs,
            frames: session.frames().length,
          },
          null,
          2,
        ),
      );
    } catch {
      /* best-effort */
    }
  }, 500);
  return () => clearInterval(timer);
}

function saveSession(ctx: ScenarioCtx, name: string, session: TtySession, extraMeta: Record<string, unknown> = {}): void {
  const dir = name ? path.join(ctx.outDir, name) : ctx.outDir;
  saveTranscript(dir, {
    frames: session.frames(),
    raw: session.raw(),
    meta: {
      scenario: name || path.basename(ctx.outDir),
      argv: session.argv,
      startedAtIso: new Date(session.startedAtMs).toISOString(),
      exitCode: session.exitCode(),
      durationMs: Date.now() - session.startedAtMs,
      ...extraMeta,
    },
  });
}

// ── scenario: help ───────────────────────────────────────────────────────────

async function scenarioHelp(ctx: ScenarioCtx, args: CliArgs): Promise<void> {
  const home = tmp(ctx, 'gb-dx-home-');
  const ws = tmp(ctx, 'gb-dx-ws-');
  const dropEnv = args.keyless ? PROVIDER_KEY_NAMES : undefined;
  const surfaces: Array<{ name: string; argv: string[] }> = [
    { name: 'step-01-bare', argv: [ctx.gbrainBin] },
    { name: 'step-02-help', argv: [ctx.gbrainBin, '--help'] },
    { name: 'step-03-init-help', argv: [ctx.gbrainBin, 'init', '--help'] },
    { name: 'step-04-bootstrap-help', argv: [ctx.gbrainBin, 'bootstrap', '--help'] },
    { name: 'step-05-bootstrap-bare', argv: [ctx.gbrainBin, 'bootstrap'] },
    { name: 'step-06-status-fresh', argv: [ctx.gbrainBin, 'status'] },
  ];
  for (const s of surfaces) {
    log(`running ${s.name}: ${s.argv.join(' ')}`);
    const session = launchTty(s.argv, {
      cwd: ws,
      env: { HOME: home, GBRAIN_HOME: home },
      dropEnv,
      timeoutMs: 120_000,
    });
    await session.waitForExit(110_000);
    await session.close();
    saveSession(ctx, s.name, session);
  }
}

// ── scenario: init (naive-user autopilot) ────────────────────────────────────

async function scenarioInit(ctx: ScenarioCtx, args: CliArgs): Promise<void> {
  const home = tmp(ctx, 'gb-dx-home-');
  const ws = tmp(ctx, 'gb-dx-ws-');
  log(
    `interactive \`gbrain init\` (${args.keyless ? 'TRUE keyless — provider keys stripped' : 'ambient keys allowed'}), ` +
      'naive-user autopilot: Enter accepts every default',
  );
  const session = launchTty([ctx.gbrainBin, 'init'], {
    cwd: ws,
    env: { HOME: home, GBRAIN_HOME: home },
    dropEnv: args.keyless ? PROVIDER_KEY_NAMES : undefined,
    timeoutMs: 600_000,
  });
  const stopMirror = mirrorSession(ctx.outDir, session);

  const steps: string[] = [];
  let lastMarkPos = 0;
  const MAX_STEPS = 15;
  try {
    for (let step = 1; step <= MAX_STEPS && !session.exited(); step++) {
      const settled = await session.waitForQuiet({ quietMs: 2000, timeoutMs: 180_000 });
      const shot = session.visibleSince(lastMarkPos);
      lastMarkPos = session.mark();
      const tSec = ((Date.now() - session.startedAtMs) / 1000).toFixed(1);
      steps.push(
        `## Step ${step} (t+${tSec}s${settled ? '' : ', NEVER SETTLED within 180s'})\n\n` +
          '```\n' + shot.trim().slice(-3000) + '\n```\n',
      );
      event(ctx, 'screen', shot.slice(-2000));
      if (session.exited()) break;
      log(`step ${step}: screen settled at t+${tSec}s — pressing Enter (default)`);
      event(ctx, 'input', 'Enter');
      session.sendKey('Enter');
      await Bun.sleep(300);
    }
    await session.waitForExit(60_000);
  } finally {
    stopMirror();
    await session.close();
  }
  fs.writeFileSync(
    path.join(ctx.outDir, 'steps.md'),
    `# gbrain init — naive-user autopilot (Enter through every prompt)\n\n${steps.join('\n')}`,
  );
  saveSession(ctx, '', session, { autopilot: 'enter-through-defaults', keyless: args.keyless });
}

// ── scenarios: claude-install / codex-install ────────────────────────────────

/**
 * Handle the harness's own first-run chrome dialogs (Claude Code: workspace
 * trust, bypass-permissions warning) so an unattended run reaches the input
 * prompt. Each handled dialog is recorded as a note — the dialogs ARE part of
 * the real first-run friction, just not gbrain's copy. Returns once the
 * screen has been quiet with no dialog visible, or at the deadline.
 */
async function settlePastBootDialogs(
  ctx: ScenarioCtx,
  session: TtySession,
  opts: { deadlineMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.deadlineMs ?? 90_000);
  const handled = new Set<string>();
  while (Date.now() < deadline) {
    await session.waitForQuiet({ quietMs: 2000, timeoutMs: 30_000 });
    if (session.exited()) return;
    const tail = session.visible().slice(-2500);
    if (!handled.has('trust') && /trust this ?folder/i.test(tail.replace(/\s+/g, ' '))) {
      handled.add('trust');
      event(ctx, 'note', 'boot dialog: workspace trust — accepted (option 1)');
      session.send('1');
      await Bun.sleep(300);
      session.sendKey('Enter');
      continue;
    }
    if (!handled.has('bypass') && /Bypass ?Permissions ?mode/i.test(tail.replace(/\s+/g, ''))) {
      handled.add('bypass');
      event(ctx, 'note', 'boot dialog: bypass-permissions warning — accepted (option 2)');
      session.send('2');
      await Bun.sleep(300);
      session.sendKey('Enter');
      continue;
    }
    // Codex directory-trust dialog: "Do you trust the contents of this
    // directory? › 1. Yes, continue  2. No, quit".
    if (!handled.has('codex-trust') && /trust ?the ?contents ?of ?this ?directory/i.test(tail.replace(/\s+/g, ''))) {
      handled.add('codex-trust');
      event(ctx, 'note', 'boot dialog: codex directory trust — accepted (option 1)');
      session.send('1');
      await Bun.sleep(300);
      session.sendKey('Enter');
      continue;
    }
    return; // quiet + no dialog = at the input prompt
  }
}

/** The README paste block, pointed at THIS repo's runbook, plus a persona
 *  appendix so the interview completes unattended. The appendix is the ONLY
 *  deviation from the shipped block — flagged in meta so the audit discounts it. */
function installPrompt(): string {
  const runbook = path.join(REPO_ROOT, 'BOOTSTRAP_FOR_AGENTS.md');
  return (
    `Read and follow every step of: ${runbook}\n` +
    `Goal: set yourself up as my persistent personal agent in this folder, with gbrain ` +
    `as your memory. Interview me before writing any identity file — never invent ` +
    `answers. Ask before anything destructive. You are not done until ` +
    `\`gbrain bootstrap verify\` exits 0.\n\n` +
    `[Unattended-run appendix — I am stepping away; use these interview answers instead ` +
    `of asking me, and do not wait for my input: ` +
    `agent name: ${PERSONA.AGENT_NAME}; my name: ${PERSONA.PRINCIPAL_NAME}; ` +
    `purpose: ${PERSONA.AGENT_PURPOSE}; top jobs: ${PERSONA.AGENT_TOP_JOBS}; ` +
    `about me: ${PERSONA.PRINCIPAL_CONTEXT}; voice: ${PERSONA.VOICE_REGISTER}. ` +
    `gbrain is already installed and on PATH. If a step needs GitHub auth or an API key ` +
    `that is unavailable, take the documented keyless/local fallback and continue.]`
  );
}

async function scenarioClaudeInstall(ctx: ScenarioCtx): Promise<void> {
  const home = tmp(ctx, 'gb-dx-home-');
  const cfg = tmp(ctx, 'gb-dx-ccfg-');
  const gbHome = tmp(ctx, 'gb-dx-gbhome-');
  const ws = tmp(ctx, 'gb-dx-ws-');
  const binDir = tmp(ctx, 'gb-dx-bin-');
  fs.copyFileSync(ctx.gbrainBin, path.join(binDir, 'gbrain'));
  fs.chmodSync(path.join(binDir, 'gbrain'), 0o755);

  seedClaudeTuiConfig(cfg, {
    apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.GSTACK_ANTHROPIC_API_KEY,
    // realpath: macOS tmpdirs live under /var → /private/var; claude compares
    // against the resolved path, so an unresolved seed misses.
    trustedDirs: [ws, fs.realpathSync(ws)],
  });
  // The seed records the key's last 20 chars — credential-adjacent, so it is
  // scrubbed at cleanup even with --keep.
  ctx.secretPaths.push(path.join(cfg, '.claude.json'));

  log('REAL interactive claude running the paste-in bootstrap (10-25 min, real API cost)');
  log(`watch live: cat ${path.join(ctx.outDir, 'session', 'screen.txt')}`);
  const session = launchTty(
    // --dangerously-skip-permissions: v1 measures flow + copy + stalls without
    // permission-dialog babysitting. Permission-prompt COUNT is a separate
    // drive-mode pass (the dialogs are Claude Code's chrome, not gbrain copy).
    ['claude', '--dangerously-skip-permissions'],
    {
      cwd: ws,
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: cfg,
        GBRAIN_HOME: gbHome,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
      timeoutMs: 1_800_000,
    },
  );
  const stopMirror = mirrorSession(ctx.outDir, session);
  try {
    // Get past first-run chrome (trust dialog, bypass warning), then paste.
    await settlePastBootDialogs(ctx, session);
    event(ctx, 'input', 'paste install prompt');
    session.send(installPrompt());
    await Bun.sleep(1500);
    session.sendKey('Enter');
    // Run until verify-success copy or exit or wall clock.
    const done = await Promise.race([
      session
        .waitForAny(VERIFY_SUCCESS_PATTERNS, {
          timeoutMs: 1_500_000,
        })
        .then(() => 'verify-signal')
        .catch(() => 'no-signal'),
      session.waitForExit(1_500_000).then(() => 'exited'),
    ]);
    event(ctx, 'note', `terminal condition: ${done}`);
    // Let trailing output land.
    await session.waitForQuiet({ quietMs: 5000, timeoutMs: 60_000 });
  } finally {
    stopMirror();
    await session.close();
  }
  saveSession(ctx, '', session, {
    promptDeviation: 'unattended persona appendix + local runbook path + preinstalled binary',
    runbook: 'BOOTSTRAP_FOR_AGENTS.md (local)',
  });
}

async function scenarioCodexInstall(ctx: ScenarioCtx): Promise<void> {
  const home = tmp(ctx, 'gb-dx-home-');
  const gbHome = tmp(ctx, 'gb-dx-gbhome-');
  const ws = tmp(ctx, 'gb-dx-ws-');
  const binDir = tmp(ctx, 'gb-dx-bin-');
  fs.copyFileSync(ctx.gbrainBin, path.join(binDir, 'gbrain'));
  fs.chmodSync(path.join(binDir, 'gbrain'), 0o755);

  // Hermetic ~/.codex with ONLY the operator's auth (same posture as the
  // codex door test). codex refuses untrusted cwds — a git repo satisfies it.
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const realAuth = path.join(os.homedir(), '.codex', 'auth.json');
  if (fs.existsSync(realAuth)) {
    const authCopy = path.join(codexHome, 'auth.json');
    fs.copyFileSync(realAuth, authCopy);
    fs.chmodSync(authCopy, 0o600); // copyFileSync doesn't preserve source mode
    ctx.secretPaths.push(authCopy); // scrubbed at cleanup, even with --keep
  }
  spawnSync('git', ['init', '-q', ws]);
  spawnSync('git', ['-C', ws, 'config', 'user.email', 'dx@example.com']);
  spawnSync('git', ['-C', ws, 'config', 'user.name', 'DX Explore']);

  log('REAL interactive codex running the paste-in bootstrap (10-25 min, real API cost)');
  log(`watch live: cat ${path.join(ctx.outDir, 'session', 'screen.txt')}`);
  const session = launchTty(
    ['codex', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
    {
      cwd: ws,
      env: {
        HOME: home,
        CODEX_HOME: codexHome,
        GBRAIN_HOME: gbHome,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
      extraAllow: ['OPENAI_API_KEY', 'CODEX_*'],
      timeoutMs: 1_800_000,
    },
  );
  const stopMirror = mirrorSession(ctx.outDir, session);
  try {
    await settlePastBootDialogs(ctx, session);
    event(ctx, 'input', 'paste install prompt');
    session.send(installPrompt());
    await Bun.sleep(1500);
    session.sendKey('Enter');
    const done = await Promise.race([
      session
        .waitForAny(VERIFY_SUCCESS_PATTERNS, {
          timeoutMs: 1_500_000,
        })
        .then(() => 'verify-signal')
        .catch(() => 'no-signal'),
      session.waitForExit(1_500_000).then(() => 'exited'),
    ]);
    event(ctx, 'note', `terminal condition: ${done}`);
    await session.waitForQuiet({ quietMs: 5000, timeoutMs: 60_000 });
  } finally {
    stopMirror();
    await session.close();
  }
  saveSession(ctx, '', session, {
    promptDeviation: 'unattended persona appendix + local runbook path + preinstalled binary',
    runbook: 'BOOTSTRAP_FOR_AGENTS.md (local)',
  });
}

// ── scenario: drive (manual control channel) ─────────────────────────────────

async function scenarioDrive(ctx: ScenarioCtx, args: CliArgs): Promise<void> {
  if (args.driveArgv.length === 0) {
    log('drive mode needs a command: dx-explore.ts drive -- gbrain init');
    process.exit(2);
  }
  // `gbrain` as argv[0] resolves to the compiled binary.
  const argv = [...args.driveArgv];
  if (argv[0] === 'gbrain') argv[0] = ctx.gbrainBin;

  const sessDir = path.join(ctx.outDir, 'session');
  fs.mkdirSync(sessDir, { recursive: true });
  const inputPath = path.join(sessDir, 'input.jsonl');
  fs.writeFileSync(inputPath, '');

  const env: Record<string, string | undefined> = {};
  if (args.hermeticHome) {
    const home = tmp(ctx, 'gb-dx-home-');
    env.HOME = home;
    env.GBRAIN_HOME = home;
  }

  log(`driving: ${argv.join(' ')}`);
  log(`watch:   cat ${path.join(sessDir, 'screen.txt')}`);
  log(`input:   echo '{"line":"some text"}' >> ${inputPath}   (sends text + Enter)`);
  log(`         echo '{"key":"Down"}' >> ${inputPath}`);
  log(`stop:    echo '{"stop":true}' >> ${inputPath}`);

  const session = launchTty(argv, {
    cwd: process.cwd(),
    env,
    timeoutMs: 3_600_000,
  });
  const stopMirror = mirrorSession(ctx.outDir, session);

  let offset = 0;
  let stopping = false;
  try {
    while (!session.exited() && !stopping) {
      await Bun.sleep(200);
      let content = '';
      try {
        content = fs.readFileSync(inputPath, 'utf8');
      } catch {
        continue;
      }
      if (content.length <= offset) continue;
      const fresh = content.slice(offset);
      offset = content.length;
      for (const line of fresh.split('\n')) {
        if (!line.trim()) continue;
        const cmd = parseDriveCommand(line);
        if (!cmd) {
          log(`skipping malformed drive command: ${line.slice(0, 120)}`);
          continue;
        }
        if (cmd.kind === 'send') {
          event(ctx, 'input', cmd.data);
          session.send(cmd.data);
        } else if (cmd.kind === 'key') {
          event(ctx, 'input', `<${cmd.key}>`);
          session.sendKey(cmd.key);
        } else if (cmd.kind === 'note') {
          event(ctx, 'note', cmd.text);
        } else if (cmd.kind === 'stop') {
          stopping = true;
          break;
        }
      }
    }
  } finally {
    stopMirror();
    await session.close();
  }
  saveSession(ctx, '', session, { mode: 'drive', command: argv.join(' ') });
}

// ── main ─────────────────────────────────────────────────────────────────────

const SCENARIOS: Record<string, { needsGbrain: boolean; run: (ctx: ScenarioCtx, args: CliArgs) => Promise<void> }> = {
  help: { needsGbrain: true, run: scenarioHelp },
  init: { needsGbrain: true, run: scenarioInit },
  'claude-install': { needsGbrain: true, run: scenarioClaudeInstall },
  'codex-install': { needsGbrain: true, run: scenarioCodexInstall },
  drive: { needsGbrain: true, run: scenarioDrive },
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenario = SCENARIOS[args.scenario];
  if (!scenario) {
    log(`usage: bun run scripts/dx-explore.ts <${Object.keys(SCENARIOS).join('|')}> [options] [-- cmd...]`);
    process.exit(2);
  }
  const ctx = newCtx(args, scenario.needsGbrain);
  log(`transcripts → ${ctx.outDir}`);
  try {
    await scenario.run(ctx, args);
  } finally {
    finishCtx(ctx);
  }
}

await main();
