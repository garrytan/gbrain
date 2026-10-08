/**
 * bootstrap/hooks.ts — Claude Code hook-settings writers + MCP registration
 * argv builders (agent-bootstrap plan: G5, G1, CX2-17, CX-P1.4, ENG-7).
 *
 * settings.local.json has NO comment-marker boundary (it's JSON), so the
 * managed-block idiom from frontmatter-install-hook.ts does not apply
 * [CX2-17]. Instead this is a STRUCTURAL JSON merger: gbrain-owned hook
 * entries are keyed by a `_gbrain` marker property on the command object
 * (host-specs.ts owns the marker + every other format assumption), removal
 * and dedupe match on the marker (surviving reordering and command-string
 * drift), and foreign hooks / permissions / every other settings key are
 * never touched. Writes are atomic (tmp + rename) with a `.bak` of the
 * previous file; a parse-broken existing file ABORTS the write with
 * fix-and-re-run instructions (fail-closed, matching removal's stance — a
 * rewrite could drop permissions/allowlist entries gbrain cannot parse) [G5].
 *
 * MCP registration helpers BUILD ARGV ONLY — the bootstrap dispatcher execs
 * them (and records the registration in the install receipt). Precedent:
 * connect.ts `buildClaudeMcpAddArgv`/`buildCodexMcpAddArgv` [ENG-7] — those
 * build the REMOTE-HTTP shape (`-t http <url>` + bearer token) and cannot
 * express a local stdio serve with env bindings, so the local shape lives
 * here rather than wrapping them. Env is explicit on the registration
 * [CX-P1.4]: GUI-spawned serves inherit no shell env, so GBRAIN_SOURCE [G1]
 * (and GBRAIN_HOME when isolated) ride the registration itself.
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { atomicWriteTextFile } from './atomic-write.ts';
import { normalizeSeatLabel } from '../context/seat.ts';
import { detectExecutionEnvironment } from '../execution-env.ts';
import { stdioServeArgv } from '../mcp-registration.ts';
import type { McpSurface } from '../../mcp/surface.ts';
import type { HarnessReceipt, HarnessTarget } from './format.ts';
import {
  CLAUDE_COMMITTED_SETTINGS_FILE_RELPATH,
  CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS,
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_SUBCOMMAND,
  CLAUDE_SETTINGS_FILE_RELPATH,
  GBRAIN_HARNESS_MARKER_VALUE,
  GBRAIN_HOOK_MARKER_KEY,
  GBRAIN_HOOK_MARKER_VALUE,
  type ClaudeHookEvent,
} from './host-specs.ts';

// ── Types ───────────────────────────────────────────────────────────────────

/** Env vars embedded in each hook command string [G1, CX-P1.4]. */
export interface ClaudeHookEnv {
  /** Workspace source binding so hook context is source-scoped [G1]. Omitted
   * ONLY by the harness lane when a live PGLite serve hides which source it
   * resolves: an unpinned hook names no source, so the serve answers with its
   * own binding instead of rejecting a wrong claim as `source_mismatch`. The
   * committed carrier (buildPortableClaudeHookCommand) always requires it. */
  GBRAIN_SOURCE?: string;
  /** Set only for --isolated installs (PARENT dir; config appends `.gbrain`). */
  GBRAIN_HOME?: string;
  /**
   * 'harness' on #4043 harness-mode wiring: `gbrain hook` yields when the
   * lane is harness AND the cwd carries a workspace bootstrap install, so
   * the same event never fires twice (Claude Code merges settings scopes).
   */
  GBRAIN_HOOK_LANE?: string;
  /**
   * #4618 seat label credited on captured sessions (`--seat`). Undefined
   * keeps the seat a prior install of the same marker rendered; '' clears it
   * (`--no-seat`). Local carriers only: the committed carrier travels between
   * machines and never carries a seat.
   */
  GBRAIN_SEAT?: string;
}

export interface WriteClaudeHooksOpts {
  /** Absolute path to the gbrain binary (GUI hosts inherit no PATH) [CX-P1.4]. */
  gbrainBin: string;
  env: ClaudeHookEnv;
  /** Per-event timeout override (SECONDS — the settings-file unit). */
  timeoutSecs?: Partial<Record<ClaudeHookEvent, number>>;
  /** Subset of events to wire; default every event in CLAUDE_HOOK_EVENTS. */
  events?: ClaudeHookEvent[];
  /**
   * Marker VALUE stamped on (and stripped from) our entries. Default is the
   * workspace-install marker; harness mode passes GBRAIN_HARNESS_MARKER_VALUE
   * so the two installs coexist and each removal strips only its own.
   */
  marker?: string;
  /**
   * [D12] Events already owned by the COMMITTED settings carrier — the writer
   * strips stale local copies of these but re-adds nothing for them, so one
   * event never fires from both files. The workspace wrapper derives it from
   * committedHookEvents(ws); path-parameterized callers pass their own.
   */
  carriedEvents?: Set<ClaudeHookEvent>;
  /**
   * Backup strategy for the pre-write copy. 'fixed' (default) keeps the
   * historical `.bak` sibling; 'timestamped' avoids the shared-slot problem
   * when two writers touch the same file in one transaction.
   */
  backupStrategy?: 'fixed' | 'timestamped';
  /**
   * Refuse when a gbrain entry with a DIFFERENT marker already wires one of
   * our target events in this file (harness lane: a workspace install or a
   * differently-scoped harness install owns it — double-wiring would fire the
   * same hook twice per event) [C6].
   */
  refuseOnForeignGbrainMarker?: boolean;
  /**
   * Mode for a FRESHLY-CREATED settings file (existing files keep their mode
   * via the atomic writer). Harness user-scope writes pass 0o600 to match
   * Claude Code's own convention for that file [X11].
   */
  freshMode?: number;
  /**
   * Harness lane: unmarked entries whose command is exactly this identity's
   * harness hook are replaced like marked ones (the host can drop the marker
   * key); harness-looking entries outside it survive and get a note.
   */
  identity?: HarnessHookIdentity;
}

