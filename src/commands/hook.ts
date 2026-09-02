/**
 * hook.ts — `gbrain hook <event>`: the harness-side hook command
 * (agent-bootstrap plan: D5, A3, A9, G3, G4, G15, B3, B4, ENG-1, S3#2,
 * S3#7, S3#8).
 *
 * ENGINE-FREE BY CONSTRUCTION (plan D5): `gbrain serve` holds the PGLite
 * single-writer lock for its lifetime, so this command NEVER imports an
 * engine or connectEngine — config comes from `loadConfig()` only, per-turn
 * context comes from serve's resolve-IPC unix socket (requestTurnContext),
 * and everything else is plain file reads/writes. Registered in cli.ts's
 * no-engine dispatch branch (CLI_ONLY + handleCliOnly, before the
 * connectEngine terminator) and must never enter THIN_CLIENT_REFUSED
 * [ENG-2].
 *
 * FAIL-OPEN CONTRACT: a hook failure must never break the user's session.
 * Every event exits 0 (empty stdout on failure) and records a heartbeat
 * line; only a CLI usage error (unknown event) exits non-zero. The
 * `GBRAIN_HOOKS=0` env kill switch short-circuits every event.
 *
 * HEARTBEAT [S3#7, B3]: append-JSONL at
 * `<gbrain home>/integrations/hooks/heartbeat.jsonl` — counters, durations,
 * and error CODES only, never prompt/fact/slug text. Dir 0700, file capped
 * at HEARTBEAT_MAX_LINES (tail-rewrite). `readHeartbeatTail` is the
 * doctor/status read surface.
 *
 * Events:
 *   session-start  digest to stdout from FILE reads only (≤1.5s) [A3,G4,B3,B4]
 *   user-prompt    stdin hook JSON → IPC turn_context → additionalContext
 *                  JSON on stdout (≤800ms, ≤10000 chars) [ENG-1,S3#8,A9]
 *   stop           append to the per-session live buffer + 7-day GC [G15]
 *   session-end    transcript → secret-scanned corpus file, retention prune,
 *                  parser-drift detection, detached background workspace push
 *                  [S3#2,G3,G15]
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { ensureGbrainHome, resolveGbrainHome } from '../core/gbrain-home.ts';
import { loadConfig, type GBrainConfig } from '../core/config.ts';
import {
  IPC_UNAVAILABLE,
  readIpcSecretForConfig,
  requestTurnContext,
  requestContextPack,
  resolveSocketPathForConfig,
  CONTEXT_PACK_CLIENT_TIMEOUT_MS,
  type TurnContextResponse,
  type ContextPackResponse,
} from '../core/context/resolve-ipc.ts';
import type { WindowTurn } from '../core/context/entity-salience.ts';
import {
  confineTranscriptPath,
  parseTranscript,
  toCorpusText,
} from '../core/transcripts/claude-code-jsonl.ts';
import {
  bankCompactSegment,
  bankWritebackTurn,
  decideCorpusMode,
  gcCorpusArtifacts,
  HARVEST_RECEIPT_SUFFIX,
  segmentHash,
} from '../core/context/corpus-segments.ts';
import { gateWritebackTurn, WRITEBACK_SKIP_REASONS } from '../core/facts/writeback-gate.ts';
import { resolveWritebackConfigFromFile } from '../core/facts/writeback-config.ts';
import { memorableGateAllowed, recordAndRelayReceipt, redactedToolCallsJson } from '../core/context/hook-heartbeat.ts';
import { captureSpecFor } from '../core/transcripts/capture-spec.ts';
import {
  heartbeatPath,
  hookStatusPath,
  readHeartbeatTail,
  writeHeartbeat as writeHeartbeatShared,
  type HookHeartbeatEntry,
} from '../core/context/hook-heartbeat.ts';
import { CLAUDE_HOOK_OUTPUT_CAP_CHARS } from '../core/bootstrap/host-specs.ts';
import { readManifest, readReceipt, type InstallReceipt } from '../core/bootstrap/format.ts';
import { githubOwnerRepoString } from '../core/repo-visibility.ts';
import { detectExecutionEnvironment } from '../core/execution-env.ts';
import {
  readPushStatuses,
  readPushStatusForRoot,
  sanitizePushReason,
  summarizePushStatuses,
  workspaceRootHash,
} from '../core/workspace-push.ts';
import {
  backupCheckDisabled,
  backupNagGate,
  backupNoticeText,
  backupSpawnDue,
  isBackupStatusStale,
  loadBackupStatus,
  recordBackupSpawn,
} from '../core/backup/status-file.ts';
import { realpathOrResolve } from '../core/path-confine.ts';

// ── Tunables ────────────────────────────────────────────────────────────────

/** session-start self-deadline (plan D5). */
export const SESSION_START_DEADLINE_MS = 1500;
/** user-prompt hard self-deadline (plan D5/ENG-1). */
export const USER_PROMPT_DEADLINE_MS = 800;
/** MEMORY.md digest budget [A3]. */
export const DIGEST_MEMORY_CAP_BYTES = 3072;
/** Digest-eligible MEMORY.md sections [A3] — matched case-insensitively. */
export const DIGEST_SECTIONS = ['standing rules', 'open commitments', 'active context'];
/** Stop-buffer retention [G15]. */
export const STOP_BUFFER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Ambient-writeback Stop step's own deadline (WP4): well inside Stop's 10s
 * harness cap, alongside (not inside) the push step's 3s. Fail-open always. */
export const WRITEBACK_STOP_DEADLINE_MS = 2000;
/** Newest-tail read for locating the last user turn — one turn never needs
 * the 2MB user-prompt window, and this lane pays the parse EVERY Stop. */
export const WRITEBACK_TRANSCRIPT_TAIL_BYTES = 128 * 1024;
/** Default corpus retention when `dream.synthesize.corpus_retention_days` is unset [G15]. */
export const CORPUS_RETENTION_DAYS_DEFAULT = 30;
/**
 * Sweep sidecar suffixes — DUPLICATED from sweep.ts on purpose: hook.ts is
 * engine-free by construction (module header D5), and sweep.ts eagerly imports
 * capability.ts, so a value-import here would drag that in. A corpus (re)write
 * MUST invalidate any prior completion/claim marker so the serve sweep
 * re-ingests the appended transcript of a resumed session (otherwise the new
 * turns are skipped forever). Keep these in sync with sweep.ts's
 * CORPUS_INGESTED_SUFFIX / CORPUS_CLAIM_SUFFIX.
 */
export const CORPUS_INGESTED_SUFFIX = '.ingested';
export const CORPUS_CLAIM_SUFFIX = '.in-progress';
/** Trailing-window size for the B3 failure-rate notice. */
export const HEARTBEAT_FAILURE_WINDOW = 20;
/**
 * Trailing-window hard-error rate that trips the B3 digest notice AND the
 * doctor `bootstrap_hooks_heartbeat` fail (doctor imports this — one source).
 */
export const HEARTBEAT_FAILURE_RATE_THRESHOLD = 0.5;
/** Push-staleness threshold [B4] — shared with doctor's bootstrap_push_health. */
export const PUSH_STALE_MS = 48 * 60 * 60 * 1000;
/** user-prompt window: transcript turns fed to turn_context (plan D5: last 4). */
const USER_PROMPT_WINDOW_TURNS = 4;
/** Dedupe-input budget: newest injected blocks kept under this cap so the
 * IPC request can never blow the 256KB message cap on priorContextText. */
export const PRIOR_CONTEXT_MAX_BYTES = 32 * 1024;
/** user-prompt transcript parse budget (tail bytes — the window only needs the newest turns). */
const USER_PROMPT_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;
/** stop-hook push [D3]: hard budget for the debounce decision + detached spawn
 * (the spawn itself is instant; the budget bounds the two 1s git probes). */
const STOP_PUSH_DEADLINE_MS = 3000;
/** stop-hook push debounce default (minutes) for local + ephemeral-container
 * environments; cloud-sandbox defaults to 0 (every turn) — a reclaimed VM's
 * tail loss is permanent, everywhere else SessionStart recovery covers it [D17]. */
export const STOP_PUSH_DEBOUNCE_MIN_DEFAULT = 5;
/** failure banner [D19]: re-announce floor while the same failure persists. */
export const PUSH_ANNOUNCE_REFIRE_MS = 30 * 60 * 1000;
/** failure banner budget (well under ENG-1's whole-payload cap). */
const PUSH_BANNER_MAX_CHARS = 300;

// ── Test seam ───────────────────────────────────────────────────────────────

/**
 * In-process I/O seam. The CLI wiring calls `runHook(args)` with none of
 * these set; tests inject stdin/stdout/cwd (and a transcript confinement
 * root) so the full stdin→stdout contract runs without subprocesses.
 * `transcriptRoot` is intentionally NOT env-configurable — the S3#8
 * confinement root must not be widenable by whatever spawned the hook.
 */
export interface HookIo {
  /** Injected stdin body; undefined → read process.stdin (non-TTY only). */
  stdin?: string;
  /** Injected stdout sink; default process.stdout.write. */
  write?: (s: string) => void;
  /** Workspace dir override; default stdin JSON `cwd` → process.cwd(). */
  cwd?: string;
  /** TEST SEAM: transcript confinement root (default ~/.claude/projects). */
  transcriptRoot?: string;
  /**
   * TEST SEAM: detached-push spawner (default spawnDetachedPush). Receives the
   * gated bootstrap workspace root; throwing marks the push unavailable.
   */
  spawnPush?: (root: string) => void;
  /** TEST SEAM: detached backup-check spawner (default spawnDetachedBackupCheck). */
  spawnBackupCheck?: () => void;
  /** TEST SEAM: user-prompt deadline override (wall-clock flake control). */
  userPromptDeadlineMs?: number;
  /** TEST SEAM: compact deadline override (drives the per-step degrade paths). */
  compactDeadlineMs?: number;
  /**
   * TEST SEAM (v0.46.15, BrainBench production seam): config override for
   * hookUserPrompt — `undefined` = load the real file-plane config;
   * `null`/object = use as-is. Lets the bench point the hook at a throwaway
   * brain WITHOUT mutating process-global GBRAIN_HOME (parallel-test safe).
   */
  configOverride?: GBrainConfig | null;
  /**
   * TEST SEAM (v0.46.15): suppress the pending-push failure banner. The
   * banner reads the OPERATOR's real push-status files — on a bench run
   * that's environmental contamination (a locally-failing push would inject
   * a banner on stay-silent turns and read as a false fire).
   */
  disablePushBanner?: boolean;
  /**
   * TEST SEAM (v0.46.15, codex ship-review): suppress hook telemetry WRITES
   * (heartbeat JSONL). Telemetry paths resolve from GBRAIN_HOME/homedir —
   * NOT from configOverride — so a hermetic bench replay would otherwise
   * append every fixture turn to the operator's real hook-health history.
   */
  disableTelemetry?: boolean;
  /**
   * Feedback-loop attribution channel (`--harness <claude-code|codex|opencode>`).
   * Default 'claude-code' — the only harness bootstrap registers hooks for
   * today; a codex/opencode hook registration passes the flag explicitly.
   */
  harness?: 'claude-code' | 'codex' | 'opencode';
}

