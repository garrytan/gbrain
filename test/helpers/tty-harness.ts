/**
 * Real-PTY TTY harness — the interactive sibling of agent-harness.ts.
 *
 * agent-harness.ts drives the REAL `claude` / `codex` binaries HEADLESSLY
 * (`claude -p`, `codex exec`) — perfect for pass/fail door proofs, blind to
 * everything a human actually experiences: pickers, spinners, silence windows,
 * permission dialogs, interview prompts, rendered copy. This harness spawns any
 * CLI (gbrain itself, `claude`, `codex`) under a REAL pseudo-terminal via Bun's
 * built-in `terminal:` spawn option (Bun >= 1.3.10, pinned in package.json
 * engines + CI), so the child renders exactly what a user's terminal shows —
 * and records WHEN every byte arrived, so "the user stared at a frozen screen
 * for 9 seconds" is a measurable artifact, not a vibe.
 *
 * Built for two consumers:
 *   1. DX-exploration runs (`scripts/dx-explore.ts`) — capture the fresh-user
 *      install funnel as timestamped transcripts for Don't-Make-Me-Think
 *      audits (stall report + verbatim rendered copy per step).
 *   2. PTY e2e tests — test/init-picker-pty.serial.test.ts and future
 *      siblings use the same waitFor/sendKey primitives (pattern adapted from
 *      gstack's test/helpers/claude-pty-runner.ts; no node-pty, no native
 *      modules).
 *
 * Hermeticity matches agent-harness.ts: every spawn goes through
 * hermeticChildEnv, so a DX run can NEVER see (or mutate) the operator's real
 * ~/.claude, ~/.codex, or ~/.gbrain unless the caller explicitly wires a
 * temp-dir override in.
 *
 * Pure helpers (stripAnsi, computeStalls, parseDriveCommand,
 * renderStallsReport, buildClaudeTuiSeed) are exported for the unit suite
 * (test/tty-harness.test.ts) — mostly pure describes, plus a
 * ptySupported()-gated live block that spawns real sh children.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { hermeticChildEnv, type HermeticEnvOpts } from './agent-harness.ts';

// ────────────────────────────────────────────────────────────────────────────
// 1. Pure text helpers
// ────────────────────────────────────────────────────────────────────────────

/** Strip ANSI escapes (CSI, OSC, charset selection, cursor save/restore) so
 *  pattern matching runs against the text a human would read. Same sequence
 *  classes the gstack PTY runner strips — cursor-POSITIONING escapes render
 *  visually as whitespace but leave no character behind, so matched copy can
 *  arrive with collapsed spacing ("ready to execute" → "readytoexecute").
 *  Match copy with that in mind. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[78=>]/g, '');
}

/** One captured PTY output burst. tMs is milliseconds since spawn. */
export interface PtyFrame {
  tMs: number;
  data: string;
}

/** A window of output silence long enough that a user would notice it. */
export interface Stall {
  /** ms since spawn when the silence began. */
  startMs: number;
  durationMs: number;
  /** Last visible (ANSI-stripped) text on screen when the silence began —
   *  what the user was staring at. '(no output yet)' for startup silence. */
  context: string;
}

/** Tail of the stripped cumulative buffer, trimmed for a stall report. */
function stallContext(cumulative: string): string {
  const visible = stripAnsi(cumulative);
  const lines = visible.split('\n').map((l) => l.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.slice(-4).join('\n').slice(-400);
}

/**
 * Find every output gap >= thresholdMs (default 2000) in a frame sequence.
 * Counts three gap kinds a user actually experiences:
 *   - startup silence: spawn → first byte
 *   - mid-run silence: between consecutive frames
 *   - trailing silence: last byte → endMs (pass the session duration to count
 *     "it printed a question and then sat there" at the end of a run)
 */
export function computeStalls(
  frames: readonly PtyFrame[],
  opts: { thresholdMs?: number; endMs?: number } = {},
): Stall[] {
  const threshold = opts.thresholdMs ?? 2000;
  const stalls: Stall[] = [];
  let cumulative = '';

  if (frames.length === 0) {
    if (opts.endMs !== undefined && opts.endMs >= threshold) {
      stalls.push({ startMs: 0, durationMs: opts.endMs, context: '(no output yet)' });
    }
    return stalls;
  }

  const first = frames[0]!;
  if (first.tMs >= threshold) {
    stalls.push({ startMs: 0, durationMs: first.tMs, context: '(no output yet)' });
  }
  cumulative += first.data;

  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]!;
    const cur = frames[i]!;
    const gap = cur.tMs - prev.tMs;
    if (gap >= threshold) {
      stalls.push({ startMs: prev.tMs, durationMs: gap, context: stallContext(cumulative) });
    }
    cumulative += cur.data;
  }

  if (opts.endMs !== undefined) {
    const last = frames[frames.length - 1]!;
    const gap = opts.endMs - last.tMs;
    if (gap >= threshold) {
      stalls.push({ startMs: last.tMs, durationMs: gap, context: stallContext(cumulative) });
    }
  }

  return stalls;
}