export interface WriteClaudeHooksResult {
  settingsPath: string;
  installed: Array<{ event: ClaudeHookEvent; command: string }>;
  /** Prior marker-carrying entries replaced (idempotent re-run dedupe). */
  removedPrior: number;
  /** `.bak` of the pre-write file (null when no file existed). */
  backupPath: string | null;
  /** Always null since the fail-closed change (a parse-broken file now
   *  aborts the write instead of being moved aside). Kept for result-shape
   *  stability. */
  brokenBackupPath: string | null;
  notes: string[];
  /** Seat label rendered into the new commands ('' for none). */
  seat: string;
}

export interface RemoveClaudeHooksResult {
  settingsPath: string;
  /** Entries removed (marked plus unmarked-but-ours). */
  removed: number;
  backupPath: string | null;
  notes: string[];
  /** Unmarked entries removed because their command is this install's harness hook. */
  unmarked: Array<{ event: string; why: string }>;
  /** Events holding a harness-looking entry that is not this install's; never deleted. */
  unowned: string[];
}

/** Who may claim an UNMARKED harness hook entry: the launchers, sources and
 * seats this install (or its harness receipt) rendered. A `null` source is an
 * unpinned hook (no GBRAIN_SOURCE); `seats` undefined accepts any seat label
 * (the receipt recorded none). */
export interface HarnessHookIdentity {
  launchers: string[];
  sources: Array<string | null>;
  seats?: string[];
}

export type HarnessHookOwnership = 'marked' | 'command' | 'unowned';

/** One command object inside a hook matcher group (host-specs shape). */
interface HookCommandEntry {
  type: 'command';
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks?: unknown[];
  [key: string]: unknown;
}

type SettingsObject = Record<string, unknown>;

// ── Helpers ─────────────────────────────────────────────────────────────────

export function claudeSettingsPath(workspaceDir: string): string {
  return join(workspaceDir, CLAUDE_SETTINGS_FILE_RELPATH);
}

/**
 * POSIX single-quote anything not already shell-safe (mirror of connect.ts's
 * private shellQuote — same contract: `$()`/backticks in a value are inert
 * literals). `=` is in the safe set so plain `K=V` env assignments stay bare.
 */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_.:/@=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Render the hook command string: `env K=V… <bin> hook <subcommand>`. The
 * harness lane recognizes its unmarked entries by parsing exactly this shape
 * back (parseClaudeHookCommand), so the two change together. */
export function buildClaudeHookCommand(
  gbrainBin: string,
  event: ClaudeHookEvent,
  env: ClaudeHookEnv,
): string {
  const assignments: string[] = [];
  if (env.GBRAIN_SOURCE !== undefined) assignments.push(`GBRAIN_SOURCE=${env.GBRAIN_SOURCE}`);
  if (env.GBRAIN_HOME) assignments.push(`GBRAIN_HOME=${env.GBRAIN_HOME}`);
  if (env.GBRAIN_HOOK_LANE) assignments.push(`GBRAIN_HOOK_LANE=${env.GBRAIN_HOOK_LANE}`);
  if (env.GBRAIN_SEAT) assignments.push(`GBRAIN_SEAT=${env.GBRAIN_SEAT}`);
  const parts = ['env', ...assignments, gbrainBin, 'hook', CLAUDE_HOOK_SUBCOMMAND[event]];
  return parts.map(shellQuote).join(' ');
}

const HOOK_ENV_KEYS: ReadonlySet<string> = new Set(['GBRAIN_SOURCE', 'GBRAIN_HOME', 'GBRAIN_HOOK_LANE', 'GBRAIN_SEAT']);

/**
 * The inverse of buildClaudeHookCommand: `env K=V… <abs bin> hook <sub>` with
 * nothing before or after, words split the way shellQuote joins them, env keys
 * limited to the ones the builder writes (each at most once), and a final
 * check that re-rendering the parse yields the exact input. Null for anything
 * else (an appended pipe, an extra flag, hand quoting, a relative launcher).
 */
export function parseClaudeHookCommand(command: string): { gbrainBin: string; subcommand: string; env: ClaudeHookEnv } | null {
  const words: string[] = [];
  const word = /([A-Za-z0-9_.:/@=-]+|'(?:[^']|'\\'')*')(?: |$)/y;
  while (word.lastIndex < command.length) {
    const m = word.exec(command);
    if (!m) return null;
    words.push(m[1]!.startsWith("'") ? m[1]!.slice(1, -1).replace(/'\\''/g, "'") : m[1]!);
  }
  if (words[0] !== 'env' || words.length < 4) return null;
  const env: Record<string, string> = {};
  let i = 1;
  for (; i < words.length - 3; i++) {
    const eq = words[i]!.indexOf('=');
    if (eq < 0) break;
    const key = words[i]!.slice(0, eq);
    if (!HOOK_ENV_KEYS.has(key) || key in env) return null;
    env[key] = words[i]!.slice(eq + 1);
  }
  const [gbrainBin, verb, subcommand] = words.slice(i) as [string, string, string];
  if (words.length - i !== 3 || verb !== 'hook' || !isAbsolute(gbrainBin)) return null;
  const event = CLAUDE_HOOK_EVENTS.find((e) => CLAUDE_HOOK_SUBCOMMAND[e] === subcommand);
  if (!event || buildClaudeHookCommand(gbrainBin, event, env) !== command) return null;
  return { gbrainBin, subcommand, env };
}

/**
 * Harness-lane ownership of one hook entry under `event`. Claude Code drops
 * keys it does not know when it rewrites settings.json, so the `_gbrain`
 * marker is advisory there and the command is the durable carrier:
 *  - `marked`: the entry carries the harness marker.
 *  - `command`: no marker key, the command is exactly the harness hook this
 *    event runs, and its launcher, source and seat belong to `identity` (with
 *    no GBRAIN_HOME: the harness lane never renders one). `'any'` skips the
 *    identity check, for guards that only ask whether a harness hook exists.
 *  - `unowned`: no marker key and it looks like a harness hook (lane token +
 *    `hook`) under an event gbrain wires, but it was edited or belongs to
 *    another install. Never deleted.
 * Null for everything else (other markers, foreign hooks, events gbrain does
 * not wire). `why` names the match, never the command text.
 */
export function classifyHarnessHook(
  entry: unknown,
  event: string,
  identity: HarnessHookIdentity | 'any',
): { ownership: HarnessHookOwnership; why: string } | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (e[GBRAIN_HOOK_MARKER_KEY] === GBRAIN_HARNESS_MARKER_VALUE) return { ownership: 'marked', why: 'carries the harness marker' };
  if (Object.prototype.hasOwnProperty.call(e, GBRAIN_HOOK_MARKER_KEY) || typeof e.command !== 'string') return null;
  const sub = (CLAUDE_HOOK_SUBCOMMAND as Record<string, string | undefined>)[event];
  if (!sub || !/(?:^|[\s'])GBRAIN_HOOK_LANE=harness(?=[\s']|$)/.test(e.command) || !/\shook(?:\s|$)/.test(e.command)) return null;
  const parsed = parseClaudeHookCommand(e.command);
  if (!parsed || parsed.env.GBRAIN_HOOK_LANE !== 'harness' || parsed.subcommand !== sub) {
    return { ownership: 'unowned', why: `not the exact \`hook ${sub}\` command gbrain writes (edited or extended)` };
  }
  if (identity === 'any') return { ownership: 'command', why: 'harness hook command shape' };
  if (parsed.env.GBRAIN_HOME !== undefined) return { ownership: 'unowned', why: 'carries GBRAIN_HOME, which this install never writes' };
  if (!identity.launchers.includes(parsed.gbrainBin)) return { ownership: 'unowned', why: 'its launcher is not this install\'s' };
  const source = parsed.env.GBRAIN_SOURCE ?? null;
  if (!identity.sources.includes(source)) return { ownership: 'unowned', why: 'its source is not this install\'s' };
  if (identity.seats && !identity.seats.includes(parsed.env.GBRAIN_SEAT ?? '')) return { ownership: 'unowned', why: 'its seat is not this install\'s' };
  return {
    ownership: 'command',
    why: `no _gbrain marker; exact \`hook ${sub}\` command with this install's launcher and ${source === null ? 'no source pin' : `source '${source}'`}`,
  };
}

