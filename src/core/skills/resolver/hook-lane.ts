/**
 * The skill-resolver hook lane (`GBRAIN_HOOK_LANE=skill-resolver`): its own
 * hook entry in Claude Code and its own hooks.json groups in Codex, each
 * UserPromptSubmit plus SessionStart (the compaction reset and the
 * session-start block below),
 * written by `gbrain setup <claude-code|codex> --skill-loading resolve`
 * (src/core/setup/skill-resolver-hook.ts), and Hermes's pre_llm_call shell
 * hook (`hook user-prompt --harness hermes`). It never shares output with the
 * turn-rule, setup or plugin lanes: it prints only the <relevant_skills> block,
 * and at SessionStart only the session-start block.
 *
 * Session-start block (Claude Code and Codex): on every SessionStart source
 * that starts or restores a context (SESSION_START_SOURCES: startup, resume,
 * clear, compact) the lane prints <harness>-user's pins
 * (skills.resolver.pins.<harness>-user, rendered in the worker by
 * pinned-block.ts with the other harnesses' rules and cap) followed by
 * skills.resolver.per_harness.<harness>.session_start, as
 * hookSpecificOutput.additionalContext with hookEventName SessionStart. With
 * neither set it prints nothing. Both parts have their own caps, so the block
 * is held to LANE_PAYLOAD_CHARS_MAX (Claude Code's hook output cap), not to
 * lane_payload_chars. Compaction still resets the session first.
 *
 * Wire shapes (LANE_IO): Claude Code and Codex send the prompt, session_id
 * and cwd at the top level (read whole, up to LANE_STDIN_CAP_BYTES) and take
 * hookSpecificOutput.additionalContext; Hermes sends extra.user_message,
 * session_id and maybe cwd beside the whole extra.conversation_history, read
 * by the bounded streaming reader (hook-input.ts) over Bun's native stdin
 * stream (about 4x faster than process.stdin on a multi-MB payload) so no
 * history size is refused, and takes {"context": block}. Hermes has no
 * compaction event and compacts in place (same session id), so the same
 * pass counts extra.conversation_history and reads extra.is_first_turn: a
 * first turn, or a history shorter than the last committed turn saw
 * (session.ts historyShrank), starts the session's dedupe fresh. With
 * per_harness.hermes.owner_sender_ids set, a turn whose extra.sender_id is
 * not listed (or is empty) gets no block, as in the OpenClaw plugin.
 *
 * It runs the resolver in this process (never over serve's IPC), so it works
 * with serve down and with no brain, and it always fails open: every path
 * exits 0, and a path that cannot deliver a block prints nothing.
 *
 * Deadline (LANE_DEADLINE_MS for the turn, from the moment the worker has
 * loaded and the hook's stdin has been read, after at most
 * LANE_WORKER_START_MS from lane entry for both; the load alone can take
 * most of the turn's 50 ms on a cold machine, and Hermes may still be
 * piping a long conversation_history when it ends; the load time is logged
 * as worker_ms): the main thread does only async I/O (the
 * config, stdin, the carriers, the commit) and every synchronous step (index
 * and session reads, ranking, rendering) runs in a worker thread
 * (hook-worker.ts) that checks the deadline inside each stage. The worker is
 * started before that I/O (by the CLI's lane fast path, before the lane
 * module even loads, else at lane entry), so its start-up overlaps it; a turn
 * that ends before the worker is needed terminates it. At the
 * deadline the main thread prints nothing and exits the process at once,
 * abandoning the worker, and commits no dedupe state: a commit starts only
 * after the block was written, on the main thread, before the deadline. Once
 * the turn is logged, the lane awaits the commit's session GC pass, bounded by
 * LANE_GC_FILES files and by the time left before the deadline; a deadline
 * that lands during it exits without changing the logged outcome.
 *
 * One owner per event: like the harness, plugin and turn-rule lanes, it parses
 * the carriers the harness merges (Claude Code: managed settings, the
 * workspace's settings.local.json and settings.json, the user settings;
 * Codex: CODEX_HOME/hooks.json) and runs only when the first skill-resolver
 * entry there whose home has the lane on names its own GBRAIN_HOME, so two
 * wirings of different homes never deliver two blocks. (Identical commands
 * are deduplicated by the harness itself.) Hermes has no carrier read yet,
 * so its lane always runs under its own GBRAIN_HOME.
 *
 * Catalogs, each searched only once its receipt exists (none: outcome
 * no_catalog, no output): <harness>-user (built by setup), for Claude Code
 * claude-code-plugins (built by setup from enabled plugins), then a project
 * catalog built out of the turn by a detached `gbrain skills index build` on
 * first sight and merged at rank time (names only: scope project). Claude
 * Code's covers the project's .claude/skills, keyed by a hash of the real
 * project root; Codex's covers every existing .agents/skills from the project
 * root (the nearest ancestor of cwd holding a .git entry, else cwd) down to
 * cwd, root first, as Codex 0.165 loads them (codex-rs host_roots.rs), keyed
 * by a hash of that real dir list and leaving out the user's own
 * ~/.agents/skills. A stale catalog is rebuilt the same way, at most once a
 * minute per catalog, unless skills.resolver.auto_rebuild is false or
 * GBRAIN_SKILLS_NO_AUTOREBUILD=1.
 *
 * Turn settings: skills.resolver.top_k, min_match, top_gate, pinned (sent as
 * exclude) and per_harness.<harness>.{top_k,min_match,top_gate} (config.ts
 * laneTurnSettings); unset, a turn is top_k 5 with every match, the resolver's
 * default top_gate (TOP_GATE_DEFAULT; 0 turns it off) and nothing excluded.
 *
 * Model picker (skills.resolver.router, Claude Code and Codex only; never
 * Hermes): the turn may call it, so once the lane reads the setting on, its
 * deadline grows by the picker's wait (router.ts routerTimeoutMs: 1.5 s in
 * Claude Code, 2 s in Codex; at most ROUTER_TIMEOUT_MS_CLAUDE_CODE_MAX in
 * Claude Code and ROUTER_TIMEOUT_MS_MAX elsewhere) plus LANE_ROUTER_MARGIN_MS,
 * so Claude Code stays inside its 3 s hook limit.
 * The lane log line then carries router: who answered, the fallback code and
 * the wait.
 *
 * Skill vectors (vectors.ts): when a turn's catalog has a vectors.bin and the
 * picker is off, the deadline grows by VECTOR_WAIT_MS plus
 * LANE_ROUTER_MARGIN_MS for the message's embedding (with the picker on, the
 * embedding counts inside the picker's wait). The lane log line then carries
 * vectors: whether the turn ranked with them, the fallback code and the wait.
 *
 * Payload: the lane's own budget (skills.resolver.lane_payload_chars, default
 * 4000 characters of hook JSON, Hermes's included); a block that does not fit
 * is dropped whole and counted (outcome payload_dropped in the lane log).
 *
 * Lane log: <home>/skill-index/logs/lane-<UTC day>.jsonl (daily-log.ts, kept
 * 14 days), one line per turn that got past the on/off check (outcome, error
 * code, duration, worker_ms, catalogs; never turn text); doctor's skill_resolver check
 * reads the last day of it.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { spawn } from '../../spawn.ts';
import { claudeManagedSettingsPaths, claudeUserSettingsPath, codexHooksPath } from '../../bootstrap/host-specs.ts';
import { shellWords } from '../../setup/hook-launcher.ts';
import { isSkillResolverCommand, isSkillResolverEntry } from '../../setup/skill-resolver-lane.ts';
import { laneOwnerSenders, laneSessionStart, laneTurnSettings, routerSettings, type LaneTurnSettings } from './config.ts';
import { routerTimeoutMs } from './router.ts';
import { VECTOR_WAIT_MS } from './vectors.ts';
import { appendDailyLog, appendDailyLogSync, LANE_LOG } from './daily-log.ts';
import { HOOK_FIELD_CAP, readHookFields } from './hook-input.ts';
import { assertCatalogName, catalogFile, CLAUDE_PLUGINS_CATALOG, logsDir, resolverHome } from './paths.ts';
import { type CommitHold, commitSessionAsync, historyShrank, LANE_GC_FILES, sessionGcSettled, sessionKey, type TurnDelta } from './session.ts';
import type { TurnOutput } from './resolve.ts';
import type { LaneWorkerPins, LaneWorkerTurn } from './hook-worker.ts';
import { laneWorkerFailed, laneWorkerReady, startLaneWorker } from './lane-worker.ts';
import { releaseLease } from './lock.ts';

export { WORKER_SRC_PATH } from './lane-worker.ts';

export const LANE_DEADLINE_MS = 50;
/** Added to the picker's wait when the lane may call it: delivery, the commit and the exit after the reply. */
export const LANE_ROUTER_MARGIN_MS = 100;
export const LANE_WORKER_START_MS = 250;
export const LANE_STDIN_CAP_BYTES = 256 * 1024;
/** The fields a Hermes pre_llm_call turn is read for, in one streaming pass over a history of any size. */
export const HERMES_HOOK_FIELDS = { strings: ['session_id', 'cwd', 'extra.user_message', 'extra.sender_id'], counts: ['extra.conversation_history'], flags: ['extra.is_first_turn'] };
export const LANE_PAYLOAD_CHARS_DEFAULT = 4000;
export const LANE_PAYLOAD_CHARS_MIN = 500;
export const LANE_PAYLOAD_CHARS_MAX = 10_000;
const CONFIG_CAP_BYTES = 1024 * 1024;
const SPAWN_INTERVAL_MS = 60_000;
/** Time kept back from the worker's own deadline for delivery and the commit. */
const COMMIT_RESERVE_MS = 10;
/** Time kept back from the deadline after the session GC pass, for the exit. */
const GC_RESERVE_MS = 5;
/** The SessionStart sources that start or restore a context, so get the pinned block and the session_start text. */
const SESSION_START_SOURCES = ['startup', 'resume', 'clear', 'compact'];