/** Markdown stall report for a transcript dir — the audit-facing artifact. */
export function renderStallsReport(stalls: readonly Stall[], totalMs: number): string {
  const header =
    `# Stall report\n\n` +
    `Total session: ${(totalMs / 1000).toFixed(1)}s. ` +
    `${stalls.length} silence window(s) a user would notice.\n`;
  if (stalls.length === 0) return header + '\nNo stalls at threshold.\n';
  const body = stalls
    .map(
      (s, i) =>
        `\n## Stall ${i + 1}: ${(s.durationMs / 1000).toFixed(1)}s at t+${(s.startMs / 1000).toFixed(1)}s\n\n` +
        'Screen when the silence began:\n\n```\n' +
        (s.context || '(blank screen)') +
        '\n```\n',
    )
    .join('');
  return header + body;
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Drive-mode control protocol (file-based, so a Conductor agent can steer
//    a live TUI across separate tool calls)
// ────────────────────────────────────────────────────────────────────────────

export const KEY_MAP = {
  Enter: '\r',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Esc: '\x1b',
  Tab: '\t',
  ShiftTab: '\x1b[Z',
  Space: ' ',
  Backspace: '\x7f',
  CtrlC: '\x03',
  CtrlD: '\x04',
} as const satisfies Record<string, string>;

/** Literal union of key names (not plain string) so sendKey('Entr') is a
 *  compile error in test code; drive mode's runtime-string path keeps the
 *  `| string` overload with its runtime throw. */
export type KeyName = keyof typeof KEY_MAP;

export type DriveCommand =
  | { kind: 'send'; data: string }
  | { kind: 'key'; key: string }
  | { kind: 'note'; text: string }
  | { kind: 'stop' };

/**
 * Parse one line of the drive-mode control channel (`input.jsonl`). Accepted
 * shapes — exactly one of:
 *   {"line": "text"}   → sends text + Enter (the common case)
 *   {"send": "raw text (include \r yourself for Enter)"}
 *   {"key": "Enter" | "Up" | ... (KEY_MAP names)}
 *   {"note": "free-text annotation recorded into the transcript timeline"}
 *   {"stop": true}
 * Raw control bytes inside the line are re-escaped before parsing — zsh's
 * builtin `echo` expands `\r` to a literal CR, which would otherwise make
 * the JSON unparseable and silently eat the command. Returns null for
 * malformed JSON, unknown keys, or unknown key names — drive mode skips
 * those lines loudly (stderr) instead of guessing.
 */
export function parseDriveCommand(line: string): DriveCommand | null {
  // Raw C0 control chars are never valid inside JSON strings; shells (zsh
  // echo, printf format strings) produce them from typed `\r`/`\n`/`\t`.
  // Re-escaping is strictly more accepting than rejecting the line.
  const sanitized = line.replace(/[\x00-\x1f]/g, (c) => {
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  });
  let obj: unknown;
  try {
    obj = JSON.parse(sanitized);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.line === 'string') {
    return { kind: 'send', data: rec.line.replace(/[\r\n]+$/, '') + '\r' };
  }
  if (typeof rec.send === 'string') return { kind: 'send', data: rec.send };
  if (typeof rec.key === 'string') {
    if (!(rec.key in KEY_MAP)) return null;
    return { kind: 'key', key: rec.key };
  }
  if (typeof rec.note === 'string') return { kind: 'note', text: rec.note };
  if (rec.stop === true) return { kind: 'stop' };
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Claude Code TUI seed config
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal `$CLAUDE_CONFIG_DIR/.claude.json` so an INTERACTIVE claude session
 * in a hermetic config dir skips first-run TUI prompts that would otherwise
 * hang an unattended DX run (shape adapted from gstack's hermetic-env.ts,
 * verified against claude 2.1.x):
 *   - hasCompletedOnboarding: suppresses theme/onboarding flow
 *   - customApiKeyResponses.approved (last 20 chars): suppresses the
 *     "use this API key?" prompt when a key is exported
 *   - projects[dir].hasTrustDialogAccepted: pre-trusts the workspace
 * Callers auditing FIRST-RUN friction itself should skip the seed on purpose.
 */
export function buildClaudeTuiSeed(opts: {
  apiKey?: string;
  trustedDirs: string[];
}): Record<string, unknown> {
  const seed: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    projects: Object.fromEntries(
      opts.trustedDirs.map((dir) => [
        dir,
        { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      ]),
    ),
  };
  if (opts.apiKey) {
    seed.customApiKeyResponses = { approved: [opts.apiKey.slice(-20)] };
  }
  return seed;
}

/** Write the seed into a hermetic CLAUDE_CONFIG_DIR. */
export function seedClaudeTuiConfig(
  configDir: string,
  opts: { apiKey?: string; trustedDirs: string[] },
): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, '.claude.json'),
    JSON.stringify(buildClaudeTuiSeed(opts), null, 2),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 4. The PTY session
// ────────────────────────────────────────────────────────────────────────────

export interface TtyLaunchOpts {
  cwd?: string;
  /** Terminal size. 120x40 default — TUIs lay out cleanly at this size. */
  cols?: number;
  rows?: number;
  /** Env overrides layered LAST onto the hermetic base (HOME, GBRAIN_HOME,
   *  CLAUDE_CONFIG_DIR, CODEX_HOME, API keys the scenario needs...). */
  env?: Record<string, string | undefined>;
  /** Extra allowlist entries for hermeticChildEnv (e.g. ['OPENAI_API_KEY',
   *  'CODEX_*'] for a codex child). */
  extraAllow?: HermeticEnvOpts['extraAllow'];
  /** Names to DELETE from the final env (applied after overrides). The
   *  hermetic base deliberately passes auth keys through — a true-keyless DX
   *  run must strip them, and overrides can't unset (undefined is skipped). */
  dropEnv?: string[];
  /** Wall-clock kill switch. Default 15 min. */
  timeoutMs?: number;
  /** Observer for every output burst (for callers that want to stream frames
   *  somewhere as they arrive; saveTranscript already persists them at end). */
  onFrame?: (frame: PtyFrame) => void;
}

export interface TtySession {
  argv: readonly string[];
  /** Date.now() at spawn — pair with frame tMs for absolute timestamps. */
  startedAtMs: number;
  send(data: string): void;
  sendKey(key: KeyName | string): void;
  /** Raw accumulated output (with ANSI). Forensics + replay. */
  raw(): string;
  /** ANSI-stripped output for pattern matching / human reading. */
  visible(): string;
  /** Timestamped output bursts captured so far. */
  frames(): readonly PtyFrame[];
  /** Mark current buffer position; visibleSince/waitFor can scope after it. */
  mark(): number;
  visibleSince(marker?: number): string;
  waitForAny(
    patterns: Array<RegExp | string>,
    opts?: { timeoutMs?: number; pollMs?: number; since?: number },
  ): Promise<{ matched: RegExp | string; index: number }>;
  waitFor(
    pattern: RegExp | string,
    opts?: { timeoutMs?: number; pollMs?: number; since?: number },
  ): Promise<void>;
  /** Resolve true once no output has arrived for quietMs (the screen has
   *  settled — a picker/question is likely waiting). Resolves true immediately
   *  if the process exited; false only on timeout. Never throws. */
  waitForQuiet(opts?: { quietMs?: number; timeoutMs?: number }): Promise<boolean>;
  /** Await process exit (bounded). Returns exit code or null if still alive. */
  waitForExit(timeoutMs?: number): Promise<number | null>;
  exited(): boolean;
  exitCode(): number | null;
  pid(): number | undefined;
  /** SIGINT, then SIGKILL after 2s. Safe to call repeatedly. */
  close(): Promise<void>;
}

/** Does this Bun expose the `terminal:` spawn option? Probed once. Callers
 *  (tests) skip PTY paths on false instead of hard-failing. */
let _ptySupport: boolean | null = null;
export function ptySupported(): boolean {
  if (_ptySupport !== null) return _ptySupport;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = (Bun as any).spawn(['true'], {
      terminal: { cols: 20, rows: 5, data() {} },
    });
    _ptySupport = typeof proc?.terminal?.write === 'function' || proc?.terminal !== undefined;
    try {
      proc.kill?.('SIGKILL');
    } catch {
      /* already gone */
    }
  } catch {
    _ptySupport = false;
  }
  return _ptySupport;
}

/**
 * Spawn argv under a real PTY with a hermetic env. The caller owns lifetime:
 * always `await session.close()` (or waitForExit) — the wall timer is a
 * backstop, not a lifecycle.
 */
export function launchTty(argv: string[], opts: TtyLaunchOpts = {}): TtySession {
  if (argv.length === 0) throw new Error('launchTty: empty argv');
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 40;
  const timeoutMs = opts.timeoutMs ?? 900_000;
  const startedAtMs = Date.now();

  let buffer = '';
  const frames: PtyFrame[] = [];
  let lastFrameAt = 0; // ms since spawn; 0 until first byte
  let exited = false;
  let exitCodeCaptured: number | null = null;

  const childEnv = hermeticChildEnv(opts.env ?? {}, { extraAllow: opts.extraAllow });
  for (const k of opts.dropEnv ?? []) delete childEnv[k];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (Bun as any).spawn(argv, {
    terminal: {
      cols,
      rows,
      data(_t: unknown, chunk: Buffer) {
        const frame: PtyFrame = { tMs: Date.now() - startedAtMs, data: chunk.toString('utf-8') };
        buffer += frame.data;
        frames.push(frame);
        lastFrameAt = frame.tMs;
        try {
          opts.onFrame?.(frame);
        } catch {
          /* observer errors never kill the session */
        }
      },
    },
    cwd: opts.cwd ?? process.cwd(),
    env: childEnv,
  });

  let exitedPromise: Promise<void> = Promise.resolve();
  if (proc.exited && typeof proc.exited.then === 'function') {
    exitedPromise = proc.exited
      .then((code: number | null) => {
        exitCodeCaptured = code;
        exited = true;
      })
      .catch(() => {
        exited = true;
      });
  }

  /**
   * Best-effort kill of the child's whole process TREE, not just the parent.
   * A PTY child (claude/codex/a shell) is normally the session/group leader of
   * its pty, so `process.kill(-pid, sig)` reaches its descendants (MCP servers,
   * sub-shells) — otherwise SIGKILL to the parent orphans them, leaking API
   * spend and PGLite locks. If the child isn't a group leader the negative-pid
   * kill throws (EPERM/ESRCH) and we fall back to killing the parent alone.
   */
  function killTree(sig: NodeJS.Signals): void {
    const pid = proc.pid as number | undefined;
    if (typeof pid === 'number') {
      try {
        process.kill(-pid, sig);
        return;
      } catch {
        /* not a group leader — fall through to parent-only */
      }
    }
    try {
      proc.kill?.(sig);
    } catch {
      /* already dead */
    }
  }

  const wallTimer = setTimeout(() => killTree('SIGKILL'), timeoutMs);

  function send(data: string): void {
    if (exited) return;
    try {
      proc.terminal?.write?.(data);
    } catch {
      /* ignore */
    }
  }

  function sendKey(key: KeyName | string): void {
    const seq = (KEY_MAP as Record<string, string>)[key];
    if (seq === undefined) throw new Error(`sendKey: unknown key ${JSON.stringify(key)}`);
    send(seq);
  }

  let lastMark = 0;
  function mark(): number {
    lastMark = buffer.length;
    return lastMark;
  }

  function visibleSince(marker?: number): string {
    return stripAnsi(buffer.slice(marker ?? lastMark));
  }

  async function waitForAny(
    patterns: Array<RegExp | string>,
    waitOpts?: { timeoutMs?: number; pollMs?: number; since?: number },
  ): Promise<{ matched: RegExp | string; index: number }> {
    const wTimeout = waitOpts?.timeoutMs ?? 60_000;
    const poll = waitOpts?.pollMs ?? 200;
    const since = waitOpts?.since;
    const start = Date.now();
    for (;;) {
      // Bounded per-poll strip: under a repaint-heavy TUI the (since-scoped)
      // buffer grows by MBs, and re-stripping all of it every poll is the
      // quadratic hot loop this harness's consumers keep re-finding. A 256KB
      // tail caps per-poll work while staying far wider than any single
      // screen repaint; a pattern would have to scroll >256KB past between
      // two 200ms polls to be missed.
      const windowStart = Math.max(since ?? 0, buffer.length - 262_144);
      const visible = stripAnsi(buffer.slice(windowStart));
      for (let i = 0; i < patterns.length; i++) {
        const p = patterns[i]!;
        const idx = typeof p === 'string' ? visible.indexOf(p) : visible.search(p);
        if (idx >= 0) return { matched: p, index: idx };
      }
      if (exited) {
        throw new Error(
          `process exited (code=${exitCodeCaptured}) before any pattern matched. ` +
            `Last visible:\n${stripAnsi(buffer).slice(-2000)}`,
        );
      }
      if (Date.now() - start >= wTimeout) {
        throw new Error(
          `Timed out after ${wTimeout}ms waiting for any of: ${patterns
            .map((p) => (typeof p === 'string' ? JSON.stringify(p) : p.source))
            .join(', ')}\nLast visible:\n${stripAnsi(buffer).slice(-2000)}`,
        );
      }
      await Bun.sleep(poll);
    }
  }

  async function waitFor(
    pattern: RegExp | string,
    waitOpts?: { timeoutMs?: number; pollMs?: number; since?: number },
  ): Promise<void> {
    await waitForAny([pattern], waitOpts);
  }

  async function waitForQuiet(quietOpts?: {
    quietMs?: number;
    timeoutMs?: number;
  }): Promise<boolean> {
    const quietMs = quietOpts?.quietMs ?? 1500;
    const wTimeout = quietOpts?.timeoutMs ?? 120_000;
    const start = Date.now();
    for (;;) {
      if (exited) return true;
      const sinceLast = Date.now() - startedAtMs - lastFrameAt;
      if (frames.length > 0 && sinceLast >= quietMs) return true;
      if (Date.now() - start >= wTimeout) return false;
      await Bun.sleep(100);
    }
  }

  async function waitForExit(exitTimeoutMs?: number): Promise<number | null> {
    await Promise.race([exitedPromise, Bun.sleep(exitTimeoutMs ?? timeoutMs)]);
    return exitCodeCaptured;
  }

  async function close(): Promise<void> {
    clearTimeout(wallTimer);
    if (exited) return;
    killTree('SIGINT');
    await Promise.race([exitedPromise, Bun.sleep(2000)]);
    if (!exited) {
      killTree('SIGKILL');
      await Promise.race([exitedPromise, Bun.sleep(1000)]);
    }
  }

  return {
    argv,
    startedAtMs,
    send,
    sendKey,
    raw: () => buffer,
    visible: () => stripAnsi(buffer),
    frames: () => frames,
    mark,
    visibleSince,
    waitForAny,
    waitFor,
    waitForQuiet,
    waitForExit,
    exited: () => exited,
    exitCode: () => exitCodeCaptured,
    pid: () => proc.pid as number | undefined,
    close,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 5. Transcript persistence — the audit-facing artifact bundle
// ────────────────────────────────────────────────────────────────────────────

export interface TranscriptMeta {
  scenario: string;
  argv: readonly string[];
  startedAtIso: string;
  exitCode: number | null;
  durationMs: number;
  notes?: string[];
  [k: string]: unknown;
}

/**
 * Minimum secret-value length the redaction machinery acts on. Shorter values
 * are too collision-prone to blank out (a 3-char "key" would redact innocent
 * substrings across the transcript). Shared by redactSecrets, dx-explore's
 * buildRedactMap, and assertNoSecrets — one constant so the layers can never
 * disagree about what counts as a redactable secret.
 */
export const MIN_REDACT_SECRET_LEN = 8;

/**
 * Replace every occurrence of each secret VALUE with `[REDACTED:<name>]`.
 * Pure, single pass per secret over the whole string. NOTE: this only
 * catches CONTIGUOUS occurrences — a value split across PTY frame records
 * stays split in the serialized frames.jsonl (every frame boundary is a JSON
 * record boundary), which is why saveTranscript coalesces straddling frames
 * BEFORE serialization (coalesceSecretStraddles below).
 */
export function redactSecrets(text: string, redact?: Record<string, string>): string {
  if (!redact) return text;
  let out = text;
  for (const [name, value] of Object.entries(redact)) {
    if (!value || value.length < MIN_REDACT_SECRET_LEN) continue;
    out = out.split(value).join(`[REDACTED:${name}]`);
  }
  return out;
}

/**
 * Merge any run of frames that a secret value straddles into one frame, so a
 * subsequent per-string redaction pass sees the value contiguously. Without
 * this, a key split across two output bursts survives frames.jsonl as two
 * innocent-looking halves that are trivially joinable (verified empirically
 * in review). Pure: returns a new array; timing of the merged frame is the
 * first covered frame's tMs.
 */
export function coalesceSecretStraddles(
  frames: readonly PtyFrame[],
  redact?: Record<string, string>,
): PtyFrame[] {
  const values = Object.values(redact ?? {}).filter((v) => v && v.length >= MIN_REDACT_SECRET_LEN);
  if (values.length === 0 || frames.length === 0) return [...frames];

  // Frame start offsets in the joined stream.
  const starts: number[] = new Array(frames.length);
  let acc = 0;
  for (let i = 0; i < frames.length; i++) {
    starts[i] = acc;
    acc += frames[i]!.data.length;
  }
  const joined = frames.map((f) => f.data).join('');

  // Mark every frame boundary that falls INSIDE a secret occurrence:
  // mergeWithNext[i] = the boundary between frame i and i+1 must go away.
  const mergeWithNext = new Array<boolean>(frames.length - 1).fill(false);
  let anyMerge = false;
  for (const value of values) {
    let idx = joined.indexOf(value);
    while (idx >= 0) {
      const end = idx + value.length; // exclusive
      for (let b = 0; b < mergeWithNext.length; b++) {
        const boundary = starts[b + 1]!;
        if (boundary > idx && boundary < end) {
          mergeWithNext[b] = true;
          anyMerge = true;
        }
      }
      idx = joined.indexOf(value, idx + 1);
    }
  }
  if (!anyMerge) return [...frames];

  const out: PtyFrame[] = [];
  let i = 0;
  while (i < frames.length) {
    let data = frames[i]!.data;
    const tMs = frames[i]!.tMs;
    let j = i;
    while (j < mergeWithNext.length && mergeWithNext[j]) {
      data += frames[j + 1]!.data;
      j++;
    }
    out.push({ tMs, data });
    i = j + 1;
  }
  return out;
}

/**
 * Write a transcript bundle into `dir`:
 *   meta.json     — scenario, argv, timing, exit code, notes
 *   raw.txt       — full output with ANSI (replayable)
 *   visible.txt   — ANSI-stripped (grep/read this one)
 *   frames.jsonl  — one {tMs, data} per output burst (timing analysis)
 *   stalls.md     — the rendered silence report (thresholdMs = 2000)
 */
export function saveTranscript(
  dir: string,
  data: {
    frames: readonly PtyFrame[];
    raw: string;
    meta: TranscriptMeta;
    /** Secret values to redact (name → value) from EVERY written artifact.
     *  The explicit seam: callers own which values are secret. */
    redact?: Record<string, string>;
  },
): void {
  fs.mkdirSync(dir, { recursive: true });
  const r = (s: string) => redactSecrets(s, data.redact);
  fs.writeFileSync(path.join(dir, 'meta.json'), r(JSON.stringify(data.meta, null, 2)));
  fs.writeFileSync(path.join(dir, 'raw.txt'), r(data.raw));
  fs.writeFileSync(path.join(dir, 'visible.txt'), r(stripAnsi(data.raw)));
  // A secret split across PTY frames is two innocent halves in frames.jsonl
  // (every frame boundary is a JSON record boundary — the serialized string
  // never contains the contiguous value). Coalesce straddling frames FIRST,
  // then redact; per-frame timing granularity is lost only for the merged run.
  const coalesced = coalesceSecretStraddles(data.frames, data.redact);
  fs.writeFileSync(
    path.join(dir, 'frames.jsonl'),
    r(coalesced.map((f) => JSON.stringify(f)).join('\n') + (coalesced.length ? '\n' : '')),
  );
  const stalls = computeStalls(data.frames, { endMs: data.meta.durationMs });
  fs.writeFileSync(path.join(dir, 'stalls.md'), r(renderStallsReport(stalls, data.meta.durationMs)));
}