/**
 * The identity an unmarked harness entry must match: the current install's
 * launcher/source/seat plus what the receipt recorded for `target` (its
 * launcher and seat) and the receipt's source binding. Seats constrain only
 * when the receipt recorded one.
 */
export function harnessHookIdentity(
  receipt: Pick<HarnessReceipt, 'source_id' | 'source_pinned'> | null,
  target: Pick<HarnessTarget, 'launcher' | 'seat'> | undefined,
  current: { launcher?: string | null; source?: string | null; seat?: string },
): HarnessHookIdentity {
  const launchers = [current.launcher, target?.launcher].filter((l): l is string => typeof l === 'string' && l !== '');
  const sources: Array<string | null> = [];
  if (current.source !== undefined) sources.push(current.source);
  if (receipt) sources.push(receipt.source_pinned === false ? null : receipt.source_id);
  if (target?.seat === undefined) return { launchers, sources };
  return { launchers, sources, seats: [target.seat, ...(current.seat !== undefined ? [current.seat] : [])] };
}

/**
 * `--seat <label>` / `--no-seat` → the hook env's GBRAIN_SEAT: the validated
 * label, '' to clear a carried seat, or undefined to keep the installed one.
 * With the workspace lane's `harness`, `note` says where a seat cannot be
 * rendered into a hook command and how to set it instead.
 */
export function parseSeatFlags(rest: string[], harness?: string): { seat?: string; error?: string; note?: string } {
  const noSeat = rest.includes('--no-seat');
  const i = rest.indexOf('--seat');
  if (i < 0) return noSeat ? { seat: '' } : {};
  if (noSeat) return { error: 'pass --seat <label> OR --no-seat, not both' };
  const raw = rest[i + 1];
  const seat = raw === undefined || raw.startsWith('--') ? null : normalizeSeatLabel(raw);
  if (seat === null) {
    return {
      error:
        `invalid --seat '${raw ?? ''}': a seat label is 1-64 characters of a-z, 0-9, '.', '_' or '-', ` +
        'starting with a letter or digit — re-run with a valid label, e.g. `--seat alice-desk`',
    };
  }
  if (harness === 'codex') {
    return { seat, note: `note: --seat applies to Claude Code hooks; codex sessions are credited to their CODEX_HOME seat (home-<hash>) unless GBRAIN_SEAT=${seat} is set in the environment codex runs in.` };
  }
  if (harness === 'opencode') return { seat, note: 'note: --seat has no effect for opencode — gbrain installs no opencode session-capture hooks.' };
  if (harness === 'claude-code' && detectExecutionEnvironment() === 'cloud-sandbox') {
    return { seat, note: `note: --seat is not written to the COMMITTED hook carrier (it travels with the repo) — set GBRAIN_SEAT=${seat} in this cloud environment's variables instead.` };
  }
  return { seat };
}

/** The seat a prior install of `marker` rendered into this file's hook
 * commands: marked entries first, then unmarked entries `identity` owns. */
function installedSeat(hooks: Record<string, unknown>, marker: string, identity?: HarnessHookIdentity): string | undefined {
  for (const claim of identity ? ['marked', 'command'] : ['marked']) {
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const entries = (group as HookMatcherGroup)?.hooks;
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const ours = claim === 'marked' ? isOurs(entry, marker) : classifyHarnessHook(entry, event, identity!)?.ownership === 'command';
          if (!ours || typeof (entry as HookCommandEntry).command !== 'string') continue;
          const m = /(?:^| )GBRAIN_SEAT=([a-z0-9][a-z0-9._-]{0,63})(?= )/.exec((entry as HookCommandEntry).command);
          if (m) return m[1];
        }
      }
    }
  }
  return undefined;
}

export function claudeCommittedSettingsPath(workspaceDir: string): string {
  return join(workspaceDir, CLAUDE_COMMITTED_SETTINGS_FILE_RELPATH);
}

/**
 * The COMMITTED carrier's command [D12]: PATH-resolved and fail-open. No
 * absolute binary path — the committed file travels between machines and
 * cloud sessions; wherever gbrain is not installed the hook exits 0 silently
 * instead of erroring every turn.
 */