export type LaneHarness = 'claude-code' | 'codex' | 'hermes';
export { CLAUDE_PLUGINS_CATALOG };
export const userCatalogName = (harness: LaneHarness) => `${harness}-user`;
export const projectCatalogPrefix = (harness: LaneHarness) => `${harness}-project-`;

/** The GBRAIN_HOME a lane command pins ('' for none). */
function commandHome(command: string): string {
  const words = shellWords(command) ?? [];
  return (words.find(w => w.startsWith('GBRAIN_HOME='))?.slice('GBRAIN_HOME='.length) ?? '').trim();
}

async function readJsonFile(path: string, cap = CONFIG_CAP_BYTES): Promise<unknown> {
  if ((await stat(path)).size > cap) throw new Error('too large');
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * The GBRAIN_HOME of the skill-resolver wiring that owns this event: the
 * first lane entry, in carrier order, whose home has the lane on for this
 * harness. Undefined when none does (a manual run, or every wiring off).
 * Async reads only; an unreadable carrier or home is skipped.
 */
export async function skillResolverOwner(harness: LaneHarness, event: 'user-prompt' | 'session-start', cwd: string, managedDir?: string): Promise<string | undefined> {
  if (harness === 'hermes') return undefined;
  const eventKey = event === 'user-prompt' ? 'UserPromptSubmit' : 'SessionStart';
  const carriers = harness === 'codex' ? [codexHooksPath()]
    : [...claudeManagedSettingsPaths(managedDir), join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'), claudeUserSettingsPath()];
  for (const path of carriers) {
    let doc: unknown;
    try { doc = await readJsonFile(path); } catch { continue; }
    const groups = (doc as { hooks?: Record<string, unknown> } | null)?.hooks?.[eventKey];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const entries = (g as { hooks?: unknown })?.hooks;
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        const command = (e as { command?: unknown } | null)?.command;
        if (typeof command !== 'string' || !(harness === 'codex' ? isSkillResolverCommand(command) : isSkillResolverEntry(e))) continue;
        const home = commandHome(command);
        try {
          const s = await readLaneSettings(resolverHome(home ? { GBRAIN_HOME: home } : {}), {});
          if (s.enabled && s.harnesses.includes(harness)) return home;
        } catch { /* a home gbrain cannot use owns nothing */ }
      }
    }
  }
  return undefined;
}

