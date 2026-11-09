/**
 * PR B Part 4 (docs/designs/REFRESH_WRITE_BARRIER.md): `foreign_writers`. Every registered source checkout on this host,
 * managed worktrees included, deduplicated by git common dir: each commit created locally in the covered window that
 * gbrain's commit ledger (src/core/git/commit-ledger.ts) does not name was made by another writer, and every page file
 * left untracked or modified that gbrain is not about to commit is listed with its age. Read-only.
 *
 * - Locally created commits come from the reflogs (logs/HEAD and logs/refs/heads/* in the common dir, and each
 *   worktrees/<name>/logs/HEAD). Porcelain creations (commit, amend, initial, cherry-pick, revert, rebase picks,
 *   pull --rebase picks, am) are looked up by their new sha. Other ref moves (update-ref after commit-tree) read the
 *   old..new range: a single-parent commit whose committer time is within 10 minutes of the entry is a candidate; a range
 *   that cannot be read is reported unknown. Merges, fast-forwards, pulls, resets, checkouts, branch moves and clones
 *   are excluded.
 * - Reflog entries older than the ledger's start (or its oldest retained line after rotation) are uncovered, never
 *   foreign. A commit matching an open intent (parent = head_before, message digest, within 60 s) is unconfirmed: a
 *   warn, never written back.
 * - Dirty page files: untracked and unstaged files under the source roots, leaving out paths with a queued or running
 *   git effect and paths in the write-through pending ledger; age is the file's mtime.
 * - GST-1623: whatever the scan could not read leaves it partial, with the reason (`partial_reasons`): a root inside a Git
 *   checkout whose probe fails, roots past the scan cap, an unreadable ledger, a git status that failed or timed out
 *   (given up to 30 s within doctor's budget), doctor's budget itself. A scan that read no repository but skipped one is
 *   a warn, never not_applicable. A foreign commit whose message carries a `gbrain-*:` trailer is still foreign (a
 *   trailer is forgeable) but is named as possibly an older gbrain without the commit ledger.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from '../../../core/spawn.ts';
import { GIT_READ_ENV, gitChildEnv } from '../../../core/git-env.ts';
import type { Check } from '../../doctor.ts';
import { ledgerFiles, readLedger, messageDigest } from '../../../core/git/commit-ledger.ts';
import { readPendingWriteThrough } from '../../../core/git/commit-push.ts';
import { GUARD_ENFORCE_MARKER, GUARD_HOOK, OWNER_HOOKS_DIR } from '../../../core/git/commit-guard.ts';
import { existingHostIdFor } from '../../../core/persistence/identity.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { doctorVerify, infoCheck } from '../check-fix.ts';
import { SCAN_REPORT_RESERVE_MS } from '../budget.ts';
import { sourceRoots } from './git-convergence.ts';
import type { BrainEngine } from '../../../core/engine.ts';

export const PLUMBING_WINDOW_S = 10 * 60;
export const UNCONFIRMED_WINDOW_MS = 60_000;
export const FOREIGN_DIRTY_WARN_MS = 30 * 60_000;
const MAX_REFLOG_ENTRIES = 5_000;
const MAX_RANGE_COMMITS = 500;
const GIT_TIMEOUT_MS = 5_000;
const STATUS_TIMEOUT_MAX_MS = 30_000;
const MAX_ROOTS = 50;
const MAX_LISTED = 20;
const ZERO = /^0+$/;
const BUDGET_REASON = 'doctor\'s time budget ran out';

export type ForeignKind = 'plain' | 'amend' | 'rewrite' | 'plumbing';
export interface ForeignCommit { sha: string; kind: ForeignKind; guard_bypassed: boolean; gbrain_trailer: boolean; ref: string; time: string; subject: string; committer: string; checkout: string }
interface Candidate { sha: string; kind: ForeignKind; ref: string; time: number; gitDir: string | null; checkout: string }
interface Checkout { top: string; gitDir: string; source_ids: string[]; roots: string[] }
interface Repo { common: string; checkouts: Map<string, Checkout> }
interface Reflog { file: string; ref: string; gitDir: string | null }
interface Entry { old: string; next: string; time: number; message: string }

function gitRun(root: string, args: string[], input?: string, timeout = GIT_TIMEOUT_MS): { out: string | null; timedOut: boolean } {
  try { return { out: execFileSync('git', ['-C', root, ...args], { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], input, timeout, maxBuffer: 32 * 1024 * 1024, env: gitChildEnv(GIT_READ_ENV) }).toString(), timedOut: false }; }
  catch (error) { const e = error as { code?: string; signal?: string }; return { out: null, timedOut: e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM' }; }
}
const git = (root: string, args: string[], input?: string): string | null => gitRun(root, args, input).out;
/** Whether `root` or an ancestor holds a `.git` entry: a checkout git should have answered for (reconcile-state.ts insideGitCheckout). */
function insideGitCheckout(root: string): boolean {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true;
    if (dirname(dir) === dir) return false;
  }
}
/** A commit message whose trailer paragraph (its last) carries a `gbrain-*:` trailer gbrain writes (repair, supersedes, adopted). */
const gbrainTrailer = (message: string) => /^gbrain-[a-z][a-z-]*:\s/m.test(message.trim().split(/\n[ \t]*\n/).at(-1) ?? '');
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Porcelain creation kind of a reflog message; 'excluded' for moves that create nothing locally; 'other' for the rest. */
export function classifyReflogMessage(message: string): ForeignKind | 'excluded' | 'other' {
  if (/^commit \(merge\)/.test(message)) return 'excluded';
  if (/^commit \(amend\):/.test(message)) return 'amend';
  if (/^commit( \(initial\))?:/.test(message)) return 'plain';
  if (/^commit \([^)]*\):/.test(message)) return 'rewrite';
  if (/^(cherry-pick|revert)( \([^)]*\))?:/.test(message)) return 'rewrite';
  if (/^(rebase|pull --rebase)( -[im])? \((pick|reword|edit|squash|fixup)\)/.test(message)) return 'rewrite';
  if (/^am:/.test(message)) return 'rewrite';
  if (/^(merge|pull|reset|checkout|branch|clone|rebase|fetch|push|update by push|initial pull|switch)\b/i.test(message)) return 'excluded';
  return 'other';
}