export function buildPortableClaudeHookCommand(event: ClaudeHookEvent, env: ClaudeHookEnv): string {
  if (env.GBRAIN_SOURCE === undefined) {
    throw new Error('the committed hook carrier must be source-scoped [G1] — GBRAIN_SOURCE is required');
  }
  const assignments: string[] = [`GBRAIN_SOURCE=${env.GBRAIN_SOURCE}`];
  if (env.GBRAIN_HOME) assignments.push(`GBRAIN_HOME=${env.GBRAIN_HOME}`);
  const invoke = ['env', ...assignments, 'gbrain', 'hook', CLAUDE_HOOK_SUBCOMMAND[event]]
    .map(shellQuote)
    .join(' ');
  return `command -v gbrain >/dev/null 2>&1 && ${invoke} || exit 0`;
}

/** Events the COMMITTED settings file already carries with our marker [D12]
 * — the local writer skips these so one event never fires from both files. */
/** Pull the GBRAIN_SOURCE value out of a rendered portable hook command so the
 * exact-match check is agnostic to the (operator-chosen) source id. Returns
 * null when the command isn't shaped like ours. */
function extractHookSource(command: string): string | null {
  const m = /command -v gbrain >\/dev\/null 2>&1 && env GBRAIN_SOURCE=('[^']*'|[^ ]+) gbrain hook /.exec(command);
  if (!m) return null;
  const raw = m[1]!;
  return raw.startsWith("'") ? raw.slice(1, -1).replace(/'\\''/g, "'") : raw;
}

export function committedHookEvents(workspaceDir: string): Set<ClaudeHookEvent> {
  const carried = new Set<ClaudeHookEvent>();
  try {
    const raw = readFileSync(claudeCommittedSettingsPath(workspaceDir), 'utf8');
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    const hooks = parsed?.hooks;
    if (typeof hooks !== 'object' || hooks === null) return carried;
    for (const event of CLAUDE_HOOK_EVENTS) {
      const groups = (hooks as Record<string, unknown>)[event];
      if (!Array.isArray(groups)) continue;
      const ours = groups.some(
        (g) =>
          typeof g === 'object' && g !== null &&
          Array.isArray((g as HookMatcherGroup).hooks) &&
          ((g as HookMatcherGroup).hooks as unknown[]).some(
            (h) =>
              isOurs(h) &&
              // A committed file is repo-contributor-writable: a marker + a
              // bare `includes('gbrain hook')` substring is spoofable
              // (`evil; # gbrain hook` suppresses the real local install AND
              // runs attacker code). Require the EXACT portable-command shape
              // this event would render — the anchored `command -v gbrain …`
              // guard + `|| exit 0` structure a foreign command can't fake.
              typeof (h as HookCommandEntry).command === 'string' &&
              (h as HookCommandEntry).command === buildPortableClaudeHookCommand(event, {
                GBRAIN_SOURCE: extractHookSource((h as HookCommandEntry).command as string) ?? '',
              }),
          ),
      );
      if (ours) carried.add(event);
    }
  } catch {
    /* absent/corrupt committed file → nothing carried */
  }
  return carried;
}

function isOurs(entry: unknown, marker: string = GBRAIN_HOOK_MARKER_VALUE): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as Record<string, unknown>)[GBRAIN_HOOK_MARKER_KEY] === marker
  );
}

/** True when the entry carries the gbrain marker KEY with any OTHER value. */
function isForeignGbrainMarked(entry: unknown, marker: string): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const v = (entry as Record<string, unknown>)[GBRAIN_HOOK_MARKER_KEY];
  return typeof v === 'string' && v !== marker;
}

/**
 * Strip marker-carrying command entries from one event's matcher-group array.
 * Groups EMPTIED by the removal are dropped; groups that were already empty
 * (foreign) survive untouched. Returns the surviving groups + removal count.
 * The group-drop rule is marker-independent: it fires only when THIS call's
 * filter emptied a previously non-empty group, so it can never drop a group a
 * different marker still owns.
 */
function stripOurEntries(
  groups: unknown[],
  marker: string = GBRAIN_HOOK_MARKER_VALUE,
  owned?: { event: string; identity: HarnessHookIdentity },
): { kept: unknown[]; removed: number; unmarked: string[]; unowned: number } {
  const kept: unknown[] = [];
  let removed = 0;
  const unmarked: string[] = [];
  let unowned = 0;
  for (const group of groups) {
    if (typeof group !== 'object' || group === null || !Array.isArray((group as HookMatcherGroup).hooks)) {
      kept.push(group); // structurally foreign — never touch
      continue;
    }
    const g = group as HookMatcherGroup;
    const before = g.hooks!.length;
    const filtered = g.hooks!.filter((h) => {
      if (isOurs(h, marker)) return false;
      if (!owned) return true;
      const c = classifyHarnessHook(h, owned.event, owned.identity);
      if (c?.ownership === 'unowned') unowned++;
      if (c?.ownership !== 'command') return true;
      unmarked.push(c.why);
      return false;
    });
    removed += before - filtered.length;
    if (filtered.length === 0 && before > 0 && filtered.length !== before) {
      continue; // we emptied it → drop the husk
    }
    if (filtered.length !== before) {
      kept.push({ ...g, hooks: filtered });
    } else {
      kept.push(group);
    }
  }
  return { kept, removed, unmarked, unowned };
}

/**
 * Atomic write (tmp + rename), creating parent dirs. Hardened for shared
 * user-scope targets [C10]: the SYMLINK TARGET is resolved first so a
 * dotfile-manager-linked settings file survives as a link (a bare rename
 * would replace the link with a regular file); the tmp file uses a random
 * suffix and inherits the existing file's mode (a 0600 file stays 0600 —
 * the pid-suffixed umask-default tmp was fine for gitignored workspace files
 * but not for user-global config).
 */
function atomicWriteJson(path: string, value: unknown, freshMode?: number): void {
  // Shared bootstrap atomic writer (symlink-resolving, mode-inheriting) —
  // fresh files take the caller's convention (user-scope → 0600) [X11].
  atomicWriteTextFile(path, `${JSON.stringify(value, null, 2)}\n`, { freshMode });
}

/** Pre-write backup path per strategy; timestamped avoids the shared-slot loss. */
function backupPathFor(settingsPath: string, strategy: 'fixed' | 'timestamped'): string {
  return strategy === 'timestamped' ? `${settingsPath}.bak-${Date.now()}` : `${settingsPath}.bak`;
}

