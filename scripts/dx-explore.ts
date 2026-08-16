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
 *   opencode-install Same for REAL `opencode` (bootstrap-supported; the keyless
 *                    run rides the anonymous free tier and should COMPLETE).
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
 *   bun run scripts/dx-explore.ts opencode-install [--keyless]
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
  ptySupported,
  redactSecrets,
  stripAnsi,
  MIN_REDACT_SECRET_LEN,
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

/** Provider keys the hermetic base allows through; --keyless drops them.
 *  Also the redaction-map source: every non-empty value here is scrubbed
 *  from every written artifact. */
const PROVIDER_KEY_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
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
  /** Secret VALUES (name → value) redacted from every written artifact —
   *  transcripts, the live screen mirror, events.jsonl. Structural, not
   *  checklist: writes go through redactSecrets at the write site. */
  redact: Record<string, string>;
  events: Array<{ tMs: number; kind: 'input' | 'note' | 'screen'; data: string }>;
  t0: number;
}

/** Non-empty provider-key VALUES currently in the environment — the redaction
 *  map for every artifact write. */
function buildRedactMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PROVIDER_KEY_NAMES) {
    const v = process.env[name];
    if (v && v.trim().length >= MIN_REDACT_SECRET_LEN) out[name] = v;
  }
  return out;
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
    redact: buildRedactMap(),
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
    redactSecrets(
      ctx.events.map((e) => JSON.stringify(e)).join('\n') + (ctx.events.length ? '\n' : ''),
      ctx.redact,
    ),
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
 *  session/screen.txt (latest visible tail) + session/status.json. Each tick
 *  strips only a bounded RAW tail (a full-buffer stripAnsi every 500ms is
 *  quadratic on a 25-minute session) and redacts before writing — the mirror
 *  is a live artifact that outlives an interrupted run, so it must never
 *  carry a raw key even transiently. */
function mirrorSession(dir: string, session: TtySession, redact?: Record<string, string>): () => void {
  const sessDir = path.join(dir, 'session');
  fs.mkdirSync(sessDir, { recursive: true });
  const timer = setInterval(() => {
    try {
      fs.writeFileSync(
        path.join(sessDir, 'screen.txt'),
        redactSecrets(stripAnsi(session.raw().slice(-131_072)).slice(-8000), redact),
      );
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
    redact: ctx.redact,
    meta: {
      scenario: name || path.basename(ctx.outDir),
      argv: session.argv,
      startedAtIso: new Date(session.startedAtMs).toISOString(),
      exitCode: session.exitCode(),
      durationMs: Date.now() - session.startedAtMs,
      ...extraMeta,
    },
  });
  assertNoSecrets(dir, ctx.redact, ctx.t0);
}

/** Independent double-check of the structural redaction above: grep every
 *  written artifact for each raw secret value and HARD-FAIL on a hit (delete
 *  the leaking file, mark the run failed). A leak here means redactSecrets
 *  missed a rendering (e.g. ANSI-interleaved) — that is a bug to fix, never
 *  a warning to scroll past. */
function assertNoSecrets(dir: string, redact: Record<string, string>, sinceMs: number): void {
  const values = Object.entries(redact).filter(([, v]) => v && v.length >= MIN_REDACT_SECRET_LEN);
  if (values.length === 0) return;
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
    });
  let leaked = false;
  for (const file of walk(dir)) {
    // NEVER touch files that predate this run: --dir can point anywhere
    // (repo root, even $HOME) and deleting a pre-existing .env that happens
    // to contain the key would be data loss, not leak containment.
    try { if (fs.statSync(file).mtimeMs < sinceMs - 1000) continue; } catch { continue; }
    let body: string;
    try { body = fs.readFileSync(file, 'utf8'); } catch { continue; }
    // Joined-data pass for frame records: a secret split across JSONL
    // records never appears contiguously in the file body.
    let joinedData = '';
    if (file.endsWith('.jsonl')) {
      for (const line of body.split('\n')) {
        try { joinedData += String(JSON.parse(line)?.data ?? ''); } catch { /* not a data record */ }
      }
    }
    for (const [name, value] of values) {
      const hit =
        body.includes(value) ||
        stripAnsi(body).includes(value) || // ANSI-interleaved rendering
        (joinedData !== '' && (joinedData.includes(value) || stripAnsi(joinedData).includes(value)));
      if (hit) {
        leaked = true;
        fs.rmSync(file, { force: true });
        log(`SECRET LEAK: ${file} contained ${name} despite structural redaction — file deleted; fix redactSecrets coverage before trusting transcripts`);
      }
    }
  }
  if (leaked) {
    process.exitCode = 1;
  }
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
  const stopMirror = mirrorSession(ctx.outDir, session, ctx.redact);

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
    // Bounded strip: a repaint-heavy TUI (observed: grok's splash animation)
    // grows the raw buffer by MBs — stripping the FULL buffer every
    // iteration is the quadratic hot loop; strip a raw tail instead.
    const tail = stripAnsi(session.raw().slice(-131_072)).slice(-2500);
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
    // Grok Build sign-in screen (observed keyless copy: "Not signed in").
    // No unattended path exists past it — record the friction and stop
    // settling; the caller's wall clock must not burn on a login dialog.
    if (/not signed in/i.test(tail)) {
      event(ctx, 'note', 'boot dialog: grok sign-in required — no unattended path; stopping settle');
      return;
    }
    // Quiet with no KNOWN dialog: if the tail still LOOKS like a prompt
    // (numbered options / y-n / picker glyph), note it — a silently
    // mis-settled boot is otherwise invisible in the audit trail.
    if (/(?:^|\n)\s*(?:\d+\.\s|[❯›]\s)|\((?:y\/n|Y\/n)\)/m.test(tail.slice(-400))) {
      event(ctx, 'note', 'settle: quiet with an unmatched dialog-shaped tail — proceeding (note-only; check the transcript if the paste lands oddly)');
    }
    return; // quiet + no dialog = at the input prompt
  }
}