/** The newest MAX_REFLOG_ENTRIES lines of one reflog, oldest first. */
function readReflog(file: string): Entry[] {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const lines = text.split('\n').filter(Boolean);
  const out: Entry[] = [];
  for (const line of lines.slice(-MAX_REFLOG_ENTRIES)) {
    const m = /^([0-9a-f]+) ([0-9a-f]+) .*? (\d+) [+-]\d{4}(?:\t(.*))?$/.exec(line);
    if (m) out.push({ old: m[1]!, next: m[2]!, time: Number(m[3]), message: m[4] ?? '' });
  }
  return out;
}

function reflogs(common: string): Reflog[] {
  const out: Reflog[] = [{ file: join(common, 'logs', 'HEAD'), ref: 'HEAD', gitDir: common }];
  try {
    for (const name of readdirSync(join(common, 'worktrees')).sort()) {
      out.push({ file: join(common, 'worktrees', name, 'logs', 'HEAD'), ref: `worktrees/${name}/HEAD`, gitDir: join(common, 'worktrees', name) });
    }
  } catch { /* no linked worktrees */ }
  const walk = (dir: string, ref: string) => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      try { if (statSync(path).isDirectory()) walk(path, `${ref}/${name}`); else out.push({ file: path, ref: `${ref}/${name}`, gitDir: null }); } catch { /* raced away */ }
    }
  };
  walk(join(common, 'logs', 'refs', 'heads'), 'refs/heads');
  return out;
}

