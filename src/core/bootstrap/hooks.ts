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
import {
  CLAUDE_COMMITTED_SETTINGS_FILE_RELPATH,
  CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS,
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_SUBCOMMAND,
  CLAUDE_SETTINGS_FILE_RELPATH,
  GBRAIN_HOOK_MARKER_KEY,
  GBRAIN_HOOK_MARKER_VALUE,
  type ClaudeHookEvent,
} from './host-specs.ts';

// ── Types ───────────────────────────────────────────────────────────────────

/** Env vars embedded in each hook command string [G1, CX-P1.4]. */
export interface ClaudeHookEnv {
  /** Workspace source binding — required so hook context is source-scoped [G1]. */
  GBRAIN_SOURCE: string;
  /** Set only for --isolated installs (PARENT dir; config appends `.gbrain`). */
  GBRAIN_HOME?: string;
  /**
   * 'harness' on #4043 harness-mode wiring: `gbrain hook` yields when the
   * lane is harness AND the cwd carries a workspace bootstrap install, so
   * the same event never fires twice (Claude Code merges settings scopes).
   */
  GBRAIN_HOOK_LANE?: string;
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
}

export interface RemoveClaudeHooksResult {
  settingsPath: string;
  removed: number;
  backupPath: string | null;
  notes: string[];
}

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

/** Render the hook command string: `env K=V… <bin> hook <subcommand>`. */
export function buildClaudeHookCommand(
  gbrainBin: string,
  event: ClaudeHookEvent,
  env: ClaudeHookEnv,
): string {
  const assignments: string[] = [`GBRAIN_SOURCE=${env.GBRAIN_SOURCE}`];
  if (env.GBRAIN_HOME) assignments.push(`GBRAIN_HOME=${env.GBRAIN_HOME}`);
  if (env.GBRAIN_HOOK_LANE) assignments.push(`GBRAIN_HOOK_LANE=${env.GBRAIN_HOOK_LANE}`);
  const parts = ['env', ...assignments, gbrainBin, 'hook', CLAUDE_HOOK_SUBCOMMAND[event]];
  return parts.map(shellQuote).join(' ');
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
function stripOurEntries(groups: unknown[], marker: string = GBRAIN_HOOK_MARKER_VALUE): { kept: unknown[]; removed: number } {
  const kept: unknown[] = [];
  let removed = 0;
  for (const group of groups) {
    if (typeof group !== 'object' || group === null || !Array.isArray((group as HookMatcherGroup).hooks)) {
      kept.push(group); // structurally foreign — never touch
      continue;
    }
    const g = group as HookMatcherGroup;
    const before = g.hooks!.length;
    const filtered = g.hooks!.filter((h) => !isOurs(h, marker));
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
  return { kept, removed };
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
  let removedPrior = 0;
  const installed: Array<{ event: ClaudeHookEvent; command: string }> = [];

  // [X3] Convergence: strip OUR marker from EVERY event in the file first —
  // not just the requested subset — so a re-run with fewer events (e.g.
  // --no-capture dropping Stop/SessionEnd) removes the ones no longer wanted
  // instead of leaving them live. Foreign and other-marker entries survive.
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue; // structurally foreign — never touch
    const { kept, removed } = stripOurEntries(groups, marker);
    removedPrior += removed;
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

    const command = buildClaudeHookCommand(opts.gbrainBin, event, opts.env);
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

  return { settingsPath, installed, removedPrior, backupPath, brokenBackupPath, notes };
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

  return { settingsPath, installed, removedPrior, backupPath, brokenBackupPath, notes };
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
): RemoveClaudeHooksResult {
  const notes: string[] = [];
  if (!existsSync(settingsPath)) {
    return { settingsPath, removed: 0, backupPath: null, notes: ['no settings file — nothing to remove'] };
  }
  let settings: SettingsObject;
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    if (raw.trim() === '') {
      return { settingsPath, removed: 0, backupPath: null, notes: ['settings file empty — nothing to remove'] };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings root is not a JSON object');
    }
    settings = parsed as SettingsObject;
  } catch (e) {
    return {
      settingsPath,
      removed: 0,
      backupPath: null,
      notes: [
        `WARNING: ${settingsPath} is not valid JSON (${(e as Error).message}); ` +
          `left untouched — remove gbrain hook entries by hand or fix the JSON and re-run.`,
      ],
    };
  }

  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return { settingsPath, removed: 0, backupPath: null, notes: ['no hooks object — nothing to remove'] };
  }

  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue; // structurally foreign — never touch
    const { kept, removed: n } = stripOurEntries(groups, marker);
    removed += n;
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
  if (removed > 0) {
    backupPath = `${settingsPath}.bak`;
    copyFileSync(settingsPath, backupPath);
    atomicWriteJson(settingsPath, settings);
  }
  return { settingsPath, removed, backupPath, notes };
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
}

export type CodexMcpRegistration = Omit<ClaudeMcpRegistration, 'scope'>;

/**
 * `claude mcp add` argv for a LOCAL stdio serve. Returns command argv arrays
 * (binary first) — the dispatcher execs them; nothing here touches the
 * filesystem or the network. Shape per TARGETS['claude-code-2026-08'].
 *
 * The serve argv pins `--surface full`: bootstrap's contract (put_page,
 * get_page, timeline, …) needs the full op surface, and a pre-existing
 * `mcp_surface: verbs` config row must not silently narrow the registration.
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
  argv.push('--', p.gbrainBin, 'serve', '--surface', 'full');
  return [argv];
}

/**
 * `codex mcp add` argv for a LOCAL stdio serve (writes ~/.codex/config.toml
 * itself — no TOML writer needed in v1, see TARGETS['codex-2026-08']).
 * Codex registrations are user-global; there is no scope flag.
 * `--surface full` pins the full op surface (see registerClaudeMcp).
 */
export function registerCodexMcp(p: CodexMcpRegistration): string[][] {
  if (!isAbsolute(p.gbrainBin)) {
    throw new Error(`gbrainBin must be an absolute path; got: ${p.gbrainBin}`);
  }
  const name = p.name ?? 'gbrain';
  const argv = ['codex', 'mcp', 'add', name, '--env', `GBRAIN_SOURCE=${p.sourceId}`];
  if (p.gbrainHome) argv.push('--env', `GBRAIN_HOME=${p.gbrainHome}`);
  argv.push('--', p.gbrainBin, 'serve', '--surface', 'full');
  return [argv];
}