/** Stage the compiled gbrain into a fresh bin dir (PATH-prepend target) so
 *  the agent's bare `gbrain` runs this checkout. */
function stageBinDir(ctx: ScenarioCtx): string {
  const binDir = tmp(ctx, 'gb-dx-bin-');
  fs.copyFileSync(ctx.gbrainBin, path.join(binDir, 'gbrain'));
  fs.chmodSync(path.join(binDir, 'gbrain'), 0o755);
  return binDir;
}

interface InstallSessionOpts {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  extraAllow?: string[];
  dropEnv?: string[];
  /** The pasted prompt. Per-agent: the bootstrap runbook block for
   *  claude/codex, a brain-only GROK.md-driven block for grok. */
  prompt: string;
  /** Success copy to race against (default: the bootstrap verify patterns).
   *  Brain-only scenarios pass their own — grok's is the doctor banner. */
  successPatterns?: Array<RegExp | string>;
  timeoutMs?: number;
  meta: Record<string, unknown>;
}

/** The shared install-session tail the claude/codex/grok scenarios all run:
 *  launch → mirror → settle boot dialogs → paste the prompt → race
 *  verify-success copy vs exit → let trailing output land → save. Per-agent
 *  PREPARATION (TUI seeds, auth copies, git init) deliberately stays in each
 *  scenario — the loop is what was duplicated, the prep genuinely differs. */
