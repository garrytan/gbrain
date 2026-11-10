/**
 * The skill-resolver hook lane (`GBRAIN_HOOK_LANE=skill-resolver`): its own
 * hook entry in Claude Code and its own hooks.json groups in Codex, each
 * UserPromptSubmit plus SessionStart for the compaction reset,
 * written by `gbrain setup <claude-code|codex> --skill-loading resolve`
 * (src/core/setup/skill-resolver-hook.ts). It never shares output with the
 * turn-rule, setup or plugin lanes: it prints only the <relevant_skills> block.
 *
 * It runs the resolver in this process (never over serve's IPC), so it works
 * with serve down and with no brain, and it always fails open: every path
 * exits 0, and a path that cannot deliver a block prints nothing.
 *
 * Deadline (50 ms from lane entry): the main thread does only async I/O (the
 * config, stdin, the carriers, the commit) and every synchronous step (index
 * and session reads, ranking, rendering) runs in a worker thread
 * (hook-worker.ts) that checks the deadline inside each stage. The worker is
 * started before that I/O (by the CLI's lane fast path, before the lane
 * module even loads, else at lane entry), so its start-up overlaps it; a turn
 * that ends before the worker is needed terminates it. At the
 * deadline the main thread prints nothing and exits the process at once,
 * abandoning the worker, and commits no dedupe state: a commit starts only
 * after the block was written, on the main thread, before the deadline.
 *
 * One owner per event: like the harness, plugin and turn-rule lanes, it parses
 * the carriers the harness merges (Claude Code: managed settings, the
 * workspace's settings.local.json and settings.json, the user settings;
 * Codex: CODEX_HOME/hooks.json) and runs only when the first skill-resolver
 * entry there whose home has the lane on names its own GBRAIN_HOME, so two
 * wirings of different homes never deliver two blocks. (Identical commands
 * are deduplicated by the harness itself.)
 *
 * Catalogs: <harness>-user (built by setup) and, for Claude Code, a second
 * catalog for the project's .claude/skills, keyed by a hash of the project
 * root, built out of the turn by a detached `gbrain skills index build` on
 * first sight and merged at rank time (names only: scope project). A stale
 * catalog is rebuilt the same way, at most once a minute per catalog, unless
 * skills.resolver.auto_rebuild is false or GBRAIN_SKILLS_NO_AUTOREBUILD=1.
 *
 * Turn settings: skills.resolver.top_k, min_match, pinned (sent as exclude)
 * and per_harness.<harness>.{top_k,min_match} (config.ts laneTurnSettings);
 * unset, a turn is top_k 5 with every match and nothing excluded.
 *
 * Payload: the lane's own budget (skills.resolver.lane_payload_chars, default
 * 4000 characters of hook JSON); a block that does not fit is dropped whole
 * and counted (outcome payload_dropped in the lane log).
 *
 * Lane log: <home>/skill-index/logs/lane-<UTC day>.jsonl (daily-log.ts, kept
 * 14 days), one line per turn that got past the on/off check (outcome, error
 * code, duration, catalogs; never turn text); doctor's skill_resolver check
 * reads the last day of it.
 */
import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { spawn } from '../../spawn.ts';
import { claudeManagedSettingsPaths, claudeUserSettingsPath, codexHooksPath } from '../../bootstrap/host-specs.ts';
import { shellWords } from '../../setup/hook-launcher.ts';
import { isSkillResolverCommand, isSkillResolverEntry } from '../../setup/skill-resolver-lane.ts';
import { laneTurnSettings, type LaneTurnSettings } from './config.ts';
import { appendDailyLog, LANE_LOG } from './daily-log.ts';
import { assertCatalogName, catalogFile, logsDir, resolverHome } from './paths.ts';
import { type CommitHold, commitSessionAsync, sessionKey, type TurnDelta } from './session.ts';
import type { TurnOutput } from './resolve.ts';
import type { LaneWorkerTurn } from './hook-worker.ts';
import { laneWorkerFailed, startLaneWorker } from './lane-worker.ts';
import { releaseLease } from './lock.ts';

export { WORKER_SRC_PATH } from './lane-worker.ts';