export interface LaneSettings { state: 'absent' | 'unreadable' | 'invalid' | 'ok'; enabled: boolean; harnesses: string[]; payloadChars: number; autoRebuild: boolean; section: Record<string, unknown> }

/** skills.resolver from <home>/config.json, async. absent: no file; unreadable: a file gbrain cannot read or parse. */
export async function readLaneSettings(home: string, env: NodeJS.ProcessEnv): Promise<LaneSettings> {
  const base: LaneSettings = { state: 'ok', enabled: false, harnesses: [], payloadChars: LANE_PAYLOAD_CHARS_DEFAULT, autoRebuild: env.GBRAIN_SKILLS_NO_AUTOREBUILD !== '1', section: {} };
  let cfg: unknown;
  try { cfg = await readJsonFile(join(home, 'config.json')); } catch (e) {
    return { ...base, state: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ...base, state: 'unreadable' };
  const r = (cfg as { skills?: { resolver?: Record<string, unknown> } }).skills?.resolver;
  if (!r || typeof r !== 'object') return base;
  const chars = r.lane_payload_chars;
  const validChars = chars === undefined || (Number.isInteger(chars) && (chars as number) >= LANE_PAYLOAD_CHARS_MIN && (chars as number) <= LANE_PAYLOAD_CHARS_MAX);
  return {
    state: validChars ? 'ok' : 'invalid',
    enabled: r.enabled === true,
    harnesses: Array.isArray(r.harnesses) ? r.harnesses.filter((h): h is string => typeof h === 'string') : [],
    payloadChars: validChars && chars !== undefined ? chars as number : LANE_PAYLOAD_CHARS_DEFAULT,
    autoRebuild: base.autoRebuild && r.auto_rebuild !== false,
    section: r,
  };
}

export interface LaneLogLine { at: string; harness: string; event: string; outcome: string; code?: string; ms: number; worker_ms?: number; catalogs?: string[]; dropped_chars?: number; router?: LaneRouterLog; vectors?: LaneVectorsLog }
/** The picker's part of a turn: who answered, why it fell back, its wait in ms. */
export interface LaneRouterLog { by: 'picker' | 'words'; code?: string; ms: number }
/** The skill vectors' part of a turn: whether it ranked with them, why not, its wait for the message's vector in ms. */
export interface LaneVectorsLog { used: boolean; code?: string; ms: number }

async function appendLaneLog(home: string, line: LaneLogLine): Promise<void> {
  try {
    const dir = logsDir(home);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendDailyLog(dir, LANE_LOG, `${JSON.stringify(line)}\n`);
  } catch { /* logging never fails a turn */ }
}

async function readStdinBounded(stream: NodeJS.ReadableStream & { isTTY?: boolean }, cap: number): Promise<string | null> {
  if (stream.isTTY) return null;
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of stream as AsyncIterable<Buffer | string>) {
    const b = typeof c === 'string' ? Buffer.from(c) : c;
    n += b.length;
    if (n > cap) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type LaneStdin = NodeJS.ReadableStream & { isTTY?: boolean };
/** One hook event's fields as the harness sent them, not yet checked. */
interface HookEvent { prompt: string; sessionId?: unknown; cwd?: unknown; source?: unknown; history?: number; firstTurn?: boolean; senderId?: string }
/** `stdin` is the injected stream, else undefined for the process's own. */
interface HarnessIo { read: (stdin: LaneStdin | undefined) => Promise<HookEvent | null>; render: (block: string, event?: 'UserPromptSubmit' | 'SessionStart') => string }

const HOOK_SPECIFIC_IO: HarnessIo = {
  read: async (stdin) => {
    let j: unknown;
    try { j = JSON.parse(await readStdinBounded(stdin ?? process.stdin, LANE_STDIN_CAP_BYTES) ?? ''); } catch { return null; }
    if (!j || typeof j !== 'object') return null;
    const o = j as Record<string, unknown>;
    return { prompt: typeof o.prompt === 'string' ? o.prompt : '', sessionId: o.session_id, cwd: o.cwd, source: o.source };
  },
  render: (block, event = 'UserPromptSubmit') => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: block } }),
};