interface LoadedSettings {
  settings: SettingsObject;
  existed: boolean;
  brokenBackupPath: string | null;
  notes: string[];
}

/**
 * Parse the existing settings file. Absent/empty → `{}`. Parse error →
 * THROW, fail-closed [G5]: the file may carry permissions/allowlist entries
 * gbrain cannot see, so replacing it with a fresh file (the old behavior —
 * backup + start clean) silently dropped the user's live settings. Removal
 * (`removeClaudeHooks`) already refuses to touch what it cannot parse; the
 * write path now matches that stance. The user fixes the JSON, re-runs, and
 * the structural merge preserves everything.
 */
function loadSettings(path: string): LoadedSettings {
  const notes: string[] = [];
  if (!existsSync(path)) {
    return { settings: {}, existed: false, brokenBackupPath: null, notes };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  if (raw.trim() === '') {
    return { settings: {}, existed: true, brokenBackupPath: null, notes };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings root is not a JSON object');
    }
    return { settings: parsed as SettingsObject, existed: true, brokenBackupPath: null, notes };
  } catch (e) {
    throw new Error(
      `${path} is not valid JSON (${(e as Error).message}) — refusing to rewrite a settings file ` +
        `gbrain cannot parse (it may carry your permissions/allowlist entries). Fix the JSON by ` +
        `hand, then re-run \`gbrain bootstrap hooks --harness claude-code --repair\` ` +
        `(the structural merge preserves your settings).`,
    );
  }
}

// ── Writers [G5, CX2-17] ────────────────────────────────────────────────────

/**
 * Structural-merge gbrain's hook entries into an EXPLICIT settings file
 * (workspace settings.local.json or user-scope ~/.claude/settings.json).
 * Idempotent: prior same-marker entries are removed before the fresh set is
 * appended (run twice → one entry per event). Foreign hooks, other-marker
 * gbrain entries, permissions, and every other key survive byte-for-byte at
 * the structural level.
 */
export function writeClaudeHooksAt(
  settingsPath: string,
  opts: WriteClaudeHooksOpts,
): WriteClaudeHooksResult {
  if (!isAbsolute(opts.gbrainBin)) {
    throw new Error(`gbrainBin must be an absolute path (GUI hosts inherit no PATH); got: ${opts.gbrainBin}`);
  }
  for (const [k, v] of Object.entries(opts.env)) {
    if (typeof v === 'string' && /[\n\r\0]/.test(v)) {
      throw new Error(`env ${k} contains control characters — refusing to embed in a hook command`);
    }
  }
  const marker = opts.marker ?? GBRAIN_HOOK_MARKER_VALUE;
  const backupStrategy = opts.backupStrategy ?? 'fixed';

  const { settings, existed, brokenBackupPath, notes } = loadSettings(settingsPath);

  // hooks key: merge into an object; a structurally-foreign value is backed
  // up via the .bak below and replaced (we cannot merge into a non-object).
  let hooks = settings.hooks as Record<string, unknown> | undefined;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    if (hooks !== undefined) {
      notes.push(
        `WARNING: existing "hooks" key was not an object (${JSON.stringify(hooks).slice(0, 80)}); ` +
          `replaced — the original file is in the .bak backup.`,
      );
    }
    hooks = {};
  }

  const events = opts.events ?? [...CLAUDE_HOOK_EVENTS];

  // [C6] Same command double-fire guard: refuse when a gbrain entry carrying a
  // DIFFERENT marker already wires one of our target events in this file —
  // Claude Code would run both.
  if (opts.refuseOnForeignGbrainMarker) {
    for (const event of events) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const g = group as HookMatcherGroup;
        if (!Array.isArray(g?.hooks)) continue;
        for (const entry of g.hooks) {
          if (isForeignGbrainMarked(entry, marker)) {
            const foreign = (entry as Record<string, unknown>)[GBRAIN_HOOK_MARKER_KEY];
            throw new Error(
              `${settingsPath} already wires hooks.${event} under gbrain marker "${String(foreign)}" — ` +
                `refusing to double-wire the same hook (both entries would fire every event). ` +
                `Remove the other install first (gbrain bootstrap harness --remove, or gbrain bootstrap uninstall).`,
            );
          }
        }
      }
    }
  }

  // [D12] Dedupe invariant: an event carried by the COMMITTED settings file
  // never also fires from the local file. The caller supplies the carried set
  // (the workspace wrapper reads it from committedHookEvents(ws); the harness
  // --project lane does the same for its dirs) — this path-parameterized
  // writer has no workspace to derive it from.
  const carried = opts.carriedEvents ?? new Set<ClaudeHookEvent>();
  // #4618: a re-install without --seat keeps the seat the prior install chose.
  const env = opts.env.GBRAIN_SEAT === undefined
    ? { ...opts.env, GBRAIN_SEAT: installedSeat(hooks, marker, opts.identity) }
    : opts.env;
  let removedPrior = 0;
  const installed: Array<{ event: ClaudeHookEvent; command: string }> = [];

  // [X3] Convergence: strip OUR marker from EVERY event in the file first —
  // not just the requested subset — so a re-run with fewer events (e.g.
  // --no-capture dropping Stop/SessionEnd) removes the ones no longer wanted
  // instead of leaving them live. Foreign and other-marker entries survive.
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue; // structurally foreign — never touch
    const { kept, removed, unowned } = stripOurEntries(groups, marker, opts.identity && { event, identity: opts.identity });
    removedPrior += removed;
    if (unowned > 0) {
      notes.push(
        `hooks.${event} in ${settingsPath} holds an entry that looks like gbrain's harness hook but is not this install's ` +
          `exact command (code harness_hook_unowned); left in place — if it is a leftover it fires next to the new entry, so delete it by hand.`,
      );
    }
    if (removed === 0) continue;
    if (kept.length === 0) {
      delete hooks[event]; // emptied by OUR removal — drop the key
    } else {
      hooks[event] = kept;
    }
  }

  for (const event of events) {
    let groups = hooks[event];
    if (!Array.isArray(groups)) {
      if (groups !== undefined) {
        notes.push(
          `WARNING: existing hooks.${event} was not an array; replaced — original in the .bak backup.`,
        );
      }
      groups = [];
    }
    const kept = [...(groups as unknown[])];

    if (carried.has(event)) {
      notes.push(`${event}: carried by the committed .claude/settings.json — local entry skipped [D12]`);
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
      continue;
    }

    const command = buildClaudeHookCommand(opts.gbrainBin, event, env);
    const timeout = opts.timeoutSecs?.[event] ?? CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS[event];
    const entry: HookCommandEntry = {
      type: 'command',
      command,
      timeout,
      [GBRAIN_HOOK_MARKER_KEY]: marker,
    };
    kept.push({ hooks: [entry] });
    hooks[event] = kept;
    installed.push({ event, command });
  }

  settings.hooks = hooks;

  let backupPath: string | null = null;
  if (existed && brokenBackupPath === null) {
    backupPath = backupPathFor(settingsPath, backupStrategy);
    copyFileSync(settingsPath, backupPath);
  }
  atomicWriteJson(settingsPath, settings, opts.freshMode);

  return { settingsPath, installed, removedPrior, backupPath, brokenBackupPath, notes, seat: env.GBRAIN_SEAT ?? '' };
}