// ── Entry point ─────────────────────────────────────────────────────────────

const USAGE = `Usage: gbrain hook <event>

Events (wired into .claude/settings.local.json by gbrain bootstrap):
  session-start   print the greeting digest (MEMORY.md sections, last session,
                  push status, hook health) to stdout
  user-prompt     read hook JSON on stdin, request per-turn context from a
                  running 'gbrain serve' over IPC, print additionalContext JSON
                  (--harness <claude-code|codex|opencode> sets the feedback-loop
                  channel; default claude-code, unknown values fall back to the default)
  stop            append to the per-session live buffer
  session-end     ingest the session transcript into the dream corpus
                  (secret-scanned), prune old corpus files, push the workspace
  compact         (PreCompact) bank the window's standing entities into the
                  session cursor so the post-compaction session-start serves
                  a warm context pack; emits nothing

Env: GBRAIN_HOOKS=0 disables all events (immediate exit 0).
All events fail open: errors exit 0 with empty stdout and a heartbeat entry at
<gbrain home>/integrations/hooks/heartbeat.jsonl.`;

/** Dispatch a hook event. Returns the process exit code (0 for every runtime path). */
export async function runHook(args: string[], io: HookIo = {}): Promise<number> {
  const event = args[0];
  if (event === '--help' || event === '-h' || event === 'help') {
    write(io, USAGE + '\n');
    return 0;
  }
  // `--harness <claude-code|codex|opencode>` — feedback-loop channel
  // attribution for user-prompt. Unknown values fall back to the default
  // (fail-open: a bad registration must never break the hook contract).
  const harnessIdx = args.indexOf('--harness');
  if (harnessIdx >= 0 && !io.harness) {
    const v = args[harnessIdx + 1];
    if (v === 'claude-code' || v === 'codex' || v === 'opencode') io = { ...io, harness: v };
  }
  if (!event || !['session-start', 'user-prompt', 'stop', 'session-end', 'compact'].includes(event)) {
    process.stderr.write(USAGE + '\n');
    return 1;
  }
  // Kill switch — before any file/socket touch, no heartbeat (the user asked
  // for silence, and a disabled hook writing telemetry would be a lie).
  if (process.env.GBRAIN_HOOKS === '0') return 0;

  // #4043 harness-lane defer guard: Claude Code MERGES user- and
  // project-scope hook settings, so a machine wired by `bootstrap harness`
  // (user scope) plus a real workspace bootstrap install (settings.local.json,
  // bootstrap-v1 marker) would fire the same event twice. The workspace
  // install wins; the harness lane yields silently (exit 0, no output, no
  // heartbeat). Same cwd resolution as the handlers (io.cwd is the test
  // seam; the harness runs hooks in the session's working dir). Fail-open:
  // any read hiccup means run normally.
  if (process.env.GBRAIN_HOOK_LANE === 'harness') {
    try {
      // BOTH workspace carriers count: settings.local.json (local installs)
      // and the committed .claude/settings.json ([D12] — an event owned by
      // the committed carrier is stripped from local, so checking only local
      // would double-fire it against the user-scope harness wiring). The
      // check PARSES the settings and requires a live bootstrap-v1 hook entry
      // wiring THIS event — a raw substring match would let any repo disable
      // the machine-wide capture lane by committing the two marker strings in
      // an unrelated field (ship-review P1), and would over-yield events the
      // workspace does not actually wire.
      const eventKey = {
        'session-start': 'SessionStart',
        'user-prompt': 'UserPromptSubmit',
        stop: 'Stop',
        'session-end': 'SessionEnd',
        compact: 'PreCompact',
      }[event];
      const dotClaude = join(io.cwd ?? process.cwd(), '.claude');
      for (const file of ['settings.local.json', 'settings.json']) {
        const p = join(dotClaude, file);
        if (!existsSync(p)) continue;
        const settings = JSON.parse(readFileSync(p, 'utf8')) as {
          hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>>;
        };
        const groups = settings.hooks?.[eventKey ?? ''];
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          if (!Array.isArray(g?.hooks)) continue;
          if (g.hooks.some((e) => e?._gbrain === 'bootstrap-v1')) return 0;
        }
      }
    } catch {
      /* fail-open */
    }
  }

  switch (event) {
    case 'session-start':
      return hookSessionStart(io);
    case 'user-prompt':
      return hookUserPrompt(io);
    case 'stop':
      return hookStop(io);
    case 'session-end':
      return hookSessionEnd(io);
    case 'compact':
      return hookCompact(io);
    default:
      return 1; // unreachable
  }
}

// ── Shared plumbing ─────────────────────────────────────────────────────────

function write(io: HookIo, s: string): void {
  if (io.write) io.write(s);
  else process.stdout.write(s);
}

const DEADLINE: unique symbol = Symbol('deadline');

function withDeadline<T>(ms: number, work: Promise<T>): Promise<T | typeof DEADLINE> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(DEADLINE), ms);
    (t as { unref?: () => void }).unref?.();
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(DEADLINE); // caller treats a rejection like a timeout: fail-open
      },
    );
  });
}

/** Read stdin (or the injected seam) and JSON-parse; null on anything else. */
async function readStdinJson(io: HookIo, timeoutMs: number): Promise<Record<string, unknown> | null> {
  let raw: string;
  if (io.stdin !== undefined) {
    raw = io.stdin;
  } else {
    raw = await readProcessStdin(timeoutMs);
  }
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readProcessStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(buf);
    };
    const t = setTimeout(finish, timeoutMs);
    (t as { unref?: () => void }).unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      buf += c;
      if (buf.length > 4 * 1024 * 1024) finish(); // hook payloads are small — cap defensively
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/**
 * Gbrain home resolver: the S3#10 choke point, statically imported [CX2-8].
 * Only the CALL is guarded — ensureGbrainHome throws solely when the create
 * fails, and resolveGbrainHome (pure path resolution, same semantics) is the
 * fail-open fallback; downstream writers under an uncreatable home fail into
 * their own swallow-and-heartbeat paths.
 */
async function resolveHome(): Promise<string> {
  try {
    return ensureGbrainHome();
  } catch {
    return resolveGbrainHome();
  }
}

function ensureDir0700(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  return dir;
}

function sanitizeSessionId(id: unknown): string {
  // Leading dashes are stripped so the id can never be parsed as a FLAG by a
  // downstream argv consumer (the detached memorable spawn passes it as a
  // positional value) — hook stdin is untrusted input.
  const s =
    typeof id === 'string' ? id.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 120) : '';
  return s && !/^\.+$/.test(s) ? s : 'unknown';
}

/** Reason strings must be CODES [S3#7] — clamp anything message-shaped. */
function reasonCode(reason: string): string {
  return /^[A-Za-z0-9_.:-]{1,48}$/.test(reason) ? reason : 'server_error';
}

function errorCode(e: unknown): string {
  const name = e instanceof Error ? e.constructor.name : typeof e;
  return reasonCode(`exception:${name}`);
}

// ── Heartbeat [S3#7, B3] ────────────────────────────────────────────────────
// Extracted to src/core/context/hook-heartbeat.ts (cathedral 5) so the
// serve-side checkpoint harvest appends outcome events without importing this
// command module. Re-exported here so every existing import site
// (doctor/status/verify/tests) keeps working unchanged.

export {
  HEARTBEAT_ALLOWED_KEYS,
  HEARTBEAT_MAX_LINES,
} from '../core/context/hook-heartbeat.ts';
export { heartbeatPath, hookStatusPath, readHeartbeatTail };
export type { HookHeartbeatEntry };

/**
 * Hook-side heartbeat writer: delegates to the shared module (cathedral 5 —
 * the serve harvest appends its own events there), honoring the BrainBench
 * telemetry seam (v0.46.15): a hermetic bench replay drives the REAL hook
 * in-process, and without this gate every fixture turn would append to the
 * operator's real hook-health history and skew doctor/failure-notice reads.
 */
async function writeHeartbeat(io: HookIo, entry: HookHeartbeatEntry): Promise<void> {
  if (io.disableTelemetry) return;
  await writeHeartbeatShared(entry);
}

// ── session-start [A3, G4, B3, B4] ──────────────────────────────────────────