/** Each lane harness's stdin and stdout shapes. */
const LANE_IO: Record<LaneHarness, HarnessIo> = {
  'claude-code': HOOK_SPECIFIC_IO,
  codex: HOOK_SPECIFIC_IO,
  hermes: {
    read: async (stdin) => {
      const source = stdin ?? (process.stdin.isTTY ? process.stdin : Bun.stdin.stream());
      const f = await readHookFields(source, HERMES_HOOK_FIELDS, HOOK_FIELD_CAP);
      return f && { prompt: f.strings['extra.user_message'] ?? '', sessionId: f.strings.session_id, cwd: f.strings.cwd, history: f.counts['extra.conversation_history'], firstTurn: f.flags['extra.is_first_turn'], senderId: f.strings['extra.sender_id'] ?? '' };
    },
    render: (block) => JSON.stringify({ context: block }),
  },
};

function selfArgv(args: string[]): string[] {
  const exec = process.execPath;
  return /[/\\]gbrain(\.exe)?$/.test(exec) ? [exec, ...args] : [exec, process.argv[1]!, ...args];
}

function spawnDetached(argv: string[]): void {
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore', env: process.env });
  child.on('error', () => { /* best effort */ });
  child.unref();
}

/** Start a detached build at most once a minute per catalog (stamp under logs/). */
async function scheduleBuild(home: string, catalog: string, args: string[], spawnFn: (argv: string[]) => void): Promise<boolean> {
  const stamp = join(logsDir(home), `spawn-${assertCatalogName(catalog)}.stamp`);
  try { if (Date.now() - (await stat(stamp)).mtimeMs < SPAWN_INTERVAL_MS) return false; } catch { /* none */ }
  try {
    await mkdir(logsDir(home), { recursive: true, mode: 0o700 });
    await writeFile(stamp, '', { mode: 0o600 });
    spawnFn(selfArgv(args));
    return true;
  } catch { return false; }
}