/**
 * Workspace-lane wrapper (historical signature: `<ws>/.claude/settings.local.json`,
 * bootstrap-v1 marker, fixed `.bak`). Supplies the [D12] carried-events set so
 * an event owned by the committed carrier never also fires locally.
 */
export function writeClaudeHooks(
  workspaceDir: string,
  opts: WriteClaudeHooksOpts,
): WriteClaudeHooksResult {
  return writeClaudeHooksAt(claudeSettingsPath(workspaceDir), {
    carriedEvents: committedHookEvents(workspaceDir),
    ...opts,
  });
}

/**
 * Write hooks into the COMMITTED `.claude/settings.json` [D12] — the only
 * carrier that survives into fresh cloud clones (hooks are snapshotted at
 * session start; the gitignored local file never exists there). Commands are
 * PATH-resolved and fail-open (buildPortableClaudeHookCommand). After the
 * committed write, the same events are stripped from the LOCAL file so an
 * event never fires from both carriers.
 */
export function writeCommittedClaudeHooks(
  workspaceDir: string,
  opts: { env: ClaudeHookEnv; events?: ClaudeHookEvent[]; timeoutSecs?: Partial<Record<ClaudeHookEvent, number>> },
): WriteClaudeHooksResult {
  if (opts.env.GBRAIN_HOME) {
    throw new Error(
      'GBRAIN_HOME is machine-specific and must not be embedded in the COMMITTED hook carrier ' +
        '(the file travels between machines) — isolated installs stay on the local carrier',
    );
  }
  for (const [k, v] of Object.entries(opts.env)) {
    if (typeof v === 'string' && /[\n\r\0]/.test(v)) {
      throw new Error(`env ${k} contains control characters — refusing to embed in a hook command`);
    }
  }
  const settingsPath = claudeCommittedSettingsPath(workspaceDir);
  const { settings, existed, brokenBackupPath, notes } = loadSettings(settingsPath);
  let hooks = settings.hooks as Record<string, unknown> | undefined;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    if (hooks !== undefined) {
      notes.push(
        `WARNING: existing "hooks" key was not an object (${JSON.stringify(hooks).slice(0, 80)}); ` +
          `replaced — the original file is in the .bak backup.`,
      );
    }
    hooks = {};
  }
  const events = opts.events ?? [...CLAUDE_HOOK_EVENTS];
  let removedPrior = 0;
  const installed: Array<{ event: ClaudeHookEvent; command: string }> = [];
  for (const event of events) {
    let groups = hooks[event];
    if (!Array.isArray(groups)) {
      if (groups !== undefined) {
        notes.push(`WARNING: existing hooks.${event} was not an array; replaced — original in the .bak backup.`);
      }
      groups = [];
    }
    const { kept, removed } = stripOurEntries(groups as unknown[]);
    removedPrior += removed;
    const command = buildPortableClaudeHookCommand(event, opts.env);
    const timeout = opts.timeoutSecs?.[event] ?? CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS[event];
    const entry: HookCommandEntry = {
      type: 'command',
      command,
      timeout,
      [GBRAIN_HOOK_MARKER_KEY]: GBRAIN_HOOK_MARKER_VALUE,
    };
    kept.push({ hooks: [entry] });
    hooks[event] = kept;
    installed.push({ event, command });
  }
  settings.hooks = hooks;
  let backupPath: string | null = null;
  if (existed && brokenBackupPath === null) {
    backupPath = `${settingsPath}.bak`;
    copyFileSync(settingsPath, backupPath);
  }
  atomicWriteJson(settingsPath, settings);

  // [D12] dedupe: the committed carrier now owns these events — remove any
  // local copies so nothing double-fires on this machine.
  const localCleanup = removeClaudeHooksAt(claudeSettingsPath(workspaceDir));
  if (localCleanup.removed > 0) {
    notes.push(
      `removed ${localCleanup.removed} local settings.local.json entr${localCleanup.removed === 1 ? 'y' : 'ies'} — the committed carrier owns the events now [D12]`,
    );
  }

  return { settingsPath, installed, removedPrior, backupPath, brokenBackupPath, notes, seat: '' };
}

/**
 * Remove ONLY entries carrying the given marker [G5]. A parse-broken file is
 * left untouched (removal must never destroy what it cannot read) — the note
 * says so. Event arrays we emptied lose their key; an emptied hooks object
 * loses its key; foreign structure (including other-marker gbrain entries)
 * survives.
 */