async function hookSessionStart(io: HookIo): Promise<number> {
  const t0 = Date.now();
  let outcome: HookHeartbeatEntry['outcome'] = 'ok';
  let reason: string | undefined;
  const out: string[] = [];
  // Deferred nag records: fire ONLY after the digest actually reached stdout
  // (record-after-write — a deadline-suppressed note must re-fire next time).
  const deferredRecords: Array<() => void> = [];

  try {
    const j = await readStdinJson(io, 250);
    const ws = io.cwd ?? (typeof j?.cwd === 'string' ? (j.cwd as string) : process.cwd());

    const work = (async () => {
      // 1. MEMORY.md digest — allowlisted sections only, ≤3KB [A3].
      const digest = memoryDigest(join(ws, 'MEMORY.md'));
      if (digest) out.push(digest);

      // 2. Last-session line from the stop-buffer dir [G15 consumer].
      const last = await lastSessionLine();
      if (last) out.push(last);

      // 3. Push staleness [B4].
      const pushNote = await pushStatusNote();
      if (pushNote) out.push(pushNote);

      // 3b. Monthly backup-coverage note (cache read; bounded by the shared
      //     nag gate — dampener + per-channel ceiling + global monthly cap).
      const backupNote = backupSessionStartNote();
      if (backupNote) {
        out.push(backupNote.text);
        deferredRecords.push(backupNote.record);
      }

      // 4. Visible degradation [B3] + parser-drift status file [G3].
      const failNote = await hookFailureNotice();
      if (failNote) out.push(failNote);
      const statusNote = await statusFileNotice();
      if (statusNote) out.push(statusNote);

      // 5. Dirty-tree recovery push [G4] — bootstrap workspaces ONLY (the
      //    initialized agent.json manifest is the gate; `gbrain hook
      //    session-start` run in an arbitrary repo must never commit it).
      //    The push itself runs as a detached child; the hook only spawns.
      const dirty = await dirtyTreePush(ws, io);
      if (dirty) {
        if (dirty.note) out.push(dirty.note);
        if (dirty.reason && outcome === 'ok') {
          if (dirty.degraded) outcome = 'degraded';
          reason = reasonCode(dirty.reason);
        }
      }

      // 6. v0.45.7 ambient recall — boundary context pack over IPC. SessionStart
      //    is Claude Code's cold-start AND post-compaction re-entry point
      //    (source=compact/resume), so this one arm covers both. The server
      //    owns the intelligence (banked entities + since-cursor + advance);
      //    world-only always. Every failure is a silent skip — the file-only
      //    digest above must never be hostage to the brain being down.
      try {
        const cfg = loadConfig();
        // Engine-uniform (#4245): same config-keyed socket/secret resolution
        // as the user-prompt and compact arms (PGLite data dir; Postgres
        // hash12(database_url) run-dir). Null → silent skip, as before.
        const packSocket = resolveSocketPathForConfig(cfg);
        if (packSocket) {
          const secret = readIpcSecretForConfig(cfg);
          if (secret) {
            // Same sanitizer as the compact banking path — a raw vs sanitized
            // id would split the cursor key and the warm pack would miss the
            // banked entities (adversarial review).
            const sessionId = sanitizeSessionId(j?.session_id);
            const trigger = typeof j?.source === 'string' ? `session-start:${j.source as string}` : 'session-start';
            // Clamp the IPC timeout to the REMAINING hook deadline (minus a
            // 100ms write margin) so the pack call can never be the thing
            // that blows SESSION_START_DEADLINE_MS.
            const remaining = SESSION_START_DEADLINE_MS - (Date.now() - t0) - 100;
            if (remaining > 100) {
              const res = await requestContextPack(packSocket, {
                secret,
                ...(sessionId ? { sessionId } : {}),
                ...(process.env.GBRAIN_SOURCE ? { sourceId: process.env.GBRAIN_SOURCE } : {}),
                trigger,
              }, { timeoutMs: Math.min(CONTEXT_PACK_CLIENT_TIMEOUT_MS, remaining) });
              if (res !== IPC_UNAVAILABLE && !('degraded' in res)) {
                const pack = res as ContextPackResponse;
                if (pack.ok && pack.block?.text) out.push(pack.block.text);
              }
            }
          }
        }
      } catch { /* fail-open: no pack, digest stands alone */ }
    })();

    const res = await withDeadline(SESSION_START_DEADLINE_MS, work);
    if (res === DEADLINE && outcome === 'ok') {
      outcome = 'degraded';
      reason = 'deadline';
    }
    // Print whatever accumulated before the deadline — a partial digest
    // beats an empty one (the deadline bounds latency, not usefulness).
    const text = out.filter(Boolean).join('\n\n');
    if (text) {
      write(io, text + '\n');
      for (const record of deferredRecords) {
        try {
          record();
        } catch {
          /* fail-open — worst case the note re-fires */
        }
      }
    }
  } catch (e) {
    outcome = 'error';
    reason = errorCode(e); // fail-open: empty stdout, exit 0
  }
  await writeHeartbeat(io, {
    ts: new Date().toISOString(),
    event: 'session-start',
    outcome,
    ...(reason ? { reason } : {}),
    duration_ms: Date.now() - t0,
  });
  return 0;
}

/**
 * Extract the digest-eligible sections from MEMORY.md [A3]. Only headings in
 * DIGEST_SECTIONS qualify — the template's security-boundary note and every
 * other section stay out of injected context. Capped at
 * DIGEST_MEMORY_CAP_BYTES.
 */
export function memoryDigest(memoryPath: string): string | null {
  let raw: string;
  try {
    const st = statSync(memoryPath);
    if (!st.isFile() || st.size > 512 * 1024) return null; // malformed/huge — skip
    raw = readFileSync(memoryPath, 'utf8');
  } catch {
    return null;
  }
  const picked: string[] = [];
  let inSection = false;
  for (const line of raw.split('\n')) {
    const h = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      inSection = DIGEST_SECTIONS.includes(h[2].trim().toLowerCase());
      if (inSection) picked.push(line);
      continue;
    }
    if (inSection) picked.push(line);
  }
  const body = picked.join('\n').trim();
  if (!body) return null;
  let text = `From MEMORY.md:\n${body}`;
  if (Buffer.byteLength(text, 'utf8') > DIGEST_MEMORY_CAP_BYTES) {
    const cut = Buffer.from(text, 'utf8').subarray(0, DIGEST_MEMORY_CAP_BYTES - 2).toString('utf8');
    text = cut.replace(/�+$/, '') + '…';
  }
  return text;
}

async function liveBufferDir(): Promise<string> {
  const home = await resolveHome();
  ensureDir0700(join(home, 'transcripts'));
  return ensureDir0700(join(home, 'transcripts', 'live'));
}

async function lastSessionLine(): Promise<string | null> {
  try {
    const dir = await liveBufferDir();
    let newest: { path: string; mtime: number } | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.txt')) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (!newest || st.mtimeMs > newest.mtime) newest = { path: p, mtime: st.mtimeMs };
    }
    if (!newest) return null;
    const lines = readFileSync(newest.path, 'utf8').split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1];
    if (!last) return null;
    try {
      const e = JSON.parse(last) as { ts?: string; exchange?: string };
      const snippet = typeof e.exchange === 'string' ? ` — ${e.exchange.slice(0, 200)}` : '';
      return `Last session activity: ${e.ts ?? 'unknown time'}${snippet}`;
    } catch {
      return `Last session activity: ${last.slice(0, 200)}`;
    }
  } catch {
    return null;
  }
}