export interface LaneIo {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Resolves once the text was handed to stdout. */
  write?: (s: string) => Promise<void>;
  exit?: (code: number) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  deadlineMs?: number;
  spawn?: (argv: string[]) => void;
  managedDir?: string;
}

const writeStdout = (s: string) => new Promise<void>((resolve, reject) => { process.stdout.write(s, (e) => (e ? reject(e) : resolve())); });

interface Turn { outcome: string; code?: string; catalogs?: string[]; dropped_chars?: number; router?: LaneRouterLog; vectors?: LaneVectorsLog }

/** Run one lane event. Always resolves 0; at the deadline it exits the process itself. */
export async function runSkillResolverLane(event: string, harness: LaneHarness, io: LaneIo = {}): Promise<number> {
  const t0 = performance.now();
  if (event !== 'user-prompt' && (event !== 'session-start' || harness === 'hermes')) return 0;
  const env = io.env ?? process.env;
  let home: string;
  try { home = resolverHome(env); } catch { return 0; }
  let deadlineMs = io.deadlineMs ?? (Number(env.GBRAIN_TEST_SKILL_LANE_DEADLINE_MS) || LANE_DEADLINE_MS);
  const startMs = Number(env.GBRAIN_TEST_SKILL_LANE_START_MS) || LANE_WORKER_START_MS;
  const elapsed = () => performance.now() - t0;
  const ctl: LaneCtl = {
    expired: false, worker: null, logged: false, commit: {}, inputRead: () => {},
    extend: (extra) => { if (ctl.expired) return; deadlineMs += extra; if (ctl.turnStart !== undefined) arm(Math.max(0, turnLeft())); },
  };
  const inputRead = new Promise<void>((resolve) => { ctl.inputRead = resolve; });
  ctl.worker = startLaneWorker(env);
  const turnLeft = () => deadlineMs - (ctl.turnStart === undefined ? 0 : elapsed() - ctl.turnStart);
  const tenths = (ms: number) => Math.round(ms * 10) / 10;
  const line = (t: Turn): LaneLogLine => ({ at: new Date().toISOString(), harness, event, outcome: t.outcome, ...(t.code ? { code: t.code } : {}), ms: tenths(elapsed()), ...(ctl.workerMs !== undefined ? { worker_ms: tenths(ctl.workerMs) } : {}), ...(t.catalogs ? { catalogs: t.catalogs } : {}), ...(t.dropped_chars ? { dropped_chars: t.dropped_chars } : {}), ...(t.router ? { router: t.router } : {}), ...(t.vectors ? { vectors: t.vectors } : {}) });
  const log = (t: Turn) => appendLaneLog(home, line(t));

  const exit = io.exit ?? ((c: number) => process.exit(c));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  let arm: (ms: number) => void = () => {};
  const deadline = new Promise<'deadline'>((resolve) => {
    arm = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => { fired = true; resolve('deadline'); }, ms); };
    if (!ctl.worker) { ctl.turnStart = 0; arm(deadlineMs); return; }
    arm(startMs);
    const loaded = laneWorkerReady().then((ok) => { if (ok && !fired && elapsed() < startMs) ctl.workerMs = elapsed(); });
    void Promise.all([loaded, inputRead]).then(() => {
      if (fired || elapsed() >= startMs) return;
      ctl.turnStart = elapsed();
      arm(deadlineMs);
    });
    if (env.GBRAIN_TEST_SKILL_LANE_STALL === 'start-race') { const end = performance.now() + startMs + 300; while (performance.now() < end) { /* forced main-thread stall past the start bound */ } }
  });
  const work = laneTurn(event, harness, home, env, io, ctl, turnLeft).catch((): Turn => ({ outcome: 'error', code: 'skill_resolver_internal' }));
  const result = await Promise.race([work, deadline]);
  if (result === 'deadline') {
    ctl.expired = true;
    void ctl.worker?.terminate();
    const { tmp, lease } = ctl.commit;
    if (tmp) try { unlinkSync(tmp); } catch { /* renamed or never created */ }
    if (lease) releaseLease(lease);
    if (ctl.logged) try {
      mkdirSync(logsDir(home), { recursive: true, mode: 0o700 });
      appendDailyLogSync(logsDir(home), LANE_LOG, `${JSON.stringify(line({ outcome: 'timeout', code: 'skill_resolve_timeout' }))}\n`);
    } catch { /* logging never fails a turn */ }
    exit(0);
    return 0;
  }
  void ctl.worker?.terminate();
  if (result.outcome !== 'off' && result.outcome !== 'yield') await log(result);
  const gcDone = env.GBRAIN_TEST_SKILL_LANE_STALL === 'gc' ? new Promise<void>(() => {}) : sessionGcSettled();
  if ((await Promise.race([gcDone, deadline])) === 'deadline') exit(0);
  clearTimeout(timer);
  return 0;
}