export function removeClaudeHooksAt(
  settingsPath: string,
  marker: string = GBRAIN_HOOK_MARKER_VALUE,
  opts: { identity?: HarnessHookIdentity; dryRun?: boolean } = {},
): RemoveClaudeHooksResult {
  const nothing = (note: string): RemoveClaudeHooksResult =>
    ({ settingsPath, removed: 0, backupPath: null, notes: [note], unmarked: [], unowned: [] });
  if (!existsSync(settingsPath)) return nothing('no settings file — nothing to remove');
  let settings: SettingsObject;
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    if (raw.trim() === '') return nothing('settings file empty — nothing to remove');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings root is not a JSON object');
    }
    settings = parsed as SettingsObject;
  } catch (e) {
    return nothing(
      `WARNING: ${settingsPath} is not valid JSON (${(e as Error).message}); ` +
        `left untouched — remove gbrain hook entries by hand or fix the JSON and re-run.`,
    );
  }

  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return nothing('no hooks object — nothing to remove');
  }

  let removed = 0;
  const unmarked: Array<{ event: string; why: string }> = [];
  const unowned: string[] = [];
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue; // structurally foreign — never touch
    const strip = stripOurEntries(groups, marker, opts.identity && { event, identity: opts.identity });
    const { kept, removed: n } = strip;
    removed += n;
    unmarked.push(...strip.unmarked.map((why) => ({ event, why })));
    if (strip.unowned > 0) unowned.push(event);
    if (n === 0) continue;
    if (kept.length === 0) {
      delete hooks[event]; // emptied by OUR removal — drop the key
    } else {
      hooks[event] = kept;
    }
  }
  if (removed > 0 && Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }

  let backupPath: string | null = null;
  if (removed > 0 && !opts.dryRun) {
    backupPath = `${settingsPath}.bak`;
    copyFileSync(settingsPath, backupPath);
    atomicWriteJson(settingsPath, settings);
  }
  return { settingsPath, removed, backupPath, notes: [], unmarked, unowned };
}

/**
 * Read-only census of one harness carrier: per wired event, how many entries
 * are marked, unmarked-but-ours (`command`) and harness-looking but not ours
 * (`unowned`). Doctor, `--status` and the cross-HOME `--project` guard use it;
 * nothing is written.
 */
export function scanHarnessHookCarrier(
  settingsPath: string,
  identity: HarnessHookIdentity | 'any',
): { state: 'absent' | 'unparseable' | 'ok'; error?: string; events: Partial<Record<ClaudeHookEvent, Record<HarnessHookOwnership, number>>> } {
  const events: Partial<Record<ClaudeHookEvent, Record<HarnessHookOwnership, number>>> = {};
  if (!existsSync(settingsPath)) return { state: 'absent', events };
  let hooks: unknown;
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    if (raw.trim() === '') return { state: 'ok', events };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('settings root is not a JSON object');
    hooks = (parsed as SettingsObject).hooks;
  } catch (e) {
    return { state: 'unparseable', error: (e as Error).message, events };
  }
  if (typeof hooks !== 'object' || hooks === null) return { state: 'ok', events };
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const entries = (group as HookMatcherGroup)?.hooks;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const c = classifyHarnessHook(entry, event, identity);
        if (!c) continue;
        const counts = (events[event] ??= { marked: 0, command: 0, unowned: 0 });
        counts[c.ownership]++;
      }
    }
  }
  return { state: 'ok', events };
}

/** True when an event's matcher groups carry any gbrain hook: an entry with a
 * `_gbrain` marker key, or an unmarked harness hook command (the host may have
 * dropped its marker). hook_carrier_overlap counts carriers with this. */
export function groupsCarryGbrainHook(groups: unknown, event: string): boolean {
  if (!Array.isArray(groups)) return false;
  return groups.some((group) => {
    const entries = (group as HookMatcherGroup)?.hooks;
    return Array.isArray(entries) && entries.some((entry) =>
      (typeof entry === 'object' && entry !== null && Object.prototype.hasOwnProperty.call(entry, GBRAIN_HOOK_MARKER_KEY)) ||
      classifyHarnessHook(entry, event, 'any')?.ownership === 'command');
  });
}

/**
 * Workspace-lane removal — cleans BOTH carriers (local + committed [D12]);
 * the returned settingsPath/backup describe the local one, with
 * committed-file actions reported via notes.
 */
export function removeClaudeHooks(workspaceDir: string): RemoveClaudeHooksResult {
  const local = removeClaudeHooksAt(claudeSettingsPath(workspaceDir));
  const committed = removeClaudeHooksAt(claudeCommittedSettingsPath(workspaceDir));
  const notes = [...local.notes];
  if (committed.removed > 0) {
    notes.push(`also removed ${committed.removed} entr${committed.removed === 1 ? 'y' : 'ies'} from the committed ${committed.settingsPath} [D12]`);
  } else {
    notes.push(...committed.notes.map((n) => `(committed carrier) ${n}`));
  }
  return {
    settingsPath: local.settingsPath,
    removed: local.removed + committed.removed,
    backupPath: local.backupPath,
    notes,
    unmarked: [],
    unowned: [],
  };
}

// ── permissions.allow writers (harness lane, #4043) ────────────────────────

export interface PermissionsAllowResult {
  settingsPath: string;
  /** add: entry appended this run. remove: number of occurrences removed. */
  added?: boolean;
  removed?: number;
  backupPath: string | null;
  notes: string[];
}

/**
 * Append one entry to `permissions.allow` (set semantics — present means
 * no-op). Stamps NO marker: permissions.allow is an array of plain strings,
 * so ownership is recorded on the harness receipt (exact-string removal),
 * never in the file — and a marker object here would false-positive
 * status.ts's whole-file `hooksInstalled` substring probe. Foreign entries
 * and every other settings key survive. Broken JSON aborts (user-scope
 * discipline — this writer only ever targets user-scope files).
 */
export function addPermissionsAllowEntry(
  settingsPath: string,
  entry: string,
): PermissionsAllowResult {
  const { settings, existed, notes } = loadSettings(settingsPath);

  let permissions = settings.permissions as Record<string, unknown> | undefined;
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    if (permissions !== undefined) {
      // Fail CLOSED (same stance as broken JSON): "permissions" is the host's
      // security policy — replacing a shape we don't understand could erase
      // deny/ask rules or a future settings schema (ship-review P2).
      throw new Error(
        `${settingsPath}: existing "permissions" key is not an object ` +
          `(${JSON.stringify(permissions).slice(0, 80)}) — refusing to rewrite security policy this writer ` +
          `does not understand. Fix the file by hand, then re-run.`,
      );
    }
    permissions = {};
  }
  let allow = permissions.allow as unknown[] | undefined;
  if (!Array.isArray(allow)) {
    if (allow !== undefined) {
      throw new Error(
        `${settingsPath}: existing permissions.allow is not an array — refusing to rewrite security policy ` +
          `this writer does not understand. Fix the file by hand, then re-run.`,
      );
    }
    allow = [];
  }

  if (allow.some((e) => e === entry)) {
    return { settingsPath, added: false, backupPath: null, notes: [...notes, `${entry} already allowed — no change`] };
  }

  allow.push(entry);
  permissions.allow = allow;
  settings.permissions = permissions;

  let backupPath: string | null = null;
  if (existed) {
    backupPath = backupPathFor(settingsPath, 'timestamped');
    copyFileSync(settingsPath, backupPath);
  }
  atomicWriteJson(settingsPath, settings, 0o600); // user-scope-only writer [X11]
  return { settingsPath, added: true, backupPath, notes };
}