async function runInstallSession(ctx: ScenarioCtx, opts: InstallSessionOpts): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1_800_000;
  let earlyTerminal: string | undefined;
  log(`watch live: cat ${path.join(ctx.outDir, 'session', 'screen.txt')}`);
  const session = launchTty(opts.argv, {
    cwd: opts.cwd,
    env: opts.env,
    extraAllow: opts.extraAllow,
    dropEnv: opts.dropEnv,
    timeoutMs,
  });
  const stopMirror = mirrorSession(ctx.outDir, session, ctx.redact);
  try {
    await settlePastBootDialogs(ctx, session);
    // Sign-in wall / textless splash: no unattended path exists past either.
    // Observed (grok v1.0.4 keyless): headless prints "Not signed in"; the
    // TUI loops a full-screen glyph animation with NO textual prompt for 8+
    // minutes. Try one Enter (the common skip-splash gesture), then if the
    // screen still carries no meaningful text — or shows the sign-in copy —
    // record the friction (that IS the keyless measurement) and end early
    // instead of pasting into a wall for the full wall clock.
    const tailText = () => stripAnsi(session.raw().slice(-131_072)).slice(-2500);
    // Sign-in copy, both surfaces observed (GROK-CLI-PIN.md): headless prints
    // "Not signed in"; the TUI settles (~6s, after an intro animation) onto
    // "Approve in your browser to finish signing in" + a device code.
    const signInWall = () =>
      /not signed in|approve in your browser|finish signing in|sign in with/i.test(tailText());
    // Word-like text only: splash/spinner screens render Braille-pattern
    // glyphs (U+2800 range, observed) with scattered digits/SGR residue but
    // ZERO 3+-letter runs, while any real prompt/sign-in screen carries
    // words. Counting letter runs beats enumerating glyph exceptions.
    const meaningfulLen = (s: string) => (s.match(/[A-Za-z]{3,}/g) ?? []).join('').length;
    if (!session.exited() && (signInWall() || meaningfulLen(tailText()) < 40)) {
      event(ctx, 'note', 'sign-in wall or textless splash — sending one Enter (skip-splash attempt)');
      session.sendKey('Enter');
      await Bun.sleep(3000);
      if (!session.exited() && (signInWall() || meaningfulLen(tailText()) < 40)) {
        event(ctx, 'note', 'sign-in wall / no textual prompt persists — ending session early (keyless friction recorded)');
        earlyTerminal = 'sign-in-wall-or-splash';
        return; // finally owns cleanup; save happens after it
      }
    }
    event(ctx, 'input', 'paste install prompt');
    // Scope the verify match to output AFTER the paste: the pasted prompt
    // itself contains verify-adjacent copy, and matching the full buffer
    // re-scans a growing transcript every poll.
    const pasteMark = session.mark();
    session.send(opts.prompt);
    await Bun.sleep(1500);
    session.sendKey('Enter');
    const raceBudget = Math.max(timeoutMs - 300_000, Math.floor(timeoutMs * 0.8));
    const done = await Promise.race([
      session
        .waitForAny(opts.successPatterns ?? VERIFY_SUCCESS_PATTERNS, { timeoutMs: raceBudget, since: pasteMark })
        .then(() => 'verify-signal')
        .catch(() => 'no-signal'),
      session.waitForExit(raceBudget).then(() => 'exited'),
    ]);
    event(ctx, 'note', `terminal condition: ${done}`);
    await session.waitForQuiet({ quietMs: 5000, timeoutMs: 60_000 });
  } finally {
    stopMirror();
    await session.close();
  }
  saveSession(ctx, '', session, earlyTerminal ? { ...opts.meta, terminal: earlyTerminal } : opts.meta);
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

async function scenarioClaudeInstall(ctx: ScenarioCtx, args: CliArgs): Promise<void> {
  const home = tmp(ctx, 'gb-dx-home-');
  const cfg = tmp(ctx, 'gb-dx-ccfg-');
  const gbHome = tmp(ctx, 'gb-dx-gbhome-');
  const ws = tmp(ctx, 'gb-dx-ws-');
  const binDir = stageBinDir(ctx);

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
  await runInstallSession(ctx, {
    // dangerously-skip-permissions (spelled dash-free here): v1 measures flow
    // + copy + stalls without permission-dialog babysitting. Permission-prompt
    // COUNT is a separate drive-mode pass (the dialogs are Claude Code's
    // chrome, not gbrain copy).
    argv: ['claude', '--dangerously-skip-permissions'],
    cwd: ws,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: cfg,
      GBRAIN_HOME: gbHome,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
    dropEnv: args.keyless ? PROVIDER_KEY_NAMES : undefined,
    prompt: installPrompt(),
    meta: {
      promptDeviation: 'unattended persona appendix + local runbook path + preinstalled binary',
      runbook: 'BOOTSTRAP_FOR_AGENTS.md (local)',
    },
  });
}