/** turnStart: ms after lane entry when the turn deadline started (the worker was ready, or failed, and stdin was read); workerMs: when it was ready; inputRead: stdin has been read; extend: give the turn more time (the model picker's wait). */
interface LaneCtl { expired: boolean; worker: Worker | null; logged: boolean; commit: CommitHold; turnStart?: number; workerMs?: number; inputRead: () => void; extend: (extraMs: number) => void }

async function laneTurn(event: 'user-prompt' | 'session-start', harness: LaneHarness, home: string, env: NodeJS.ProcessEnv, io: LaneIo, ctl: LaneCtl, turnLeft: () => number): Promise<Turn> {
  const settings = await readLaneSettings(home, env);
  if (settings.state === 'absent') return { outcome: 'off' };
  if (settings.state === 'unreadable') { ctl.logged = true; return { outcome: 'error', code: 'skill_resolver_config_unreadable' }; }
  if (!settings.enabled || !settings.harnesses.includes(harness)) return { outcome: 'off' };
  ctl.logged = true;
  if (settings.state === 'invalid') return { outcome: 'error', code: 'skill_resolver_config_invalid' };
  let turnSettings: LaneTurnSettings;
  try { turnSettings = laneTurnSettings(settings.section, harness); } catch { return { outcome: 'error', code: 'skill_resolver_config_invalid' }; }

  const hookEvent = await LANE_IO[harness].read(io.stdin);
  ctl.inputRead();
  if (!hookEvent) return { outcome: 'error', code: 'skill_resolve_no_input' };
  const cwd = io.cwd ?? env.GBRAIN_HOOK_CWD ?? (typeof hookEvent.cwd === 'string' ? hookEvent.cwd : process.cwd());
  const owner = await skillResolverOwner(harness, event, cwd, io.managedDir);
  if (owner !== undefined && owner !== (env.GBRAIN_HOME ?? '').trim()) return { outcome: 'yield' };
  const sessionId = typeof hookEvent.sessionId === 'string' && /^[\x21-\x7e]{1,256}$/.test(hookEvent.sessionId) ? hookEvent.sessionId : undefined;

  if (event === 'session-start') {
    if (harness === 'hermes') return { outcome: 'off' };
    const reset = hookEvent.source === 'compact' && !!sessionId;
    if (reset) await Promise.all(['on', 'shadow'].map(scope => unlink(join(home, 'skill-index', 'sessions', `${sessionKey(scope as 'on' | 'shadow', harness, sessionId)}.json`)).catch(() => {})));
    if (!SESSION_START_SOURCES.includes(hookEvent.source as string)) return { outcome: reset ? 'reset' : 'off' };
    const pins = (settings.section.pins as Record<string, unknown> | null | undefined)?.[userCatalogName(harness)];
    let pinned = '';
    if (Array.isArray(pins) && pins.length > 0) {
      const worker = ctl.worker;
      if (!worker || laneWorkerFailed()) return { outcome: 'error', code: 'skill_resolver_internal' };
      const posted = await askWorker(worker, { pins, harness, home });
      if (posted.error || posted.pinned === undefined) return { outcome: 'error', code: posted.error?.code ?? 'skill_resolver_internal' };
      pinned = posted.pinned;
    }
    const block = [pinned, laneSessionStart(settings.section, harness)].filter(Boolean).join('\n\n');
    if (!block) return { outcome: reset ? 'reset' : 'off' };
    if (ctl.expired) return { outcome: 'timeout', code: 'skill_resolve_timeout' };
    const payload = LANE_IO[harness].render(block, 'SessionStart');
    if (payload.length > LANE_PAYLOAD_CHARS_MAX) return { outcome: 'payload_dropped', dropped_chars: payload.length };
    await (io.write ?? writeStdout)(`${payload}\n`);
    return { outcome: 'delivered' };
  }

  const owners = laneOwnerSenders(settings.section, harness);
  if (owners && !owners.includes(hookEvent.senderId ?? '')) return { outcome: 'skipped_sender' };
  const reset = harness === 'hermes' && !!sessionId && (hookEvent.firstTurn === true || await historyShrank(home, sessionKey('on', harness, sessionId), hookEvent.history));

  const prompt = hookEvent.prompt;
  if (!prompt.trim() || /^\s*<(task-notification|teammate-message)[\s>]/.test(prompt)) return { outcome: 'empty' };
  const spawnFn = io.spawn ?? spawnDetached;
  const [userBuilt, pluginsBuilt, project] = await Promise.all([
    isBuilt(home, userCatalogName(harness)),
    harness === 'claude-code' && isBuilt(home, CLAUDE_PLUGINS_CATALOG),
    harness === 'hermes' ? null : projectCatalog(harness, harness === 'claude-code' ? env.CLAUDE_PROJECT_DIR || cwd : cwd, home),
  ]);
  const catalogs = [...(userBuilt ? [userCatalogName(harness)] : []), ...(pluginsBuilt ? [CLAUDE_PLUGINS_CATALOG] : [])];
  if (project?.built) catalogs.push(project.name);
  else if (project && settings.autoRebuild) await scheduleBuild(home, project.name, ['skills', 'index', 'build', '--catalog', project.name, ...project.dirs.flatMap(d => ['--dir', d]), '--scope', 'project', '--harness', harness], spawnFn);
  if (catalogs.length === 0) return { outcome: 'no_catalog' };
  const router = (harness === 'claude-code' || harness === 'codex') && settings.section.router === true;
  if (router) ctl.extend(routerTimeoutMs(harness, routerSettings(settings.section)) + LANE_ROUTER_MARGIN_MS);
  else if ((harness === 'claude-code' || harness === 'codex') && (await Promise.all(catalogs.map(c => stat(catalogFile(home, c, 'vectors.bin')).then(() => true, () => false)))).some(Boolean)) ctl.extend(VECTOR_WAIT_MS + LANE_ROUTER_MARGIN_MS);

  const worker = ctl.worker;
  if (!worker || laneWorkerFailed()) return { outcome: 'error', code: 'skill_resolver_internal', catalogs };
  const posted = await askWorker(worker, { input: { message: prompt, harness, ...turnSettings, ...(sessionId ? { session_id: sessionId } : {}), ...(reset ? { reset_session: true } : {}) }, home, catalogs, deadlineMs: Math.max(1, turnLeft() - COMMIT_RESERVE_MS), router });
  if (posted.error || !posted.output) return { outcome: 'error', code: posted.error?.code ?? 'skill_resolver_internal', catalogs };
  const out = posted.output;
  if (out.meta.index_stale && settings.autoRebuild) await scheduleStaleRebuilds(home, catalogs, spawnFn);
  const routerLog: LaneRouterLog | undefined = out.router ? { by: out.router.answered_by, ...(out.router.fallback ? { code: out.router.fallback.code } : {}), ms: out.router.ms } : undefined;
  const vectors: LaneVectorsLog | undefined = out.vectors ? { used: out.vectors.used, ...(out.vectors.fallback ? { code: out.vectors.fallback.code } : {}), ms: out.vectors.ms } : undefined;
  if (out.error) return { outcome: 'error', code: out.error.code, catalogs, router: routerLog, vectors };
  if (ctl.expired) return { outcome: 'timeout', code: 'skill_resolve_timeout', catalogs, router: routerLog, vectors };

  const outcome = out.block ? 'delivered' : out.budget_exhausted ? 'budget_exhausted' : out.no_skill ? 'no_skill' : 'empty';
  if (out.block) {
    const payload = LANE_IO[harness].render(out.block);
    if (payload.length > settings.payloadChars) return { outcome: 'payload_dropped', catalogs, dropped_chars: payload.length, router: routerLog, vectors };
    await (io.write ?? writeStdout)(`${payload}\n`);
  }
  const stall = env.GBRAIN_TEST_SKILL_LANE_STALL;
  if (stall === 'commit-held' || stall === 'commit-written') ctl.commit.at = (stage) => (`commit-${stage}` === stall ? new Promise(() => {}) : Promise.resolve());
  if (posted.pending && !ctl.expired) {
    const gc = { files: LANE_GC_FILES, until: performance.now() + turnLeft() - GC_RESERVE_MS };
    await commitSessionAsync(home, posted.pending.key, { ...posted.pending.delta, ...(hookEvent.history !== undefined ? { history: hookEvent.history } : {}) }, ctl.commit, gc);
  }
  return { outcome, catalogs, router: routerLog, vectors };
}