export const LANE_DEADLINE_MS = 50;
export const LANE_STDIN_CAP_BYTES = 256 * 1024;
export const LANE_PAYLOAD_CHARS_DEFAULT = 4000;
export const LANE_PAYLOAD_CHARS_MIN = 500;
export const LANE_PAYLOAD_CHARS_MAX = 10_000;
const CONFIG_CAP_BYTES = 1024 * 1024;
const SPAWN_INTERVAL_MS = 60_000;
/** Time kept back from the worker's own deadline for delivery and the commit. */
const COMMIT_RESERVE_MS = 10;

export type LaneHarness = 'claude-code' | 'codex';
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

export interface LaneLogLine { at: string; harness: string; event: string; outcome: string; code?: string; ms: number; catalogs?: string[]; dropped_chars?: number }

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

interface Turn { outcome: string; code?: string; catalogs?: string[]; dropped_chars?: number }

/** Run one lane event. Always resolves 0; at the deadline it exits the process itself. */
export async function runSkillResolverLane(event: string, harness: LaneHarness, io: LaneIo = {}): Promise<number> {
  const t0 = performance.now();
  if (event !== 'user-prompt' && event !== 'session-start') return 0;
  const env = io.env ?? process.env;
  let home: string;
  try { home = resolverHome(env); } catch { return 0; }
  const deadlineMs = io.deadlineMs ?? (Number(env.GBRAIN_TEST_SKILL_LANE_DEADLINE_MS) || LANE_DEADLINE_MS);
  const elapsed = () => performance.now() - t0;
  const ctl: LaneCtl = { expired: false, worker: null, logged: false, commit: {} };
  if (event === 'user-prompt') ctl.worker = startLaneWorker(env);
  const log = (t: Turn) => appendLaneLog(home, { at: new Date().toISOString(), harness, event, outcome: t.outcome, ...(t.code ? { code: t.code } : {}), ms: Math.round(elapsed() * 10) / 10, ...(t.catalogs ? { catalogs: t.catalogs } : {}), ...(t.dropped_chars ? { dropped_chars: t.dropped_chars } : {}) });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => { timer = setTimeout(() => resolve('deadline'), deadlineMs); });
  const work = laneTurn(event, harness, home, env, io, ctl, elapsed, deadlineMs).catch((): Turn => ({ outcome: 'error', code: 'skill_resolver_internal' }));
  const result = await Promise.race([work, deadline]);
  if (result === 'deadline') {
    ctl.expired = true;
    void ctl.worker?.terminate();
    const { tmp, lease } = ctl.commit;
    if (tmp) try { unlinkSync(tmp); } catch { /* renamed or never created */ }
    if (lease) releaseLease(lease);
    if (ctl.logged) await Promise.race([log({ outcome: 'timeout', code: 'skill_resolve_timeout' }), new Promise(r => setTimeout(r, 5))]);
    (io.exit ?? ((c: number) => process.exit(c)))(0);
    return 0;
  }
  clearTimeout(timer);
  void ctl.worker?.terminate();
  if (result.outcome !== 'off' && result.outcome !== 'yield') await log(result);
  return 0;
}

interface LaneCtl { expired: boolean; worker: Worker | null; logged: boolean; commit: CommitHold }