/** The checkout a worktree git dir belongs to (its gitdir file names <top>/.git), else the main checkout. */
function checkoutOf(repo: Repo, gitDir: string | null): string {
  if (gitDir) for (const c of repo.checkouts.values()) if (canonical(c.gitDir) === canonical(gitDir)) return c.top;
  if (gitDir && gitDir !== repo.common) {
    try { return resolve(readFileSync(join(gitDir, 'gitdir'), 'utf8').trim(), '..'); } catch { /* fall through */ }
  }
  return [...repo.checkouts.values()][0]!.top;
}

async function repositories(engine: BrainEngine): Promise<{ repos: Repo[]; skipped: string[] }> {
  const roots = new Map<string, string[]>(await sourceRoots(engine));
  try {
    const hostId = existingHostIdFor(engine);
    if (hostId) {
      for (const row of await engine.executeRaw<{ local_path: string; source_id: string | null }>(
        `SELECT h.local_path, s.source_id FROM persistence_host_bindings h LEFT JOIN persistence_source_bindings s ON s.worktree_id=h.worktree_id
          WHERE h.host_id=$1::uuid AND h.local_path IS NOT NULL ORDER BY h.local_path`, [hostId])) {
        const ids = roots.get(row.local_path) ?? [];
        if (row.source_id && !ids.includes(row.source_id)) ids.push(row.source_id);
        roots.set(row.local_path, ids);
      }
    }
  } catch { /* an embedded engine without a host id, or a brain without the managed tables */ }
  const repos = new Map<string, Repo>();
  const skipped: string[] = [];
  if (roots.size > MAX_ROOTS) skipped.push(`${roots.size - MAX_ROOTS} source root(s) past the ${MAX_ROOTS}-root scan cap were not scanned`);
  for (const [root, ids] of [...roots].slice(0, MAX_ROOTS)) {
    if (!existsSync(root)) continue;
    const probe = gitRun(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
    const out = probe.out?.split('\n');
    if (!out?.[0] || !out[1]) {
      if (probe.timedOut || insideGitCheckout(root)) skipped.push(`${root} could not be read as a Git checkout (git rev-parse ${probe.timedOut ? `timed out after ${GIT_TIMEOUT_MS / 1000} s` : 'failed'})`);
      continue;
    }
    const [top, gitDir] = [out[0], out[1]];
    let common = gitDir;
    try { common = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* the main git dir */ }
    const key = canonical(common);
    const repo = repos.get(key) ?? { common, checkouts: new Map() };
    const rel = relative(canonical(top), canonical(root)).split(sep).join('/');
    const entry = repo.checkouts.get(top) ?? { top, gitDir, source_ids: [], roots: [] };
    entry.source_ids.push(...ids.filter(id => !entry.source_ids.includes(id)));
    entry.roots.push(rel.startsWith('..') ? '' : rel);
    repo.checkouts.set(top, entry);
    repos.set(key, repo);
  }
  return { repos: [...repos.values()], skipped };
}

/** Paths gbrain is about to commit: queued or running git effects, absolute. */
async function pendingEffectPaths(engine: BrainEngine): Promise<Set<string>> {
  let hostId: string | null = null;
  try { hostId = existingHostIdFor(engine); } catch { /* embedded engine without an id */ }
  const out = new Set<string>();
  try {
    const rows = await engine.executeRaw<{ rel: string; source_path: string | null; worktree_path: string | null }>(
      `SELECT e.data->>'relative_path' AS rel, s.local_path AS source_path, h.local_path AS worktree_path
         FROM persistence_effects e LEFT JOIN sources s ON s.id=e.source_id
         LEFT JOIN persistence_host_bindings h ON h.worktree_id=e.worktree_id AND h.host_id=$1::uuid
        WHERE e.kind='git' AND e.state IN ('queued','running') AND e.data ? 'relative_path' LIMIT 10000`, [hostId]);
    for (const row of rows) for (const base of [row.source_path, row.worktree_path]) if (base && row.rel) out.add(canonical(resolve(base, row.rel)));
  } catch { /* no persistence tables */ }
  return out;
}

interface Dirty { path: string; checkout: string; state: 'untracked' | 'modified' | 'deleted' | 'unmerged'; age_ms: number }

/** The dirty page files of one checkout, or why git status could not list them. `timeout` is the caller's share of doctor's budget. */
function dirtyFiles(c: Checkout, skip: Set<string>, now: number, timeout: number): Dirty[] | { failed: string } {
  const specs = c.roots.includes('') ? ['.'] : c.roots.map(r => `:(literal)${r}`);
  const status = gitRun(c.top, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', ...specs], undefined, timeout);
  const raw = status.out;
  if (raw === null) return { failed: status.timedOut ? `git status timed out after ${Math.round(timeout / 1000)} s in ${c.top} (a large checkout: run git status there to list its files)` : `git status failed in ${c.top}` };
  const pending = new Set(readPendingWriteThrough(c.top).map(e => canonical(join(c.top, e.path))));
  const fields = raw.split('\0');
  const out: Dirty[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    let path: string | null = null;
    let state: Dirty['state'] = 'modified';
    if (f.startsWith('? ')) { path = f.slice(2); state = 'untracked'; }
    else if (f.startsWith('1 ') || f.startsWith('2 ')) {
      const parts = f.split(' ');
      const y = parts[1]![1];
      path = parts.slice(f.startsWith('1 ') ? 8 : 9).join(' ');
      if (f.startsWith('2 ')) i++;
      if (y === '.') continue;
      if (y === 'D') state = 'deleted';
    } else if (f.startsWith('u ')) { path = f.split(' ').slice(10).join(' '); state = 'unmerged'; }
    if (!path) continue;
    const abs = join(c.top, path);
    const key = canonical(abs);
    if (skip.has(key) || pending.has(key)) continue;
    let age = 0;
    try { age = Math.max(0, now - lstatSync(abs).mtimeMs); } catch { /* a deleted file has no mtime */ }
    out.push({ path, checkout: c.top, state, age_ms: Math.round(age) });
  }
  return out;
}

function enforceGuardSince(gitDir: string | null): number | null {
  if (!gitDir) return null;
  const hook = join(gitDir, OWNER_HOOKS_DIR, GUARD_HOOK);
  try { return readFileSync(hook, 'utf8').includes(GUARD_ENFORCE_MARKER) ? statSync(hook).mtimeMs : null; } catch { return null; }
}

interface RepoReport {
  common: string; checkouts: string[]; ledger: boolean; window_from: string | null; ledger_start: string | null; oldest_reflog: string | null;
  uncovered: number; foreign: ForeignCommit[]; unconfirmed: ForeignCommit[]; unknown: { ref: string; old: string; new: string; time: string }[];
}

function scanRepo(repo: Repo, deadline: number): { report: RepoReport; partial: boolean; reason?: string } {
  let ledger: ReturnType<typeof readLedger>;
  try { ledger = readLedger(repo.common); }
  catch (error) {
    const report: RepoReport = { common: repo.common, checkouts: [...repo.checkouts.keys()], ledger: false, window_from: null, ledger_start: null, oldest_reflog: null, uncovered: 0, foreign: [], unconfirmed: [], unknown: [] };
    return { report, partial: true, reason: `the commit ledger in ${ledgerFiles(repo.common).dir} could not be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}), so no commit there was attributed` };
  }
  const ledgered = new Set<string>();
  const intents: { head_before: string | null; msg: string; t: number; who: string; resolved: boolean }[] = [];
  let start: number | null = null;
  for (const r of ledger) {
    if (r.e === 'start') start = Date.parse(r.t);
    else if (r.e === 'commit') {
      ledgered.add(r.sha);
      // The intent this commit line completes: the same process's newest open one. Only an intent left open can explain a commit.
      const who = `${r.host}\0${r.pid}\0${r.writer}`;
      const open = intents.findLast(i => !i.resolved && i.who === who);
      if (open) open.resolved = true;
    } else intents.push({ head_before: r.head_before, msg: r.msg_sha256, t: Date.parse(r.t), who: `${r.host}\0${r.pid}\0${r.writer}`, resolved: false });
  }
  if (start === null && ledger.length) start = Date.parse(ledger[0]!.t);
  const startSec = start === null ? null : Math.floor(start / 1000);
  const report: RepoReport = { common: repo.common, checkouts: [...repo.checkouts.keys()], ledger: ledger.length > 0, window_from: null,
    ledger_start: start === null ? null : new Date(start).toISOString(), oldest_reflog: null, uncovered: 0, foreign: [], unconfirmed: [], unknown: [] };
  const anyTop = [...repo.checkouts.keys()][0]!;
  const candidates = new Map<string, Candidate>();
  let oldest: number | null = null;
  let partial = false;
  for (const log of reflogs(repo.common)) {
    if (Date.now() > deadline) { partial = true; break; }
    const checkout = checkoutOf(repo, log.gitDir);
    const entries = readReflog(log.file);
    const firstLedgered = entries.findIndex(e => ledgered.has(e.next));
    for (const [index, entry] of entries.entries()) {
      oldest = oldest === null ? entry.time : Math.min(oldest, entry.time);
      if (ZERO.test(entry.next)) continue;
      const kind = classifyReflogMessage(entry.message);
      if (kind === 'excluded') continue;
      // Reflog times are whole seconds: in the start's own second only entries after this log's first ledgered one are covered.
      const covered = startSec !== null && (entry.time > startSec || (entry.time === startSec && firstLedgered >= 0 && index > firstLedgered));
      if (!covered) { report.uncovered++; continue; }
      if (kind !== 'other') {
        if (!candidates.has(entry.next)) candidates.set(entry.next, { sha: entry.next, kind, ref: log.ref, time: entry.time, gitDir: log.gitDir, checkout });
        continue;
      }
      if (Date.now() > deadline) { partial = true; break; }
      const range = git(anyTop, ['log', '--format=%H %P %ct', '-n', String(MAX_RANGE_COMMITS), ...(ZERO.test(entry.old) ? [entry.next] : [`${entry.old}..${entry.next}`]), '--']);
      if (range === null) { report.unknown.push({ ref: log.ref, old: entry.old, new: entry.next, time: new Date(entry.time * 1000).toISOString() }); continue; }
      for (const line of range.split('\n').filter(Boolean)) {
        const parts = line.split(' ');
        const ct = Number(parts.at(-1));
        if (parts.length !== 3 || Math.abs(ct - entry.time) > PLUMBING_WINDOW_S) continue;
        if (!candidates.has(parts[0]!)) candidates.set(parts[0]!, { sha: parts[0]!, kind: 'plumbing', ref: log.ref, time: entry.time, gitDir: log.gitDir, checkout });
      }
    }
  }
  report.oldest_reflog = oldest === null ? null : new Date(oldest * 1000).toISOString();
  const from = start === null ? null : Math.max(start, (oldest ?? 0) * 1000);
  report.window_from = from === null ? null : new Date(from).toISOString();
  const open = [...candidates.values()].filter(c => !ledgered.has(c.sha));
  for (let i = 0; i < open.length && !partial; i += 200) {
    if (Date.now() > deadline) { partial = true; break; }
    const batch = open.slice(i, i + 200);
    const out = git(anyTop, ['log', '--no-walk', '--ignore-missing', '--stdin', '--format=%H%x00%P%x00%ct%x00%cn <%ce>%x00%s%x00%B%x1e'], batch.map(c => c.sha).join('\n') + '\n');
    if (out === null) {
      for (const c of batch) report.unknown.push({ ref: c.ref, old: '', new: c.sha, time: new Date(c.time * 1000).toISOString() });
      continue;
    }
    const meta = new Map<string, string[]>();
    for (const rec of out.split('\x1e')) {
      const f = rec.replace(/^\n/, '').split('\0');
      if (f.length >= 6 && f[0]) meta.set(f[0], f);
    }
    for (const c of batch) {
      const f = meta.get(c.sha);
      if (!f) { report.unknown.push({ ref: c.ref, old: '', new: c.sha, time: new Date(c.time * 1000).toISOString() }); continue; }
      const parents = f[1]!.split(' ').filter(Boolean);
      if (parents.length > 1) continue;
      const ct = Number(f[2]);
      const guard = c.kind === 'plain' ? enforceGuardSince(c.gitDir) : null;
      const commit: ForeignCommit = { sha: c.sha, kind: c.kind, guard_bypassed: guard !== null && guard <= ct * 1000, gbrain_trailer: gbrainTrailer(f[5]!), ref: c.ref, time: new Date(ct * 1000).toISOString(), subject: f[4]!, committer: f[3]!, checkout: c.checkout };
      const digest = messageDigest(f[5]!);
      const matched = intents.some(t => !t.resolved && t.head_before === (parents[0] ?? null) && t.msg === digest && ct * 1000 >= t.t - 1000 && ct * 1000 - t.t <= UNCONFIRMED_WINDOW_MS);
      (matched ? report.unconfirmed : report.foreign).push(commit);
    }
  }
  report.foreign.sort((a, b) => b.time.localeCompare(a.time));
  return { report, partial };
}

const label = (c: ForeignCommit) => c.guard_bypassed ? 'plain (guard bypassed)' : c.kind;
const ago = (ms: number) => ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 60_000)}m`;

async function runForeignWriters(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('foreign_writers');
  const engine = connectedEngine(ctx);
  const { repos, skipped } = await repositories(engine);
  if (!repos.length && !skipped.length) {
    checks.push(infoCheck('foreign_writers', 'Not applicable: no registered source on this host is a Git checkout, so there are no commits to attribute (the database is the record on a repo-less brain).', 'not_applicable'));
    return checks;
  }
  const deadline = (ctx.entryDeadlineAt ?? Number.POSITIVE_INFINITY) - SCAN_REPORT_RESERVE_MS;
  const now = Date.now();
  const skip = await pendingEffectPaths(engine);
  const reports: RepoReport[] = [];
  const dirty: Dirty[] = [];
  const reasons = [...skipped];
  const budget = () => { if (Date.now() <= deadline) return false; if (!reasons.includes(BUDGET_REASON)) reasons.push(BUDGET_REASON); return true; };
  for (const repo of repos) {
    if (budget()) break;
    const scanned = scanRepo(repo, deadline);
    reports.push(scanned.report);
    if (scanned.reason) reasons.push(scanned.reason);
    else if (scanned.partial && !reasons.includes(BUDGET_REASON)) reasons.push(BUDGET_REASON);
    for (const c of repo.checkouts.values()) {
      if (budget()) break;
      const timeout = Number.isFinite(deadline) ? Math.max(GIT_TIMEOUT_MS, Math.min(STATUS_TIMEOUT_MAX_MS, deadline - Date.now())) : GIT_TIMEOUT_MS;
      const found = dirtyFiles(c, skip, now, timeout);
      if (Array.isArray(found)) dirty.push(...found); else reasons.push(found.failed);
    }
  }
  const partial = reasons.length > 0;
  const isOld = (d: Dirty) => d.age_ms > FOREIGN_DIRTY_WARN_MS;
  dirty.sort((a, b) => Number(isOld(b)) - Number(isOld(a)) || a.checkout.localeCompare(b.checkout) || a.path.localeCompare(b.path));
  const foreign = reports.flatMap(r => r.foreign).sort((a, b) => b.time.localeCompare(a.time) || a.sha.localeCompare(b.sha));
  const unconfirmed = reports.flatMap(r => r.unconfirmed);
  const unknown = reports.flatMap(r => r.unknown);
  const old = dirty.filter(isOld).sort((a, b) => b.age_ms - a.age_ms);
  const details = {
    window: reports.map(r => ({ common: r.common, from: r.window_from, to: new Date(now).toISOString(), ledger_start: r.ledger_start, oldest_reflog: r.oldest_reflog, uncovered: r.uncovered, ledger: r.ledger })),
    foreign, unconfirmed, unknown, dirty: dirty.slice(0, MAX_LISTED), dirty_count: dirty.length, dirty_warn_after_minutes: FOREIGN_DIRTY_WARN_MS / 60_000, partial, partial_reasons: reasons,
  };
  const scope = `${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}${partial ? ' (partial)' : ''}`;
  if (foreign.length) {
    const newest = foreign[0]!;
    const line = `Commit ${newest.sha.slice(0, 12)} (${label(newest)}, "${newest.subject}", ${newest.time}) in ${newest.checkout} was not made by gbrain; route that writer through gbrain git commit-push or a page write`;
    const trailed = foreign.filter(c => c.gbrain_trailer);
    const older = trailed.length ? ` ${trailed.length} of them carry a gbrain- commit trailer (${trailed.slice(0, 3).map(c => c.sha.slice(0, 12)).join(', ')}): possibly an older gbrain without the commit ledger, co-installed on this host; upgrade every gbrain that writes to this checkout (a trailer alone does not prove gbrain made the commit).` : '';
    checks.push({ name: 'foreign_writers', status: 'fail', details,
      message: `${foreign.length} commit(s) in ${scope} were made by a writer outside gbrain: ${foreign.slice(0, 5).map(c => `${c.sha.slice(0, 12)} ${label(c)} by ${c.committer}`).join(', ')}${foreign.length > 5 ? ', ...' : ''}. ${line}.${older}`,
      fix: { ask_user: true, argv: ['git', '-C', newest.checkout, 'show', '--stat', newest.sha], consent: [], actor: 'user', requires_exclusive: false,
        why: `${line}. A commit made around gbrain skips its writer lock and leaves files no import recorded; finding and rerouting the writer (a cron, a script, an agent running plain git, or an older gbrain without the commit ledger) is the user's call.`,
        user_message: `A writer outside gbrain committed ${newest.sha.slice(0, 12)} ("${newest.subject}") in ${newest.checkout} at ${newest.time}. Which job or agent makes these commits, so it can be switched to gbrain git commit-push or a page write?`,
        verify: doctorVerify('foreign_writers') } });
    return checks;
  }
  if (unconfirmed.length || unknown.length || old.length || partial) {
    const parts = [
      partial ? `the scan did not finish (${reasons.join('; ')}), so part of the window is unchecked` : '',
      unconfirmed.length ? `${unconfirmed.length} commit(s) match a gbrain intent whose commit line is missing (a crash between git commit and the ledger append): ${unconfirmed.slice(0, 5).map(c => c.sha.slice(0, 12)).join(', ')}; they are not written back to the ledger` : '',
      unknown.length ? `${unknown.length} ref move(s) whose commits could not be read: ${unknown.slice(0, 5).map(u => `${u.ref} -> ${u.new.slice(0, 12)}`).join(', ')}` : '',
      old.length ? `${old.length} page file(s) have been untracked or modified for more than ${FOREIGN_DIRTY_WARN_MS / 60_000} minutes with no gbrain commit pending: ${old.slice(0, 5).map(d => `${d.path} (${d.state}, ${ago(d.age_ms)})`).join(', ')}${old.length > 5 ? ', ...' : ''}` : '',
    ].filter(Boolean);
    checks.push({ name: 'foreign_writers', status: 'warn', details,
      message: `No foreign commit in ${scope}, but: ${parts.join('; ')}. A file another writer left there becomes a drift hold or rides along with the next commit made without paths.` });
    return checks;
  }
  checks.push({ name: 'foreign_writers', status: 'ok', details,
    message: `Every locally created commit in the covered window of ${scope} is in gbrain's commit ledger, and no page file waits uncommitted for more than ${FOREIGN_DIRTY_WARN_MS / 60_000} minutes.${reports.some(r => !r.ledger) ? ' A repository gbrain has not committed in yet has no ledger, so its window is empty.' : ''}` });
  return checks;
}

export const foreignWritersEntry: DoctorEntry = {
  name: 'foreign_writers',
  emits: ['foreign_writers'],
  run: runForeignWriters,
};