interface WorkerReply { output?: TurnOutput; pending?: { key: string; delta: TurnDelta } | null; pinned?: string; error?: { code: string } }

/** Post one message to the lane's worker and await its one reply, skipping its ready message (an error when the thread fails or exits first). */
function askWorker(worker: Worker, message: LaneWorkerTurn | LaneWorkerPins): Promise<WorkerReply> {
  return new Promise((resolve) => {
    const onMessage = (m: WorkerReply & { ready?: boolean }) => { if (m?.ready === true) return; worker.off('message', onMessage); resolve(m); };
    worker.on('message', onMessage);
    worker.once('error', () => resolve({ error: { code: 'skill_resolver_internal' } }));
    worker.once('exit', () => resolve({ error: { code: 'skill_resolver_internal' } }));
    worker.postMessage(message);
  });
}

const isBuilt = (home: string, name: string) => stat(catalogFile(home, name, 'receipt.json')).then(() => true, () => false);
const isDir = (path: string) => stat(path).then(s => s.isDirectory(), () => false);

/**
 * Codex's repo skill dirs: each existing <dir>/.agents/skills from the
 * project root (the nearest ancestor of `cwd` holding a .git entry, else
 * `cwd`) down to `cwd`, root first, as real paths, without the user's own
 * ~/.agents/skills (the user catalog has it).
 */