/**
 * Remove EXACTLY the given string from `permissions.allow`. Parse-broken file
 * is left untouched (the removeClaudeHooks precedent — removal never destroys
 * what it cannot read). Keys are dropped only when OUR removal emptied them.
 * Honest edge (stated in consent copy): if the user had independently allowed
 * the same string, this removes it too — set semantics carry no provenance.
 */
export function removePermissionsAllowEntry(
  settingsPath: string,
  entry: string,
): PermissionsAllowResult {
  if (!existsSync(settingsPath)) {
    return { settingsPath, removed: 0, backupPath: null, notes: ['no settings file — nothing to remove'] };
  }
  let loaded: LoadedSettings;
  try {
    loaded = loadSettings(settingsPath);
  } catch (e) {
    return {
      settingsPath,
      removed: 0,
      backupPath: null,
      notes: [
        `WARNING: ${settingsPath} is not valid JSON (${(e as Error).message}); ` +
          `left untouched — remove the "${entry}" permissions.allow entry by hand or fix the JSON and re-run.`,
      ],
    };
  }
  const { settings, notes } = loaded;

  const permissions = settings.permissions as Record<string, unknown> | undefined;
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    return { settingsPath, removed: 0, backupPath: null, notes: ['no permissions object — nothing to remove'] };
  }
  const allow = permissions.allow as unknown[] | undefined;
  if (!Array.isArray(allow)) {
    return { settingsPath, removed: 0, backupPath: null, notes: ['no permissions.allow array — nothing to remove'] };
  }

  const kept = allow.filter((e) => e !== entry);
  const removed = allow.length - kept.length;
  if (removed === 0) {
    return { settingsPath, removed: 0, backupPath: null, notes: [...notes, `${entry} not present — nothing to remove`] };
  }

  if (kept.length > 0) {
    permissions.allow = kept;
  } else {
    delete permissions.allow; // emptied by OUR removal — drop the key
  }
  if (Object.keys(permissions).length === 0) {
    delete settings.permissions;
  }

  const backupPath = backupPathFor(settingsPath, 'timestamped');
  copyFileSync(settingsPath, backupPath);
  atomicWriteJson(settingsPath, settings, 0o600); // user-scope-only writer [X11]
  return { settingsPath, removed, backupPath, notes };
}

// ── MCP registration argv builders [G1, CX-P1.4, ENG-7] ────────────────────

export interface ClaudeMcpRegistration {
  /** MCP server name; default 'gbrain'. */
  name?: string;
  /** Absolute path to the gbrain binary. */
  gbrainBin: string;
  /** Registration scope — a consent question, never a default the user didn't pick [G16/D1]. */
  scope: 'project' | 'user';
  /** Workspace source slug [G1] — agent writes must land in the workspace source. */
  sourceId: string;
  /** PARENT dir for --isolated installs (config appends `.gbrain`) [CX2-8]. */
  gbrainHome?: string;
  /** The serve surface; default REGISTRATION_SURFACE, `null` = bare `serve` (never-narrow carry-over). */
  surface?: McpSurface | null;
}

export type CodexMcpRegistration = Omit<ClaudeMcpRegistration, 'scope'>;

/**
 * `claude mcp add` argv for a LOCAL stdio serve. Returns command argv arrays
 * (binary first) — the dispatcher execs them; nothing here touches the
 * filesystem or the network. Shape per TARGETS['claude-code-2026-08'].
 *
 * The serve argv comes from `stdioServeArgv`: `--surface full` by default
 * (REGISTRATION_SURFACE; bootstrap's contract — put_page, get_page,
 * add_timeline_entry, search, query — is in it, and a pre-existing `mcp_surface: verbs` config row cannot
 * narrow a pinned registration); `surface` carries an existing entry's form
 * over on replacement or applies `--surface`.
 */
export function registerClaudeMcp(p: ClaudeMcpRegistration): string[][] {
  if (!isAbsolute(p.gbrainBin)) {
    throw new Error(`gbrainBin must be an absolute path; got: ${p.gbrainBin}`);
  }
  const name = p.name ?? 'gbrain';
  const argv = [
    'claude', 'mcp', 'add', name,
    '--scope', p.scope,
    '-e', `GBRAIN_SOURCE=${p.sourceId}`,
  ];
  if (p.gbrainHome) argv.push('-e', `GBRAIN_HOME=${p.gbrainHome}`);
  argv.push('--', ...stdioServeArgv(p.gbrainBin, p.surface));
  return [argv];
}

/**
 * `codex mcp add` argv for a LOCAL stdio serve (writes ~/.codex/config.toml
 * itself — no TOML writer needed in v1, see TARGETS['codex-2026-08']).
 * Codex registrations are user-global; there is no scope flag. The serve
 * argv comes from `stdioServeArgv` (see registerClaudeMcp).
 */
export function registerCodexMcp(p: CodexMcpRegistration): string[][] {
  if (!isAbsolute(p.gbrainBin)) {
    throw new Error(`gbrainBin must be an absolute path; got: ${p.gbrainBin}`);
  }
  const name = p.name ?? 'gbrain';
  const argv = ['codex', 'mcp', 'add', name, '--env', `GBRAIN_SOURCE=${p.sourceId}`];
  if (p.gbrainHome) argv.push('--env', `GBRAIN_HOME=${p.gbrainHome}`);
  argv.push('--', ...stdioServeArgv(p.gbrainBin, p.surface));
  return [argv];
}