async function laneTurn(event: 'user-prompt' | 'session-start', harness: LaneHarness, home: string, env: NodeJS.ProcessEnv, io: LaneIo, ctl: LaneCtl, elapsed: () => number, deadlineMs: number): Promise<Turn> {
  const settings = await readLaneSettings(home, env);
  if (settings.state === 'absent') return { outcome: 'off' };
  if (settings.state === 'unreadable') { ctl.logged = true; return { outcome: 'error', code: 'skill_resolver_config_unreadable' }; }
  if (!settings.enabled || !settings.harnesses.includes(harness)) return { outcome: 'off' };
  ctl.logged = true;
  if (settings.state === 'invalid') return { outcome: 'error', code: 'skill_resolver_config_invalid' };
  let turnSettings: LaneTurnSettings;
  try { turnSettings = laneTurnSettings(settings.section, harness); } catch { return { outcome: 'error', code: 'skill_resolver_config_invalid' }; }

  const raw = await readStdinBounded(io.stdin ?? process.stdin, LANE_STDIN_CAP_BYTES);
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw ?? '') as Record<string, unknown>; } catch { return { outcome: 'error', code: 'skill_resolve_no_input' }; }
  if (!j || typeof j !== 'object') return { outcome: 'error', code: 'skill_resolve_no_input' };
  const cwd = io.cwd ?? env.GBRAIN_HOOK_CWD ?? (typeof j.cwd === 'string' ? j.cwd : process.cwd());
  const owner = await skillResolverOwner(harness, event, cwd, io.managedDir);
  if (owner !== undefined && owner !== (env.GBRAIN_HOME ?? '').trim()) return { outcome: 'yield' };
  const sessionId = typeof j.session_id === 'string' && /^[\x21-\x7e]{1,256}$/.test(j.session_id) ? j.session_id : undefined;

  if (event === 'session-start') {
    if (j.source !== 'compact' || !sessionId) return { outcome: 'off' };
    await Promise.all(['on', 'shadow'].map(scope => unlink(join(home, 'skill-index', 'sessions', `${sessionKey(scope as 'on' | 'shadow', harness, sessionId)}.json`)).catch(() => {})));
    return { outcome: 'reset' };
  }

  const prompt = typeof j.prompt === 'string' ? j.prompt : '';
  if (!prompt.trim() || /^\s*<(task-notification|teammate-message)[\s>]/.test(prompt)) return { outcome: 'empty' };
  const spawnFn = io.spawn ?? spawnDetached;
  const catalogs = [userCatalogName(harness)];
  if (harness === 'claude-code') {
    const project = await projectCatalog(env.CLAUDE_PROJECT_DIR || cwd, home);
    if (project?.built) catalogs.push(project.name);
    else if (project && settings.autoRebuild) await scheduleBuild(home, project.name, ['skills', 'index', 'build', '--catalog', project.name, '--dir', project.dir, '--scope', 'project', '--harness', harness], spawnFn);
  }

  const worker = ctl.worker;
  if (!worker || laneWorkerFailed()) return { outcome: 'error', code: 'skill_resolver_internal', catalogs };
  const posted = await new Promise<{ output?: TurnOutput; pending?: { key: string; delta: TurnDelta } | null; error?: { code: string } }>((resolve) => {
    worker.once('message', resolve);
    worker.once('error', () => resolve({ error: { code: 'skill_resolver_internal' } }));
    worker.once('exit', () => resolve({ error: { code: 'skill_resolver_internal' } }));
    worker.postMessage({ input: { message: prompt, harness, ...turnSettings, ...(sessionId ? { session_id: sessionId } : {}) }, home, catalogs, deadlineMs: Math.max(1, deadlineMs - elapsed() - COMMIT_RESERVE_MS) } satisfies LaneWorkerTurn);
  });
  if (posted.error || !posted.output) return { outcome: 'error', code: posted.error?.code ?? 'skill_resolver_internal', catalogs };
  const out = posted.output;
  if (out.meta.index_stale && settings.autoRebuild) await scheduleStaleRebuilds(home, catalogs, spawnFn);
  if (out.error) return { outcome: 'error', code: out.error.code, catalogs };
  if (ctl.expired) return { outcome: 'timeout', code: 'skill_resolve_timeout', catalogs };

  const outcome = out.block ? 'delivered' : out.budget_exhausted ? 'budget_exhausted' : out.no_skill ? 'no_skill' : 'empty';
  if (out.block) {
    const payload = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out.block } });
    if (payload.length > settings.payloadChars) return { outcome: 'payload_dropped', catalogs, dropped_chars: payload.length };
    await (io.write ?? writeStdout)(`${payload}\n`);
  }
  const stall = env.GBRAIN_TEST_SKILL_LANE_STALL;
  if (stall === 'commit-held' || stall === 'commit-written') ctl.commit.at = (stage) => (`commit-${stage}` === stall ? new Promise(() => {}) : Promise.resolve());
  if (posted.pending && !ctl.expired) await commitSessionAsync(home, posted.pending.key, posted.pending.delta, ctl.commit);
  return { outcome, catalogs };
}

/** The project's .claude/skills catalog: name keyed by the real project root, and whether it is built. Null when there is none (or it is the user's own dir). */
async function projectCatalog(root: string, home: string): Promise<{ name: string; dir: string; built: boolean } | null> {
  try {
    const real = await realpath(root);
    if (real === await realpath(homedir()).catch(() => homedir())) return null;
    const dir = join(real, '.claude', 'skills');
    if (!(await stat(dir)).isDirectory()) return null;
    const name = `${projectCatalogPrefix('claude-code')}${createHash('sha256').update(real).digest('hex').slice(0, 16)}`;
    let built = true;
    try { await stat(catalogFile(home, name, 'receipt.json')); } catch { built = false; }
    return { name, dir, built };
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