async function codexProjectSkillDirs(cwd: string, home: string): Promise<string[]> {
  const chain = [cwd];
  for (let d = cwd; dirname(d) !== d;) chain.push(d = dirname(d));
  const marked = await Promise.all(chain.map(d => stat(join(d, '.git')).then(() => true, () => false)));
  const root = marked.indexOf(true);
  const below = chain.slice(0, root < 0 ? 1 : root + 1).reverse();
  const [user, ...found] = await Promise.all([realpath(join(home, '.agents', 'skills')).catch(() => null),
    ...below.map(async d => (await isDir(join(d, '.agents', 'skills')) ? realpath(join(d, '.agents', 'skills')) : null))]);
  return [...new Set(found.filter((p): p is string => p !== null && p !== user))];
}

/**
 * The project catalog for `root`: Claude Code's .claude/skills, named by the
 * real root; Codex's .agents/skills dirs, named by their real list. Null when
 * there is none (or it is the user's own dir).
 */
async function projectCatalog(harness: 'claude-code' | 'codex', root: string, home: string): Promise<{ name: string; dirs: string[]; built: boolean } | null> {
  try {
    const real = await realpath(root);
    const user = await realpath(homedir()).catch(() => homedir());
    const claudeDir = join(real, '.claude', 'skills');
    const dirs = harness === 'codex' ? await codexProjectSkillDirs(real, user) : real !== user && await isDir(claudeDir) ? [claudeDir] : [];
    if (dirs.length === 0) return null;
    const name = `${projectCatalogPrefix(harness)}${createHash('sha256').update(harness === 'codex' ? dirs.join('\0') : real).digest('hex').slice(0, 16)}`;
    return { name, dirs, built: await isBuilt(home, name) };
  } catch { return null; }
}

/** Rebuild each catalog the turn marked stale (stale.stamp) from its receipt's recorded command; an adapter-owned (stdin) catalog has none and is skipped. */
async function scheduleStaleRebuilds(home: string, catalogs: string[], spawnFn: (argv: string[]) => void): Promise<void> {
  for (const name of catalogs) {
    try {
      await stat(catalogFile(home, name, 'stale.stamp'));
      const receipt = await readJsonFile(catalogFile(home, name, 'receipt.json')) as { build?: { rebuild_argv?: unknown } };
      const argv = receipt.build?.rebuild_argv;
      if (!Array.isArray(argv) || argv[0] !== 'gbrain' || argv.some(a => typeof a !== 'string')) continue;
      await scheduleBuild(home, name, (argv as string[]).slice(1), spawnFn);
    } catch { /* not stale, or no receipt */ }
  }
}