async function scenarioCodexInstall(ctx: ScenarioCtx, args: CliArgs): Promise<void> {
  const home = tmp(ctx, 'gb-dx-home-');
  const gbHome = tmp(ctx, 'gb-dx-gbhome-');
  const ws = tmp(ctx, 'gb-dx-ws-');
  const binDir = stageBinDir(ctx);

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
  await runInstallSession(ctx, {
    argv: ['codex', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
    cwd: ws,
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      GBRAIN_HOME: gbHome,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
    extraAllow: ['OPENAI_API_KEY', 'CODEX_*'],
    dropEnv: args.keyless ? PROVIDER_KEY_NAMES : undefined,
    prompt: installPrompt(),
    meta: {
      promptDeviation: 'unattended persona appendix + local runbook path + preinstalled binary',
      runbook: 'BOOTSTRAP_FOR_AGENTS.md (local)',
    },
  });
}

// ── scenario: codex-plugin-install ──────────────────────────────────────────

/** The PLUGIN lane's first-run journey: marketplace add + plugin add happen
 *  via the CLI up front (the two documented commands), then a REAL interactive
 *  codex session answers a brain question through the plugin-provided MCP
 *  server. Friction observed here is the plugin lane's actual first-run UX —
 *  distinct from codex-install, which observes the bootstrap paste-in lane. */
async function scenarioCodexPluginInstall(ctx: ScenarioCtx, args: CliArgs): Promise<void> {
  const home = tmp(ctx, 'gb-dx-home-');
  const gbHome = tmp(ctx, 'gb-dx-gbhome-');
  const ws = tmp(ctx, 'gb-dx-ws-');
  const binDir = stageBinDir(ctx);

  // Hermetic ~/.codex with ONLY the operator's auth (codex-install posture).
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const realAuth = path.join(os.homedir(), '.codex', 'auth.json');
  if (fs.existsSync(realAuth)) {
    const authCopy = path.join(codexHome, 'auth.json');
    fs.copyFileSync(realAuth, authCopy);
    fs.chmodSync(authCopy, 0o600);
    ctx.secretPaths.push(authCopy);
  }
  spawnSync('git', ['init', '-q', ws]);
  spawnSync('git', ['-C', ws, 'config', 'user.email', 'dx@example.com']);
  spawnSync('git', ['-C', ws, 'config', 'user.name', 'DX Explore']);

  // Stage a CLEAN tree (tracked files only) as the local marketplace source.
  const stage = tmp(ctx, 'gb-dx-plugin-stage-');
  spawnSync('sh', ['-c', `git -C '${REPO_ROOT}' archive HEAD | tar -x -C '${stage}'`]);

  // The two documented install commands, up front (CLI, not the PTY).
  const pluginEnv = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };
  for (const argv of [
    ['codex', 'plugin', 'marketplace', 'add', stage],
    ['codex', 'plugin', 'add', 'gbrain@gbrain'],
  ]) {
    const r = spawnSync(argv[0], argv.slice(1), { env: pluginEnv, encoding: 'utf8' });
    event(ctx, r.status === 0 ? 'note' : 'friction', `${argv.join(' ')} → exit ${r.status}${r.status === 0 ? '' : `: ${(r.stderr ?? '').slice(0, 300)}`}`);
    if (r.status !== 0) throw new Error(`plugin install step failed: ${argv.join(' ')}`);
  }

  // A brain the plugin serve can answer from (keyless PGLite + one fact).
  const initR = spawnSync(ctx.gbrainBin, ['init', '--pglite', '--no-embedding', '--non-interactive'], {
    env: { ...pluginEnv, GBRAIN_HOME: gbHome },
    cwd: ws,
    encoding: 'utf8',
  });
  if (initR.status !== 0) throw new Error(`gbrain init failed: ${(initR.stderr ?? '').slice(0, 300)}`);
  const seedR = spawnSync(ctx.gbrainBin, ['call', 'remember', JSON.stringify({
    content: 'The dx-explore plugin probe codeword is heliograph.',
    provenance: 'dx-explore codex-plugin-install scenario',
  })], { env: { ...pluginEnv, GBRAIN_HOME: gbHome }, cwd: ws, encoding: 'utf8' });
  if (seedR.status !== 0) {
    // Fail fast — proceeding would burn a paid, minutes-long interactive
    // session that can only fail confusingly on the codeword probe.
    throw new Error(`seed remember failed: ${(seedR.stderr ?? '').slice(0, 300)}`);
  }

  log('REAL interactive codex with the gbrain PLUGIN installed (minutes, real API cost)');
  await runInstallSession(ctx, {
    argv: ['codex', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
    cwd: ws,
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      GBRAIN_HOME: gbHome,
      GBRAIN_BIN: path.join(binDir, 'gbrain'),
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
    extraAllow: ['OPENAI_API_KEY', 'CODEX_*'],
    dropEnv: args.keyless ? PROVIDER_KEY_NAMES : undefined,
    prompt:
      'The gbrain plugin is installed. Using ONLY the gbrain MCP tools (do not guess), ' +
      'answer: what is the dx-explore plugin probe codeword? Then reply with one line: ' +
      'the codeword and which tool you used.\n\n' +
      '[Unattended-run appendix — I am stepping away; do not wait for my input. ' +
      'If no gbrain MCP tool is available, note the exact error and stop.]',
    meta: {
      promptDeviation: 'plugin lane (marketplace add + plugin add pre-run); brain question via plugin MCP',
      runbook: 'docs/mcp/CODEX.md (plugin install section)',
    },
  });
}

// ── scenario: grok-install ───────────────────────────────────────────────────

/** Brain-only success copy for the grok scenario: the doctor banner proves
 *  the registration handshook (observed, docs/mcp/GROK-CLI-PIN.md) — grok has
 *  NO bootstrap path, so the bootstrap verify patterns must not be its bar. */
const GROK_INSTALL_SUCCESS_PATTERNS: Array<RegExp | string> = [
  /7 tools discovered/i,
  /handshake OK/i,
];

/** GROK.md-driven brain-only prompt — deliberately NOT the bootstrap paste
 *  block: the docs classify grok as brain-only install (no `gbrain bootstrap`
 *  support), so the scenario must not test an unsupported flow. */
function grokInstallPrompt(): string {
  const guide = path.join(REPO_ROOT, 'docs', 'mcp', 'GROK.md');
  return (
    `Read and follow: ${guide}\n` +
    `Goal: wire the gbrain memory brain into you (Grok Build) over stdio MCP — ` +
    `brain-only install, no bootstrap. Steps: ` +
    `1) run \`gbrain init --pglite --no-embedding --non-interactive\`; ` +
    `2) register gbrain exactly as the guide's Register section shows; ` +
    `3) verify with \`grok mcp doctor gbrain\` — you are not done until it reports ` +
    `the tools-discovered check passing; ` +
    `4) one recall round-trip: use the gbrain remember tool to store ` +
    `"${PERSONA.AGENT_NAME} prefers ${PERSONA.VOICE_REGISTER}" and then recall it.\n\n` +
    `[Unattended-run appendix — I am stepping away; do not wait for my input. ` +
    `gbrain is already installed and on PATH. If a step needs auth that is ` +
    `unavailable, note the exact error and stop.]`
  );
}

async function scenarioGrokInstall(ctx: ScenarioCtx, args: CliArgs): Promise<void> {
  const home = tmp(ctx, 'gb-dx-home-');
  const gbHome = tmp(ctx, 'gb-dx-gbhome-');
  const ws = tmp(ctx, 'gb-dx-ws-');
  const binDir = stageBinDir(ctx);

  // Hermetic ~/.grok seeded with the auto-update kill-switch (config-only
  // mechanism, default ON — observed v1.0.4). Auth travels via XAI_API_KEY
  // env only; grok MAY persist derived credentials after an authed session,
  // so the known candidate is pre-registered for the scrub (rm of a file
  // that never appears is a no-op).
  const grokHome = path.join(home, '.grok');
  fs.mkdirSync(grokHome, { recursive: true });
  // Verbatim kill-switch homes (update together): seedGrokConfig in
  // test/helpers/agent-harness.ts and the grok-door auth-preflight printf
  // in .github/workflows/heavy-tests.yml.
  fs.writeFileSync(path.join(grokHome, 'config.toml'), '[cli]\nauto_update = false\n');
  ctx.secretPaths.push(path.join(grokHome, 'mcp_credentials.json'));

  log('REAL interactive grok running the GROK.md brain-only install (real API cost when authed)');
  log('keyless runs stop at the observed sign-in screen — that friction IS the measurement');
  await runInstallSession(ctx, {
    argv: ['grok'],
    cwd: ws,
    env: {
      HOME: home,
      GROK_HOME: grokHome,
      GBRAIN_HOME: gbHome,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      // Never let a keyless first-run bounce the OPERATOR's browser for
      // sign-in; the settle loop stops at the observed "Not signed in" copy.
      BROWSER: '/usr/bin/false',
    },
    extraAllow: ['XAI_API_KEY'],
    // --keyless drops provider keys AFTER extraAllow re-admission — a keyless
    // grok-install must measure the sign-in wall, not silently run authed.
    dropEnv: args.keyless ? PROVIDER_KEY_NAMES : undefined,
    prompt: grokInstallPrompt(),
    successPatterns: GROK_INSTALL_SUCCESS_PATTERNS,
    meta: {
      promptDeviation: 'unattended appendix + local GROK.md path + preinstalled binary',
      runbook: 'docs/mcp/GROK.md (local, brain-only — grok has no bootstrap path)',
    },
  });
}

// ── scenario: opencode-install ───────────────────────────────────────────────

async function scenarioOpencodeInstall(ctx: ScenarioCtx, args: CliArgs): Promise<void> {
  const home = tmp(ctx, 'gb-dx-home-');
  const gbHome = tmp(ctx, 'gb-dx-gbhome-');
  const ws = tmp(ctx, 'gb-dx-ws-');
  const binDir = stageBinDir(ctx);

  // Hermetic HOME + BOTH XDG dirs (config/auth/data all move — observed
  // v1.18.18, OPENCODE-CLI-PIN.md §Path seams), seeded with the config half
  // of the double autoupdate kill; the env half rides the session env below.
  const xdgConfig = path.join(home, '.config');
  const ocCfgDir = path.join(xdgConfig, 'opencode');
  fs.mkdirSync(ocCfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(ocCfgDir, 'opencode.json'),
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', autoupdate: false }, null, 2) + '\n',
  );
  // Auth travels env-only for the anthropic leg; a login flow would persist
  // auth.json — pre-register the known candidate for the scrub (rm of a file
  // that never appears is a no-op).
  ctx.secretPaths.push(path.join(home, '.local', 'share', 'opencode', 'auth.json'));
  spawnSync('git', ['init', '-q', ws]);
  spawnSync('git', ['-C', ws, 'config', 'user.email', 'dx@example.com']);
  spawnSync('git', ['-C', ws, 'config', 'user.name', 'DX Explore']);

  log('REAL interactive opencode running the paste-in bootstrap (opencode is a bootstrap-supported harness)');
  log('keyless runs ride the anonymous free tier (observed) — the flow should COMPLETE keyless; a sign-in wall here is itself a pin-refresh signal');
  await runInstallSession(ctx, {
    argv: ['opencode'],
    cwd: ws,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      GBRAIN_HOME: gbHome,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      // Never let a first-run bounce the OPERATOR's browser for sign-in.
      BROWSER: '/usr/bin/false',
    },
    extraAllow: ['ANTHROPIC_API_KEY'],
    // --keyless drops provider keys AFTER extraAllow re-admission — on
    // opencode that measures the FREE-TIER path, not a wall (observed).
    dropEnv: args.keyless ? PROVIDER_KEY_NAMES : undefined,
    prompt: installPrompt(),
    meta: {
      promptDeviation: 'unattended persona appendix + local runbook path + preinstalled binary',
      runbook: 'BOOTSTRAP_FOR_AGENTS.md (local — opencode is bootstrap-supported)',
    },
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
  const stopMirror = mirrorSession(ctx.outDir, session, ctx.redact);

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
  'codex-plugin-install': { needsGbrain: true, run: scenarioCodexPluginInstall },
  'grok-install': { needsGbrain: true, run: scenarioGrokInstall },
  'opencode-install': { needsGbrain: true, run: scenarioOpencodeInstall },
  drive: { needsGbrain: true, run: scenarioDrive },
};

async function main(): Promise<void> {
  if (!ptySupported()) {
    log('this Bun lacks PTY (terminal:) support — upgrade Bun (engines.bun in package.json) before running dx scenarios');
    process.exit(2);
  }
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