async function pushStatusNote(): Promise<string | null> {
  try {
    // One reader + one aggregation for every status surface [D8]; per-root
    // files [D13] so one workspace's success can't mask another's failure.
    const entries = readPushStatuses();
    if (entries.length === 0) return null;
    const { failing, stalestTs } = summarizePushStatuses(entries);
    if (failing.length > 0) {
      const e = failing[0]!;
      const which = e.repoRoot ? ` for ${e.repoRoot}` : '';
      const rest = failing.length > 1 ? ` [+${failing.length - 1} more workspace(s)]` : '';
      return `Workspace push${which} is FAILING (since ${e.ts ?? 'unknown'}): ${sanitizePushReason(e.reason)}${rest} — run gbrain doctor`;
    }
    if (stalestTs !== null && Date.now() - stalestTs > PUSH_STALE_MS) {
      return `Workspace push: last success ${new Date(stalestTs).toISOString()} (>48h ago) — recent work may be unpushed [B4]`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * [B3] Visible degradation: when >50% of the trailing-20 heartbeat entries
 * are hard errors, say so in the digest. Degraded entries (pull-mode
 * no_serve, stale_serve, …) are DESIGNED fallbacks and don't count — the
 * notice is for broken, not for absent.
 */
async function hookFailureNotice(): Promise<string | null> {
  const tail = await readHeartbeatTail(HEARTBEAT_FAILURE_WINDOW);
  if (tail.length === 0) return null;
  const failures = tail.filter((e) => e.outcome === 'error').length;
  if (failures / tail.length > HEARTBEAT_FAILURE_RATE_THRESHOLD) {
    return 'brain context unavailable for recent turns — run gbrain doctor';
  }
  return null;
}

const STATUS_NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function statusFileNotice(): Promise<string | null> {
  try {
    const p = await hookStatusPath();
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, 'utf8')) as { ts?: string; error?: string };
    const t = s.ts ? Date.parse(s.ts) : NaN;
    if (!Number.isFinite(t) || Date.now() - t > STATUS_NOTICE_MAX_AGE_MS) return null;
    return `Hook alert: ${s.error ?? 'unknown'} (${s.ts}) — transcript ingestion may be broken; run gbrain doctor`;
  } catch {
    return null;
  }
}

/** Per-git-command timeout for hook quick checks (bounds the child; the event loop stays free). */
const HOOK_GIT_TIMEOUT_MS = 1000;

/**
 * Async execFile wrapper: the hook push paths must NEVER block the event
 * loop with execFileSync — a slow repo/network would keep withDeadline's
 * timer from ever firing and stall the harness for minutes. null on any
 * failure (missing binary, non-zero exit, timeout).
 */
function tryExecAsync(bin: string, args: string[], timeoutMs = HOOK_GIT_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        args,
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : stdout.toString().trim()),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Resolve the bootstrap workspace root for a hook event: the git toplevel of
 * `ws`, gated on an `initialized` agent.json manifest at that root. The gate
 * is the security boundary — `gbrain hook <event>` run in an arbitrary repo
 * must never commit or push it. Shared by session-start and session-end.
 */
async function resolveBootstrapWorkspaceRoot(ws: string): Promise<string | null> {
  const root = await tryExecAsync('git', ['-C', ws, 'rev-parse', '--show-toplevel']);
  if (!root) return null;
  const manifest = readManifest(root);
  if (manifest.state !== 'initialized') return null; // not a bootstrap workspace
  return root;
}

/** owner/name from a github https/ssh remote URL, or null. Canonical parser
 * (repo-visibility.ts is engine-free, so the hook contract holds). */
function githubOwnerName(url: string): string | null {
  return githubOwnerRepoString(url);
}

/**
 * The no-daemon workspace push must NOT fire until the repo phase has verified
 * the origin's privacy and recorded `repo_url`. In a create-repo-first install
 * the origin exists (the clone) BEFORE the repo phase, and hooks are wired one
 * phase earlier — so an ungated session-end/recovery push could publish
 * workspace content to an as-yet-unverified (possibly public) remote. A recorded
 * `repo_url` means the repo phase completed against a verified-private remote.
 *
 * Bound to the recorded repo: the current origin — BOTH the fetch URL and the
 * push URL (`git push` uses the push URL when set) — must still resolve to the
 * same owner/name as `repo_url`, so a later `git remote set-url` can't redirect
 * the push to another (possibly public) repo. No receipt / no repo_url / a
 * changed origin → defer (fail-closed).
 */
async function repoPhaseComplete(root: string): Promise<boolean> {
  try {
    const receipt = readReceipt(resolveGbrainHome()) as (InstallReceipt & { repo_url?: string }) | null;
    if (!receipt || typeof receipt.repo_url !== 'string' || receipt.repo_url.length === 0) return false;
    if (realpathOrResolve(receipt.workspace_dir) !== realpathOrResolve(root)) return false;
    const want = githubOwnerName(receipt.repo_url);
    const fetchUrl = await tryExecAsync('git', ['-C', root, 'remote', 'get-url', 'origin']);
    // Push URL (remote.origin.pushurl) via the config key directly (no dash-flag):
    // unset → `git push` uses the fetch URL (already matched). Only a configured
    // push URL that points elsewhere blocks the push.
    const pushUrl = await tryExecAsync('git', ['-C', root, 'config', 'remote.origin.pushurl']);
    if (want) {
      if (githubOwnerName(fetchUrl ?? '') !== want) return false;
      return !pushUrl || githubOwnerName(pushUrl) === want;
    }
    // Non-github repo_url (self-hosted / explicitly-trusted transports): bind
    // by EXACT URL equality — the recorded url is what the repo phase (or the
    // operator) verified, and a later remote redirect must still block the
    // push. Without this branch, every non-github install's no-daemon push
    // deferred forever (post-#4024 regression).
    if ((fetchUrl ?? '').trim() !== receipt.repo_url) return false;
    return !pushUrl || pushUrl.trim() === receipt.repo_url;
  } catch {
    return false;
  }
}

/**
 * Fire-and-forget `gbrain sources push --path <root>` as a DETACHED child.
 * workspacePush must never run inline in a hook — its git chain is fully
 * synchronous (execFileSync) and would block the event loop past every
 * deadline. The child owns the push lock/status plumbing; the hook only
 * announces it. Throws when the child can't be spawned (caller degrades).
 */
function spawnDetachedPush(root: string): void {
  const exec = process.execPath ?? '';
  const pushArgs = ['sources', 'push', '--path', root];
  // Compiled binary: execPath IS gbrain. Dev (bun src/cli.ts): re-exec the
  // entrypoint — the jobs.ts --detach precedent.
  const argv = /[/\\]gbrain(\.exe)?$/.test(exec) ? pushArgs : [process.argv[1], ...pushArgs];
  const child = spawn(exec, argv, { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * [G4] Crashed-session recovery: dirty tree or unpushed commits at session
 * start → spawn the workspace push in the background (never inline). GATED
 * on the initialized-manifest bootstrap workspace root (the security
 * boundary — see resolveBootstrapWorkspaceRoot).
 */
async function dirtyTreePush(
  ws: string,
  io: HookIo,
): Promise<{ note?: string; reason?: string; degraded?: boolean } | null> {
  try {
    const root = await resolveBootstrapWorkspaceRoot(ws);
    if (!root) return null;
    if (!(await treeNeedsPush(root))) return null; // clean + up to date → nothing to recover
    // There IS unpushed work. Defer until the repo phase verified privacy +
    // recorded repo_url — never recover-push to an unverified origin
    // (create-repo-first race). Only fires when work actually exists (P2-1).
    if (!(await repoPhaseComplete(root))) {
      return {
        note: 'Unpushed work detected; will push after the repo phase completes (`gbrain bootstrap repo`).',
        reason: 'push_deferred_repo_pending',
      };
    }
    try {
      (io.spawnPush ?? spawnDetachedPush)(root);
      return {
        note: 'Unpushed work from a previous session detected — recovering unpushed work in background (gbrain sources push).',
        reason: 'push_spawned',
      };
    } catch {
      return {
        note: 'Unpushed work from a previous session detected; automatic push unavailable — run gbrain doctor',
        reason: 'push_unavailable',
        degraded: true,
      };
    }
  } catch {
    return null;
  }
}

/** True when the workspace has uncommitted changes or commits ahead of
 * upstream — shared by the SessionStart recovery push and the stop-hook
 * per-turn push. Two 1s-capped git probes; never throws. */
async function treeNeedsPush(root: string): Promise<boolean> {
  // Dirty tree → always needs a push. For "ahead", measure against the SAME
  // ref workspacePush targets (origin/<default-branch>), NOT @{u}: a branch
  // with no upstream makes `@{u}..HEAD` error → 0, which would report a clean
  // + committed-but-unpushed tree as push_clean and silently strand it (the
  // exact tail-loss the per-turn push exists to prevent). When the origin ref
  // doesn't resolve yet (never pushed), any commit past the empty tree counts
  // as needs-push.
  const status = await tryExecAsync('git', ['-C', root, 'status', '--porcelain']);
  if ((status ?? '') !== '') return true;
  const branch = await tryExecAsync('git', ['-C', root, 'branch', '--show-current']);
  const b = (branch ?? '').trim();
  if (b) {
    const ahead = await tryExecAsync('git', ['-C', root, 'rev-list', '--count', `origin/${b}..HEAD`]);
    if (ahead !== null) return (parseInt(ahead, 10) || 0) > 0;
    // origin/<b> doesn't exist (never pushed) → any local commit needs pushing.
    const have = await tryExecAsync('git', ['-C', root, 'rev-list', '--count', 'HEAD']);
    return (parseInt(have ?? '0', 10) || 0) > 0;
  }
  // Detached HEAD / no branch name — fall back to the upstream measure.
  const ahead = await tryExecAsync('git', ['-C', root, 'rev-list', '--count', '@{u}..HEAD']);
  return ahead !== null && (parseInt(ahead, 10) || 0) > 0;
}

// ── stop-hook per-turn push [D3/D17/D20] ────────────────────────────────────
//
// SessionEnd never fires on /exit (upstream: closed not-planned), can't fire
// on crash, and a cloud sandbox VM may simply be reclaimed between turns —
// so the Stop boundary (fires after EVERY assistant turn) is the only cadence
// that always runs while work exists. Debounced per workspace root, detached
// spawn (instant), fail-open everywhere.

function stopPushStatePath(root: string): string {
  return join(resolveGbrainHome(), 'bootstrap', `stop-push-${workspaceRootHash(root)}.json`);
}

/** Debounce resolution: env GBRAIN_STOP_PUSH_DEBOUNCE_MIN (minutes; 0 = every
 * turn) → file-plane config hooks.stop_push_debounce_min → environment-kind
 * default (cloud-sandbox: 0, everything else: 5). */
function stopPushDebounceMs(): number {
  const env = process.env.GBRAIN_STOP_PUSH_DEBOUNCE_MIN;
  if (env !== undefined) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n * 60_000;
  }
  try {
    const cfg = loadConfig();
    const v = cfg?.hooks?.stop_push_debounce_min;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
    if (Number.isFinite(n) && n >= 0) return n * 60_000;
  } catch {
    /* tolerant read — fall through to the default */
  }
  return detectExecutionEnvironment() === 'cloud-sandbox' ? 0 : STOP_PUSH_DEBOUNCE_MIN_DEFAULT * 60_000;
}

/** Floor for the [D20] failing-status retry cadence: a stuck push (e.g. gh
 * unauthenticated for a day) must not re-run the full network ladder on every
 * single turn — one retry a minute keeps recovery fast without the storm. */
export const STOP_PUSH_FAILING_RETRY_FLOOR_MS = 60_000;

/** Decide + (maybe) spawn the per-turn push. Returns the heartbeat reason.
 * Ordered cheapest-first: the debounce (two file reads) answers the common
 * case before any git subprocess runs — repoPhaseComplete's git probes only
 * execute on turns that might actually spawn a push. */
async function stopPushIfDue(ws: string, io: HookIo): Promise<string> {
  if (process.env.GBRAIN_STOP_PUSH === '0') return 'push_disabled';
  const root = await resolveBootstrapWorkspaceRoot(ws);
  if (!root) return 'push_skipped_not_bootstrap';

  const stateP = stopPushStatePath(root);
  let lastTs: number | null = null;
  try {
    const s = JSON.parse(readFileSync(stateP, 'utf8')) as { ts?: string };
    const t = Date.parse(s.ts ?? '');
    if (Number.isFinite(t)) lastTs = t;
  } catch {
    /* missing/corrupt state → due (fail-open) */
  }
  // [D20] a failing push bypasses the normal debounce so recovery is fast —
  // but with a 60s floor so a persistently failing push can't re-run the
  // network verification ladder on every turn (the push lock bounds
  // concurrency, not cadence; the banner is already showing the failure).
  const failing = readPushStatusForRoot(root)?.ok === false;
  const now = Date.now();
  // Healthy: the normal debounce (0 = every turn in cloud). Failing: a fixed
  // 60s retry floor — faster than a long local debounce so a transient failure
  // recovers within a turn or two, but NEVER every-turn (a Math.min against the
  // cloud debounce of 0 was a re-run-the-ladder-every-turn storm; adversarial
  // review caught it).
  const windowMs = failing ? STOP_PUSH_FAILING_RETRY_FLOOR_MS : stopPushDebounceMs();
  if (lastTs !== null && now - lastTs < windowMs) return 'push_debounced';
  // Same privacy gate as SessionEnd: never push before the repo phase has
  // verified the origin and recorded repo_url (create-repo-first race).
  if (!(await repoPhaseComplete(root))) return 'push_deferred_repo_pending';
  if (!(await treeNeedsPush(root))) return 'push_clean';
  try {
    // Written BEFORE the spawn so repeated fail-fast children stay debounced
    // on the healthy path; the [D20] failing-status bypass handles retries.
    mkdirSync(join(resolveGbrainHome(), 'bootstrap'), { recursive: true, mode: 0o700 });
    const tmp = `${stateP}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ ts: new Date(now).toISOString(), root }) + '\n', { mode: 0o600 });
    renameSync(tmp, stateP);
  } catch {
    /* state-write failure must not block the push itself */
  }
  try {
    (io.spawnPush ?? spawnDetachedPush)(root);
    return 'push_spawned';
  } catch {
    return 'push_unavailable';
  }
}

// ── push-failure banner [D5/D13/D19] ────────────────────────────────────────

interface PushAnnounceState {
  announced_ts?: string;
  last_announce_at?: string;
}

/**
 * The pending ≤300-char failure banner, or null. `record()` marks the due
 * failures announced and is called ONLY after the banner actually reached
 * stdout — a deadline-suppressed banner must re-fire next turn. Announce
 * state is a sidecar next to each per-root status file (`<file>.announced`):
 * each new failure `ts` announces once, then re-announces at most every
 * PUSH_ANNOUNCE_REFIRE_MS while the failure persists [D19].
 */
function pendingPushFailureBanner(): { text: string; record: () => void } | null {
  try {
    const failing = readPushStatuses().filter((e) => e.ok === false);
    if (failing.length === 0) return null;
    const now = Date.now();
    const due = failing.filter((e) => {
      try {
        const s = JSON.parse(readFileSync(`${e.file}.announced`, 'utf8')) as PushAnnounceState;
        if (s.announced_ts !== e.ts) return true;
        const last = Date.parse(s.last_announce_at ?? '');
        return !Number.isFinite(last) || now - last > PUSH_ANNOUNCE_REFIRE_MS;
      } catch {
        return true; // never announced (or unreadable state) → due
      }
    });
    if (due.length === 0) return null;
    const first = due[0]!;
    const which = first.repoRoot ?? 'the workspace';
    const more = due.length > 1 ? ` (+${due.length - 1} more workspace(s))` : '';
    const text = (
      `NOTICE: the background workspace push for ${which} is FAILING ` +
      `(${sanitizePushReason(first.reason)})${more} — work is committed locally ` +
      'but NOT on GitHub. Run gbrain doctor.'
    ).slice(0, PUSH_BANNER_MAX_CHARS);
    const record = () => {
      for (const e of due) {
        try {
          writeFileSync(
            `${e.file}.announced`,
            JSON.stringify({ announced_ts: e.ts, last_announce_at: new Date(now).toISOString() }) + '\n',
            { mode: 0o600 },
          );
        } catch {
          /* fail-open — worst case the banner re-fires */
        }
      }
    };
    return { text, record };
  } catch {
    return null;
  }
}

// ── monthly backup-coverage notices (cache readers; engine-free) ────────────

/**
 * Shared body for the two hook-borne backup notices: cache read + the shared
 * nag gate on the given channel; the returned record() is deferred until the
 * text actually reached stdout (record-after-write). backupNoticeText already
 * caps the body at its 300-char budget — the short prefix on top stays far
 * inside the payload cap, so no second slice (a slice here chopped the
 * trailing call-to-action).
 */
function backupHookNotice(channel: string, prefix: string): { text: string; record: () => void } | null {
  try {
    if (backupCheckDisabled()) return null;
    const s = loadBackupStatus();
    if (!s || s.overall !== 'warn') return null;
    const gate = backupNagGate(channel, s);
    if (!gate.show) return null;
    const t = backupNoticeText(s, 'human');
    if (!t) return null;
    return { text: `${prefix}${t}`, record: gate.record };
  } catch {
    return null;
  }
}

/** Session-start digest note ('hook-note' channel). */
function backupSessionStartNote(): { text: string; record: () => void } | null {
  return backupHookNotice('hook-note', 'Backup check: ');
}

/**
 * The backup banner for the user-prompt payload ('hook-banner' channel). Same
 * delivery rail as the push-failure banner (systemMessage + additionalContext);
 * the push failure wins the single banner slot — this one only fires when no
 * push failure is pending.
 */
function pendingBackupBanner(): { text: string; record: () => void } | null {
  return backupHookNotice('hook-banner', 'NOTICE: ');
}

/**
 * Fire-and-forget `gbrain backup check --quiet` as a DETACHED child (the
 * spawnDetachedPush pattern). The child re-resolves everything itself and
 * exits 0 silently when the PGLite lock is held by a live serve — that
 * install is covered by the serve-side refresher instead.
 */
function spawnDetachedBackupCheck(): void {
  const exec = process.execPath ?? '';
  const checkArgs = ['backup', 'check', '--quiet'];
  const argv = /[/\\]gbrain(\.exe)?$/.test(exec) ? checkArgs : [process.argv[1], ...checkArgs];
  const child = spawn(exec, argv, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
  });
  child.on('error', () => {});
  child.unref();
}

// ── user-prompt [ENG-1, S3#8, A9] ───────────────────────────────────────────

interface UserPromptOutcome {
  outcome: HookHeartbeatEntry['outcome'];
  reason?: string;
  turns?: number;
}

async function hookUserPrompt(io: HookIo): Promise<number> {
  const t0 = Date.now();
  let expired = false;
  const guardedWrite = (s: string) => {
    if (!expired) write(io, s);
  };

  // [D5/D19] Same-session failure surfacing: a refused/failed background push
  // becomes visible on the NEXT turn — to the model via additionalContext AND
  // to the human via systemMessage ("never silent" must not depend on the
  // model choosing to relay its own tooling's failure). Embedded in the main
  // payload when one is written; emitted alone on every degraded path.
  // Computed INSIDE the deadline-raced closure: its sync file reads must be
  // budgeted by the 800ms deadline, not free-ride before the race starts.
  let banner: ReturnType<typeof pendingPushFailureBanner> = null;
  let wrotePayload = false;

  const work = (async (): Promise<UserPromptOutcome> => {
    // Push failure wins the single banner slot; the monthly backup notice
    // rides the same rail (systemMessage + additionalContext) when no push
    // failure is pending. Both are cache/file readers, budgeted by the race.
    banner = io.disablePushBanner ? null : (pendingPushFailureBanner() ?? pendingBackupBanner());
    const j = await readStdinJson(io, 300);
    if (!j) return { outcome: 'degraded', reason: 'no_stdin' };

    // S3#8: transcript_path is untrusted input. A present-but-unconfined
    // path aborts the event (heartbeat + empty stdout), never "best effort".
    let turns: WindowTurn[] = [];
    let priorContextText: string | undefined;
    if (j.transcript_path !== undefined && j.transcript_path !== null) {
      const conf = confineTranscriptPath(j.transcript_path, {
        ...(io.transcriptRoot ? { root: io.transcriptRoot } : {}),
      });
      if (!conf.ok) return { outcome: 'degraded', reason: `transcript_${conf.reason}` };
      try {
        const parsed = parseTranscript(conf.path, { maxBytes: USER_PROMPT_TRANSCRIPT_MAX_BYTES });
        turns = parsed.turns.slice(-USER_PROMPT_WINDOW_TURNS);
        // Cross-turn dedupe: feed the blocks WE previously injected this
        // session back as priorContextText (slug-only suppression + volunteer
        // dedupe inside assembleTurnContext) — a page is volunteered once per
        // session, not once per mention. Structured extraction only (the
        // gbrain-marked hook_additional_context attachments), never raw turn
        // text, so a short slug in a tool payload can't over-suppress.
        // Bounded before send: identical blocks dedupe (the same pointer
        // re-recorded each turn is pure redundancy) and the newest blocks are
        // kept under a byte cap — an unbounded join would eventually exceed
        // the 256KB IPC message cap and permanently silence the channel.
        // Horizon note: the tail read bounds dedupe to the newest
        // USER_PROMPT_TRANSCRIPT_MAX_BYTES of transcript — in very long
        // sessions the oldest injections roll out and their pages become
        // volunteerable again (documented, preferable to a state file).
        if (parsed.injectedContextBlocks.length) {
          const unique = [...new Set(parsed.injectedContextBlocks)];
          const kept: string[] = [];
          let bytes = 0;
          for (const block of unique.reverse()) { // newest first
            const b = Buffer.byteLength(block, 'utf8') + 2;
            // Skip (not break): one oversized block must not evict every
            // older, smaller block — that would disable ALL dedupe at once.
            if (bytes + b > PRIOR_CONTEXT_MAX_BYTES) continue;
            kept.unshift(block); // restore oldest → newest order
            bytes += b;
          }
          if (kept.length) priorContextText = kept.join('\n\n');
        }
      } catch {
        turns = []; // unreadable-mid-flight — the prompt alone still works
      }
    }
    const prompt = typeof j.prompt === 'string' ? j.prompt : '';
    if (prompt.trim()) turns = [...turns, { role: 'user', text: prompt }];
    if (turns.length === 0) return { outcome: 'ok', reason: 'empty_window' };

    const cfg = io.configOverride !== undefined ? io.configOverride : loadConfig();
    // Engine-uniform (#4245): PGLite keys the socket off the data dir,
    // Postgres off hash12(database_url) under ~/.gbrain/run. Null = no
    // keying material at all (no config, thin-client remote) — ENGINE-FREE
    // means no direct-engine fallback here; pull-mode covers it.
    const socketPath = resolveSocketPathForConfig(cfg);
    if (!socketPath) {
      return { outcome: 'degraded', reason: 'no_pglite_path' };
    }
    const secret = readIpcSecretForConfig(cfg);
    if (!secret) return { outcome: 'degraded', reason: 'no_serve' };

    const sessionId = typeof j.session_id === 'string' ? j.session_id : undefined;
    const sourceId = process.env.GBRAIN_SOURCE || undefined;
    const res = await requestTurnContext(socketPath, {
      secret,
      window: turns,
      ...(priorContextText ? { priorContextText } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(sourceId ? { sourceId } : {}),
      // Feedback-loop attribution: the serve logs the delivered block's
      // volunteered pages/pointers under this channel. Bootstrap registers
      // hooks for Claude Code only today; a future codex registration passes
      // `--harness codex` on the hook command.
      channel: io.harness ?? 'claude-code',
    });
    if (res === IPC_UNAVAILABLE) {
      return { outcome: 'degraded', reason: 'ipc_unavailable', turns: turns.length };
    }
    if ('degraded' in res && res.degraded === 'stale_serve') {
      // [A9] Protocol echo missing → v1 serve answered; degrade LOUDLY.
      return { outcome: 'degraded', reason: 'stale_serve', turns: turns.length };
    }
    const resp = res as TurnContextResponse;
    if (!resp.ok) {
      return { outcome: 'degraded', reason: reasonCode(resp.error ?? 'server_error'), turns: turns.length };
    }
    const text = resp.block?.text ?? '';
    if (!text) return { outcome: 'ok', reason: 'empty_block', turns: turns.length };

    // [ENG-1] The 10000-char harness cap applies to the WHOLE stdout payload;
    // the block is budgeted ≤8KB server-side, but JSON escaping inflates, so
    // trim defensively rather than letting the harness divert-and-drop. The
    // banner (≤300 chars, fixed) rides inside the same payload [D5] — only
    // blockText is trimmed, so the failure notice survives the cap loop.
    const bannerPrefix = banner ? `${banner.text}\n\n` : '';
    const buildPayload = (block: string) =>
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: bannerPrefix + block },
        ...(banner ? { systemMessage: banner.text } : {}),
      });
    let blockText = text;
    let payload = buildPayload(blockText);
    while (payload.length > CLAUDE_HOOK_OUTPUT_CAP_CHARS && blockText.length > 0) {
      blockText = blockText.slice(0, Math.max(0, blockText.length - (payload.length - CLAUDE_HOOK_OUTPUT_CAP_CHARS) - 16));
      payload = buildPayload(blockText);
    }
    if (blockText.length === 0) return { outcome: 'degraded', reason: 'over_cap', turns: turns.length };
    guardedWrite(payload + '\n');
    if (!expired) {
      wrotePayload = true;
      banner?.record();
    }
    // Partial trim is delivery-count drift: the serve already logged the FULL
    // post-budget set at the response write, but pages cut from the tail here
    // were never injected. Record it so the doctor's heartbeat reconciliation
    // (and a future reconciler) can see the divergence — outcome stays ok
    // (context WAS injected), the reason carries the signal.
    if (blockText.length < text.length) {
      return { outcome: 'ok', reason: 'trimmed', turns: turns.length };
    }
    return { outcome: 'ok', turns: turns.length };
  })();

  let result: UserPromptOutcome;
  try {
    const raced = await withDeadline(io.userPromptDeadlineMs ?? USER_PROMPT_DEADLINE_MS, work);
    if (raced === DEADLINE) {
      expired = true; // late writes are suppressed — a post-deadline block must not appear
      result = { outcome: 'degraded', reason: 'deadline' };
    } else {
      result = raced;
    }
  } catch (e) {
    expired = true;
    result = { outcome: 'error', reason: errorCode(e) };
  }
  // Banner-only emission [D5]: every path that did NOT write the main payload
  // (no_serve, ipc_unavailable, no_pglite_path, empty windows, transcript
  // aborts, …) still surfaces the push failure — unless the deadline expired,
  // in which case record() was never called and the banner re-fires next turn.
  // (Local copy: TS cannot track the closure-side assignment of `banner`.)
  const pendingBanner = banner as { text: string; record: () => void } | null;
  if (pendingBanner && !wrotePayload && !expired) {
    guardedWrite(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: pendingBanner.text },
        systemMessage: pendingBanner.text,
      }) + '\n',
    );
    pendingBanner.record();
  }
  await writeHeartbeat(io, {
    ts: new Date().toISOString(),
    event: 'user-prompt',
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
    duration_ms: Date.now() - t0,
    ...(result.turns !== undefined ? { turns: result.turns } : {}),
  });
  return 0;
}

// ── compact (PreCompact banking, v0.45.7 ambient recall) ─────────────────────

/** Self-deadline for the compact event (harness timeout is 5s). */
export const COMPACT_DEADLINE_MS = 3000;
/** Banking wants breadth, not the 4-turn prompt window. */
const COMPACT_WINDOW_TURNS = 20;
/** Minimum remaining budget to START the segment scan+write (cathedral 5). */
const SEGMENT_MIN_BUDGET_MS = 600;
/** Minimum remaining budget for the durability WRITE itself (segment file +
 * ledger). Named separately from the IPC threshold on purpose (pre-landing
 * review): tuning one must not silently retune the other. */
const SEGMENT_WRITE_MIN_BUDGET_MS = 300;
/** Minimum remaining budget to fire the banking IPC call (cathedral 5). */
const COMPACT_IPC_MIN_BUDGET_MS = 300;

/**
 * PreCompact fires BEFORE Claude Code compacts the transcript. Its stdout is
 * NOT context-injected — the useful work is the WRITEs (cathedral 5 order,
 * durability first):
 *   1. bank the since-last-boundary window DURABLY as a content-addressed
 *      corpus segment + ledger entry (secret-scanned; never written unscanned;
 *      per-step deadline degrades with typed codes) — the serve sweep is the
 *      extraction backstop even if everything after this fails;
 *   2. ONE IPC round trip that banks the window's standing entities into the
 *      session cursor (and, when a segment was banked, asks serve to harvest
 *      it promptly) so the post-compaction SessionStart (source=compact)
 *      serves a warm rehydration pack.
 * Engine-free: transcript parse + fs + one IPC round trip. Fail-open always.
 */
async function hookCompact(io: HookIo): Promise<number> {
  const t0 = Date.now();
  const deadlineMs = io.compactDeadlineMs ?? COMPACT_DEADLINE_MS;
  const remaining = () => deadlineMs - (Date.now() - t0);
  let outcome: HookHeartbeatEntry['outcome'] = 'ok';
  let reason: string | undefined;
  let segment: string | undefined;
  let flushAck: string | undefined;

  const work = (async () => {
    const j = await readStdinJson(io, 300);
    if (!j) { outcome = 'degraded'; reason = 'no_stdin'; return; }

    // S3#8 posture matches user-prompt: an unconfined transcript path aborts.
    let turns: WindowTurn[] = [];
    let boundaryTurnIndexes: number[] = [];
    let allTurns: WindowTurn[] = [];
    if (j.transcript_path !== undefined && j.transcript_path !== null) {
      const conf = confineTranscriptPath(j.transcript_path, {
        ...(io.transcriptRoot ? { root: io.transcriptRoot } : {}),
      });
      if (!conf.ok) { outcome = 'degraded'; reason = `transcript_${conf.reason}`; return; }
      try {
        const parsed = parseTranscript(conf.path, { maxBytes: USER_PROMPT_TRANSCRIPT_MAX_BYTES });
        allTurns = parsed.turns;
        boundaryTurnIndexes = parsed.boundaryTurnIndexes;
        turns = parsed.turns.slice(-COMPACT_WINDOW_TURNS);
      } catch {
        turns = [];
      }
    }
    // sanitizeSessionId maps a MISSING id to the 'unknown' sentinel (fine for
    // the stop buffer's filenames, wrong for cursor banking — a shared
    // 'unknown' bucket would cross-pollinate sessions). Treat it as absent.
    const sid = sanitizeSessionId(j?.session_id);
    const sessionId = sid === 'unknown' ? null : sid;
    if (!sessionId || turns.length === 0) {
      // Nothing to bank against — not an error, just nothing to do.
      if (outcome === 'ok') reason = sessionId ? 'empty_window' : 'no_session';
      return;
    }

    const cfg = loadConfig();

    // Cathedral 5, durability FIRST: content-addressed segment + ledger before
    // any IPC. Written for EVERY engine config (the sweep backstop harvests it
    // when serve/IPC is unavailable). Per-step deadline degrades — a scan that
    // can't finish skips the segment ENTIRELY (never write unscanned content).
    const banked = await bankCompactSegment(await corpusDir(cfg), sessionId, allTurns, boundaryTurnIndexes, {
      remainingMs: remaining,
      minScanMs: SEGMENT_MIN_BUDGET_MS,
      minWriteMs: SEGMENT_WRITE_MIN_BUDGET_MS,
    });
    segment = banked.segment;
    const flushCorpusFile = banked.flushCorpusFile;

    // Same engine-uniform resolution as the session-start pack arm (v0.45.7
    // symmetry, engine-uniform since #4245): a Postgres config carrying a
    // leftover database_path must not probe the PGLite socket (the resolver
    // checks engine first); a Postgres brain probes its hash12(database_url)
    // run-dir socket instead. Null = no keying material → degrade.
    const compactSocket = resolveSocketPathForConfig(cfg);
    if (!compactSocket) { outcome = 'degraded'; reason = 'no_pglite_path'; return; }
    const secret = readIpcSecretForConfig(cfg);
    if (!secret) { outcome = 'degraded'; reason = 'no_serve'; return; }
    if (remaining() < COMPACT_IPC_MIN_BUDGET_MS) { outcome = 'degraded'; reason = 'deadline'; return; }

    const res = await requestContextPack(compactSocket, {
      secret,
      sessionId,
      window: turns,
      bankOnly: true,
      trigger: 'compact-bank',
      ...(flushCorpusFile ? { flushCorpusFile } : {}),
      ...(process.env.GBRAIN_SOURCE ? { sourceId: process.env.GBRAIN_SOURCE } : {}),
    });
    if (res === IPC_UNAVAILABLE) { outcome = 'degraded'; reason = 'ipc_unavailable'; return; }
    if ('degraded' in res && res.degraded === 'stale_serve') { outcome = 'degraded'; reason = 'stale_serve'; return; }
    const resp = res as ContextPackResponse;
    if (!resp.ok) { outcome = 'degraded'; reason = reasonCode(resp.error ?? 'server_error'); return; }
    // Fold the harvest-schedule ack into the heartbeat (adversarial review):
    // a persistently full queue, bad basename, or split-corpus-dir not_found
    // was previously observable NOWHERE — the ack was dropped on the floor
    // and serve only heartbeats pump outcomes. Codes only, never content.
    const cf = (resp.block as { checkpointFlush?: { status?: string; reason?: string } } | null | undefined)
      ?.checkpointFlush;
    if (cf?.status === 'scheduled') flushAck = 'scheduled';
    else if (cf) flushAck = `skip_${cf.reason ?? 'unknown'}`;
  })();

  try {
    const raced = await withDeadline(deadlineMs, work);
    if (raced === DEADLINE && outcome === 'ok') { outcome = 'degraded'; reason = 'deadline'; }
  } catch (e) {
    outcome = 'error';
    reason = errorCode(e); // fail-open: exit 0
  }
  await writeHeartbeat(io, {
    ts: new Date().toISOString(),
    event: 'compact',
    outcome,
    ...(reason ? { reason } : {}),
    duration_ms: Date.now() - t0,
    ...(segment ? { segment } : {}),
    ...(flushAck ? { flush: flushAck } : {}),
  });
  return 0;
}

// ── stop [G15] ──────────────────────────────────────────────────────────────

async function hookStop(io: HookIo): Promise<number> {
  const t0 = Date.now();
  let outcome: HookHeartbeatEntry['outcome'] = 'ok';
  let reason: string | undefined;
  let j: Record<string, unknown> | null = null;
  try {
    j = await readStdinJson(io, 300);
    const sessionId = sanitizeSessionId(j?.session_id);
    const dir = await liveBufferDir();
    const exchange = firstString(j, ['last_assistant_message', 'lastAssistantMessage', 'prompt']);
    const entry = {
      ts: new Date().toISOString(),
      session_id: sessionId,
      ...(exchange ? { exchange: exchange.slice(0, 400) } : {}),
    };
    appendFileSync(join(dir, `${sessionId}.txt`), JSON.stringify(entry) + '\n', { mode: 0o600 });
    gcOldFiles(dir, STOP_BUFFER_RETENTION_MS);
  } catch (e) {
    outcome = 'error';
    reason = errorCode(e);
  }
  // Ambient-writeback backstop (WP4) — its own try/deadline, fail-open, and
  // FILE-plane gated (this child never opens the engine; the serve-side
  // harvest re-checks the AUTHORITATIVE DB-plane gate before extracting).
  // Every outcome is a typed heartbeat reason on its own `writeback-bank`
  // event; IPC down = degraded (the sweep's corpus pass extracts the banked
  // file later). Zero LLM here — the gate is deterministic and "Thanks"
  // never even produces a file.
  let wbReason: string | undefined;
  const wbT0 = Date.now();
  try {
    const wbWork = (async (): Promise<string> => {
      // ONE uncached loadConfig for the whole step (it re-reads disk every
      // call) — gate, corpus dir, and IPC discovery all share it.
      const cfg = loadConfig();
      const wb = resolveWritebackConfigFromFile(cfg);
      if (!wb.enabled) return 'wb_off';
      const sid = sanitizeSessionId(j?.session_id);
      if (sid === 'unknown') return 'no_session';
      const tp = j?.transcript_path;
      if (tp === undefined || tp === null) return 'no_transcript';
      const conf = confineTranscriptPath(tp as string, {
        ...(io.transcriptRoot ? { root: io.transcriptRoot } : {}),
      });
      if (!conf.ok) return `transcript_${conf.reason}`;
      const findLastUser = (ts: WindowTurn[]): WindowTurn | undefined => {
        for (let i = ts.length - 1; i >= 0; i--) {
          if (ts[i].role === 'user' && ts[i].text) return ts[i];
        }
        return undefined;
      };
      let lastUser: WindowTurn | undefined;
      try {
        // Cheap-first tail sizing: a 128KB newest-tail finds the most-recent
        // user turn in the common case, BUT the turn's OFFSET from EOF is the
        // whole assistant response including tool_result JSONL — a single big
        // file-read result can push it out of the window (red-team review,
        // this wave: turn SIZE ≠ turn OFFSET). Missing ⇒ ONE retry at the
        // 2MB user-prompt cap; only then is the turn genuinely absent. The
        // wide parse only ever runs when the cheap one failed, so the common
        // path keeps the 128KB cost inside this lane's 2s budget.
        lastUser = findLastUser(
          parseTranscript(conf.path, { maxBytes: WRITEBACK_TRANSCRIPT_TAIL_BYTES }).turns,
        );
        if (!lastUser) {
          lastUser = findLastUser(
            parseTranscript(conf.path, { maxBytes: USER_PROMPT_TRANSCRIPT_MAX_BYTES }).turns,
          );
        }
      } catch {
        return 'parse_failed';
      }
      if (!lastUser || !lastUser.text) return 'no_user_turn';
      const gated = gateWritebackTurn(lastUser.text);
      if (!gated.ok) return gated.reason;
      const banked = await bankWritebackTurn(
        await corpusDir(cfg), sid, gated.normalized, gated.hash24,
        // Bank the session's source IN THE NAME so the sweep fallback files
        // the turn into the same source the IPC lane below would have.
        process.env.GBRAIN_SOURCE ?? null,
      );
      if (banked.status !== 'wb_banked' && banked.status !== 'wb_dup') return banked.status;
      if (banked.status === 'wb_dup') return 'wb_dup';
      // Prompt-harvest ask over the compact-bank IPC lane — sourceId rides
      // exactly like the compact call (OV2-9/OV-A6); every failure below is
      // degraded-not-blocking: the banked file is the durable artifact and
      // the sweep extracts it when serve is away.
      const socket = resolveSocketPathForConfig(cfg);
      if (!socket) return 'no_pglite_path';
      const secret = readIpcSecretForConfig(cfg);
      if (!secret) return 'no_serve';
      const res = await requestContextPack(socket, {
        secret,
        sessionId: sid,
        bankOnly: true,
        trigger: 'writeback-bank',
        ...(banked.flushCorpusFile ? { flushCorpusFile: banked.flushCorpusFile } : {}),
        ...(process.env.GBRAIN_SOURCE ? { sourceId: process.env.GBRAIN_SOURCE } : {}),
      });
      if (res === IPC_UNAVAILABLE) return 'ipc_unavailable';
      if ('degraded' in res && res.degraded === 'stale_serve') return 'stale_serve';
      const resp = res as ContextPackResponse;
      if (!resp.ok) return 'flush_failed';
      const cf = (resp.block as { checkpointFlush?: { status?: string; reason?: string } } | null | undefined)?.checkpointFlush;
      if (cf?.status === 'scheduled') return 'wb_scheduled';
      return cf ? `flush_skip_${cf.reason ?? 'unknown'}` : 'wb_banked';
    })();
    const raced = await withDeadline(WRITEBACK_STOP_DEADLINE_MS, wbWork);
    wbReason = raced === DEADLINE ? 'wb_deadline' : raced;
  } catch (e) {
    wbReason = `wb_${errorCode(e)}`;
  }
  if (wbReason && wbReason !== 'wb_off') {
    // Outcome classes (adversarial review, this wave): 'ok' covers BOTH the
    // banked/scheduled successes AND every BY-DESIGN skip — the deterministic
    // gate filters ("Thanks" → ack_or_greeting), a turn genuinely absent from
    // the transcript, and the flush_skip_* family (the turn IS banked; the
    // enqueue was declined by a designed cap/queue policy and the sweep
    // extracts it later). 'degraded' is reserved for infrastructure faults
    // (IPC down, stale serve, parse/scan failures, deadline) so doctor's
    // skipped-vs-failed counters and any alerting stay honest.
    const wbByDesign =
      wbReason === 'wb_scheduled' || wbReason === 'wb_banked' || wbReason === 'wb_dup' ||
      wbReason === 'no_user_turn' || wbReason.startsWith('flush_skip_') ||
      (WRITEBACK_SKIP_REASONS as readonly string[]).includes(wbReason);
    await writeHeartbeat(io, {
      ts: new Date().toISOString(),
      event: 'writeback-bank',
      outcome: wbByDesign ? 'ok' : 'degraded',
      reason: wbReason,
      // Step-local clock: this event's duration must reflect the 2s-budgeted
      // step, not hookStop's whole run (a wb_deadline reason with a
      // duration exceeding the deadline would mislead triage).
      duration_ms: Date.now() - wbT0,
    });
  }

  // Per-turn durability push [D3/D17/D20] — its own try/deadline so the
  // buffer append above and the heartbeat below are never at risk.
  let pushReason: string | undefined;
  try {
    const ws = io.cwd ?? (typeof j?.cwd === 'string' ? (j.cwd as string) : process.cwd());
    const raced = await withDeadline(STOP_PUSH_DEADLINE_MS, stopPushIfDue(ws, io));
    pushReason = raced === DEADLINE ? 'push_unavailable' : raced;
  } catch {
    pushReason = 'push_unavailable';
  }
  await writeHeartbeat(io, {
    ts: new Date().toISOString(),
    event: 'stop',
    outcome,
    ...((reason ?? pushReason) ? { reason: reason ?? pushReason } : {}),
    duration_ms: Date.now() - t0,
  });
  return 0;
}

function firstString(j: Record<string, unknown> | null, keys: string[]): string | null {
  if (!j) return null;
  for (const k of keys) {
    const v = j[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function gcOldFiles(dir: string, maxAgeMs: number): void {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.txt')) continue;
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      } catch {
        /* per-file best effort */
      }
    }
  } catch {
    /* GC never breaks the hook */
  }
}

// ── session-end [S3#2, G3, G15] ─────────────────────────────────────────────

async function corpusDir(cfg: GBrainConfig | null): Promise<string> {
  const configured = cfg?.dream?.synthesize?.session_corpus_dir;
  if (configured && isAbsolute(configured)) return ensureDir0700(configured);
  const home = await resolveHome();
  ensureDir0700(join(home, 'transcripts'));
  return ensureDir0700(join(home, 'transcripts', 'corpus'));
}

function corpusRetentionDays(cfg: GBrainConfig | null): number {
  // Key is plan-defined [G15] but not yet in the GBrainConfig type (config.ts
  // is another lane's file) — read tolerantly.
  const synth = cfg?.dream?.synthesize as Record<string, unknown> | undefined;
  const v = synth?.corpus_retention_days;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : CORPUS_RETENTION_DAYS_DEFAULT;
}

async function hookSessionEnd(io: HookIo): Promise<number> {
  const t0 = Date.now();
  let outcome: HookHeartbeatEntry['outcome'] = 'ok';
  let reason: string | undefined;
  let turnsN: number | undefined;
  let bytesN: number | undefined;
  let redactionsN: number | undefined;
  const degrade = (r: string) => {
    if (outcome === 'ok') {
      outcome = 'degraded';
      reason = r;
    }
  };

  let sessionId = 'unknown';
  let ws: string | undefined;
  let segmentMode: string | undefined;
  // Apply-LAST reasons: entries here describe something other than THIS
  // session's own capture health — prior-run relay failures (memorable_relay_*)
  // and a discovery-fallback note — so under first-degrade-wins they must not
  // mask a current-session reason (e.g. push_unavailable, scan_unavailable).
  // Held here and applied just before the heartbeat write.
  const deferredReasons: string[] = [];
  try {
    const j = await readStdinJson(io, 500);
    sessionId = sanitizeSessionId(j?.session_id);
    ws = io.cwd ?? (typeof j?.cwd === 'string' ? (j.cwd as string) : process.cwd());
    const cfg = loadConfig();
    // ONE gate for the whole Memorable integration (memorableGateAllowed —
    // shared with the openclaw lane and doctor). Answered BEFORE the parse so
    // the default gate-off population never pays tool-call collection.
    const memorableAllowed = (await memorableGateAllowed(cfg)).allowed;

    // Per-harness capture seam: claude-code and codex each pin their OWN
    // confinement root + parser; unknown harnesses resolve to the claude spec
    // (today's behavior, pinned by the capture-spec golden test).
    const spec = captureSpecFor(io.harness);
    const rootOpt = io.transcriptRoot ? { root: io.transcriptRoot } : {};
    let conf = spec.confine(j?.transcript_path, { ...rootOpt });
    // A newest-mtime discovery with NO session-id match is a guess: on a
    // machine with concurrent sessions it can be a different, still-RUNNING
    // rollout. Fine for the local corpus (overwritten on the real session
    // end), never for the relay — a receipt would describe a session that
    // has not ended, and its partial hash would double-pay extraction later.
    let discoveryWasGuess = false;
    if (!conf.ok && conf.reason === 'missing_path' && spec.discover) {
      // A codex SessionEnd payload can carry transcript_path:null (no local
      // rollout); the bounded newest-first discovery keeps the lane useful —
      // LOUDLY (typed deferred reason, never a silent guess).
      const found = spec.discover(sessionId === 'unknown' ? null : sessionId, { ...rootOpt });
      if (found) {
        deferredReasons.push(found.degrade);
        discoveryWasGuess = found.degrade === 'transcript_discovered_newest';
        conf = spec.confine(found.path, { ...rootOpt });
      }
    }
    if (!conf.ok) {
      degrade(`transcript_${conf.reason}`);
    } else {
      const parsed = spec.parse(conf.path, { collectToolCalls: memorableAllowed });
      if (sessionId === 'unknown') {
        // Stdin payload carried no session_id (observed on codex): adopt the
        // transcript's own id so successive such sessions don't collapse onto
        // one shared unknown.txt corpus (overwriting each other's dedup key).
        const inline = (parsed as { sessionId?: string | null }).sessionId;
        if (typeof inline === 'string' && inline) sessionId = sanitizeSessionId(inline);
      }
      turnsN = parsed.turns.length;
      bytesN = parsed.bytesRead;
      if (bytesN > 0 && turnsN === 0) {
        // [G3] LOUD: the host format drifted under us — heartbeat error +
        // status file surfaced at the next session-start.
        outcome = 'error';
        reason = 'parser_drift';
        try {
          const p = await hookStatusPath();
          writeFileSync(
            p,
            JSON.stringify({ ts: new Date().toISOString(), error: 'parser_drift', bytes: bytesN }, null, 2) + '\n',
            { mode: 0o600 },
          );
        } catch {
          /* status telemetry best-effort */
        }
      } else if (turnsN > 0) {
        const dir = await corpusDir(cfg);
        // Cathedral 5 dedup contract: when EVERY non-empty boundary window's
        // redacted hash is banked in the segment ledger (exact-set), write
        // only the post-last-boundary REMAINDER; any mismatch ⇒ full
        // transcript exactly as before (at-least-once).
        const decided = await decideCorpusMode(dir, sessionId, parsed.turns, parsed.boundaryTurnIndexes);
        const corpusTurns = decided.turns;
        if (decided.mode !== 'full') segmentMode = decided.mode;
        if (segmentMode !== 'skip_covered') {
          // (skip_covered: everything already segment-banked; nothing new to
          // write — existing corpus file + sidecars stay untouched.)
          //
          // [S3#2] Secret-scan AT WRITE TIME. Scanner absent → still write
          // (the corpus is 0700-local), but say so in the heartbeat.
          let text = toCorpusText(corpusTurns);
          let toolCallsJson = '[]';
          try {
            const scan = await import('../core/secret-scan.ts');
            // The relay child derives its egress task line from this corpus, so
            // the moment the integration is on, the corpus scan runs with the
            // same highEntropy posture as the tool-calls JSON below — the
            // local-only default keeps the cheaper vendor-prefix-only scan.
            const redacted = scan.redactFindings(text, memorableAllowed ? { highEntropy: true } : {});
            text = redacted.text;
            // COUNT only — the findings themselves never land in telemetry [S3#7].
            redactionsN = redacted.redactions.length;
            if (memorableAllowed) {
              // Same span as the corpus, highEntropy always on — see the
              // shared helper's doc for why.
              toolCallsJson = await redactedToolCallsJson(parsed.toolCalls, parsed.toolCallTurnIndexes, decided.startTurnIndex);
            }
          } catch {
            degrade('scan_unavailable');
          }
          // Session-id-keyed filename: a resumed session OVERWRITES its own
          // corpus file — dedup by construction [A6]. The write is ATOMIC
          // (tmp+rename) so a concurrent sweep never reads a torn half-write,
          // and the stale `.ingested`/`.in-progress` sidecars are dropped AFTER
          // the rename so the sweep re-processes the appended transcript (a
          // resumed session's new turns were being permanently skipped when the
          // completion sidecar survived the overwrite).
          const corpusFile = join(dir, `${sessionId}.txt`);
          const tmpCorpus = `${corpusFile}.tmp-${process.pid}`;
          writeFileSync(tmpCorpus, text, { mode: 0o600 });
          renameSync(tmpCorpus, corpusFile);
          // Additive signal for a local third-party consumer (never gbrain
          // itself): the corpus file above is done, hashed post-redaction so
          // the hash can never fingerprint pre-scrub content. Receipt + relay
          // live in hook-heartbeat.ts's recordAndRelayReceipt (shared with the
          // openclaw context-engine lane): dedup by content hash, prior-run
          // outcome surfacing, detached fire-and-forget spawn.
          if (memorableAllowed && discoveryWasGuess) {
            deferredReasons.push('memorable_relay_skipped_newest_guess');
          } else if (memorableAllowed && redactionsN === undefined) {
            // Scanner unavailable → the corpus above is UNREDACTED. The local
            // 0600 write is fine, but nothing unscanned may reach the relay
            // child (its egress task line derives from this corpus). Fail
            // CLOSED — same posture as the openclaw context-engine lane —
            // instead of delegating the refusal to the closed-source child.
            deferredReasons.push('memorable_relay_skipped_unscanned');
          } else if (memorableAllowed) {
            const relay = await recordAndRelayReceipt({
              session_id: sessionId,
              harness: io.harness ?? 'claude-code',
              corpus_path: corpusFile,
              content_hash: segmentHash(text),
              turn_count: turnsN,
              workspace_root: ws ?? process.cwd(),
              tool_calls_json: toolCallsJson,
              secret_scan_ok: true, // scanner ran — the unscanned case took the branch above
            }, { trimRelayFile: true }); // both capture lanes trim memorable-relay.jsonl (converging newest-keeping trims)
            for (const r of relay.degradeReasons) {
              if (r.startsWith('memorable_relay_')) deferredReasons.push(r);
              else degrade(r);
            }
          }
          try {
            rmSync(corpusFile + CORPUS_INGESTED_SUFFIX, { force: true });
          } catch {
            /* best effort — sidecar invalidation never fails the hook */
          }
          try {
            rmSync(corpusFile + CORPUS_CLAIM_SUFFIX, { force: true });
          } catch {
            /* best effort */
          }
        }
        const retentionMs = corpusRetentionDays(cfg) * 24 * 60 * 60 * 1000;
        gcOldFiles(dir, retentionMs); // [G15]
        gcCorpusArtifacts(dir, retentionMs, [
          CORPUS_INGESTED_SUFFIX,
          CORPUS_CLAIM_SUFFIX,
          HARVEST_RECEIPT_SUFFIX,
        ]);
      }
    }
  } catch (e) {
    outcome = 'error';
    reason = errorCode(e);
  }

  // Best-effort workspace push (the no-daemon persistence backstop, plan D6)
  // — same initialized-manifest gate as session-start [G4]. Spawned DETACHED,
  // never inline: the hook must exit far inside the harness's 60s cap
  // regardless of repo/network state. Fires on clean trees too (a prior
  // failure may have left local ahead; workspacePush handles that + its own
  // in-flight lock in the child).
  try {
    if (ws) {
      const root = await resolveBootstrapWorkspaceRoot(ws);
      if (root && (await repoPhaseComplete(root))) {
        try {
          (io.spawnPush ?? spawnDetachedPush)(root);
          if (outcome === 'ok' && !reason) reason = 'push_spawned';
        } catch {
          degrade('push_unavailable');
        }
      } else if (root && outcome === 'ok' && !reason) {
        // Repo phase not finished (create-repo-first, before `bootstrap repo`):
        // defer the push so we never publish to an unverified-privacy origin.
        reason = 'push_deferred_repo_pending';
      }
    }
  } catch {
    /* best effort */
  }

  // Monthly backup-coverage recompute — detached, 24h-debounced via the nag
  // state file (no sidecar). Covers hooks-without-serve installs; a serve
  // holding the PGLite lock makes the child a benign no-op (exit 0, no cache
  // write) and the serve refresher owns that install instead.
  try {
    if (!backupCheckDisabled() && backupSpawnDue() && isBackupStatusStale(loadBackupStatus())) {
      // Recorded BEFORE the spawn (the stop-push precedent) so repeated
      // fail-fast children stay debounced.
      recordBackupSpawn();
      (io.spawnBackupCheck ?? spawnDetachedBackupCheck)();
    }
  } catch {
    /* best effort */
  }

  // GC this session's stop buffer [G15].
  try {
    const dir = await liveBufferDir();
    rmSync(join(dir, `${sessionId}.txt`), { force: true });
  } catch {
    /* best effort */
  }

  // Deferred reasons apply LAST — visible when nothing about THIS session
  // degraded, never masking a current-session reason.
  for (const r of deferredReasons) degrade(r);

  await writeHeartbeat(io, {
    ts: new Date().toISOString(),
    event: 'session-end',
    outcome,
    ...(reason ? { reason } : {}),
    duration_ms: Date.now() - t0,
    ...(turnsN !== undefined ? { turns: turnsN } : {}),
    ...(bytesN !== undefined ? { bytes: bytesN } : {}),
    ...(redactionsN !== undefined ? { redactions: redactionsN } : {}),
    ...(segmentMode ? { segment: segmentMode } : {}),
  });
  return 0;
}
