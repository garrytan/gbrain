/**
 * #6650 L0 / #6712 PR 0: the managed-sync convergence gate.
 *
 * Each scenario builds one isolated Postgres brain behind PgBouncer in
 * transaction mode, reached by every child process through a TCP proxy in this
 * file that adds GBRAIN_TEST_CONVERGENCE_LATENCY_MS (default 50) of round-trip
 * latency to the pooled URL and to the direct URL (GBRAIN_DIRECT_DATABASE_URL).
 * The managed fixture is GBRAIN_TEST_CONVERGENCE_NOTES notes (default 200) plus
 * one large, child-heavy page (a facts fence and a long timeline). Production
 * never installs a fault hook, so the faulted processes are the real
 * `src/cli.ts serve` / `sync` entry points started with the hook-installing
 * preload test/fixtures/convergence-fault-kill.ts (the persistence gate's seam,
 * `fault-points.ts`), which kills, stalls, edits or throws a given SQLSTATE at a named point.
 *
 * Chaos modes (MODES below; a mode master fails is skipped with the PR that turns it on):
 *   (a) client kills and (b) serve kills mid-publish: a kill loop of
 *       GBRAIN_TEST_CONVERGENCE_KILLS (default 6) seeded `kill -9`s at fault points
 *       from the curated sync-reachable list KILL_POINTS, one per change round,
 *       cycling a `--no-delegate` client, a resident serve running a delegated
 *       catch-up, and a serve together with the client delegating to it;
 *   (c) concurrent writers through the coordinator during the kill loop:
 *       `gbrain put` rewrites, `remember` facts on an entity page and a managed
 *       maintenance job (`gbrain extract timeline --source db`);
 *   (c-db) a DB-only competitor: a DB-only write racing a file change of the
 *       same page ends as a named `concurrent_write` hold with both versions
 *       kept; a DB-only write to a page whose file did not change converges;
 *   (d) out-of-band `git mv` / `git rm` of 1% of committed files and deletion
 *       of uncommitted worktree files while a run is stalled mid-manifest;
 *   (e) a deterministic mid-run edit: the `sync:after_freeze` hook edits a
 *       seeded entry after it was frozen and before it is published;
 *   (f) a pooler drop mid-bulk (no new holds);
 *   (g) two concurrent drainers: a `--all` run beside a serve;
 *   (knock-on) one page's failure inside a bulk group cancels none of the others;
 *   (systemic) a trigger raising an unregistered P0001, then a 55000, on every
 *       page write for one run: the run stops with one named blocker, and a
 *       plain sync converges once the trigger is gone.
 *
 * Every scenario then gets a fresh serve (what a supervisor restarts) and at
 * most MAX_RECOVERY_RUNS plain `gbrain sync --no-pull` runs, with no operator
 * step; only exit 0 with outcome `synced` counts. The oracle tests are named by
 * the persistence gate's violation class: disk == database for every page
 * (except the pages a mode's end state names: a ghost, a held page); no request
 * blocks the checkpoint or a root; every non-committed terminal request is
 * superseded or carries a registered code; the cursor reached HEAD; the large
 * page keeps every fence fact; the acknowledged-write ledger (every writer
 * operation that returned success, recorded here independently of the brain)
 * survives or is causally superseded by a later acknowledged write; and
 * `gbrain sync status --json` reports the converged state with every field the
 * operator loop reads present.
 *
 * Every random choice comes from GBRAIN_TEST_CONVERGENCE_SEED (default 6650), and
 * every failure prints the seed, the scenario's modes, its fault plan and a
 * one-line local repro command. GBRAIN_TEST_CONVERGENCE_MODES=a,d,... runs
 * exactly those modes (a skipped mode named there runs anyway). Setup:
 * scripts/persistence/README.md ("Managed-sync convergence gate"). It is
 * skipped unless GBRAIN_TEST_CONVERGENCE=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { contentHash } from '../src/core/utils.ts';
import { CODES } from '../src/core/error-registry.ts';
import { CONSUMER_LIVE_MS, CONSUMER_RENEWAL_MS } from '../src/core/persistence/consumer-heartbeat.ts';
import type { FaultPoint } from '../src/core/persistence/fault-points.ts';
import { PUBLICATION_CEILING_DEFAULT_MS, publicationLeaseMs } from '../src/core/persistence/publication-deadline.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { withEnv } from './helpers/with-env.ts';
import { LatencyProxy } from './helpers/latency-proxy.ts';
import type { ViolationClass } from '../scripts/persistence/model.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const FAULT_PRELOAD = join(REPO_ROOT, 'test/fixtures/convergence-fault-kill.ts');
const knob = (name: string, fallback: number): number => {
  const raw = process.env[`GBRAIN_TEST_CONVERGENCE_${name}`];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`GBRAIN_TEST_CONVERGENCE_${name} must be a non-negative integer, got '${raw}'.`);
  return value;
};
const SEED = knob('SEED', 6650);
const LATENCY_MS = knob('LATENCY_MS', 50);
const NOTES = Math.max(20, knob('NOTES', 200));
const KILLS = knob('KILLS', 6);
/** Per child process (a sync or a writer call) and per scenario setup; the nightly cell raises both. */
const SYNC_TIMEOUT_MS = knob('SYNC_TIMEOUT_MS', 900_000);
const SCENARIO_TIMEOUT_MS = knob('SCENARIO_TIMEOUT_MS', 3_600_000);
const pooledTarget = process.env.GBRAIN_PGBOUNCER_URL;
const directTarget = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
const enabled = process.env.GBRAIN_TEST_CONVERGENCE === '1';
if (enabled && !(pooledTarget && directTarget)) {
  throw new Error('GBRAIN_TEST_CONVERGENCE=1 needs GBRAIN_PGBOUNCER_URL (transaction-mode PgBouncer) and GBRAIN_PGBOUNCER_DIRECT_URL (the Postgres behind it).');
}
const PGBOUNCER_CONTAINER = process.env.GBRAIN_TEST_CONVERGENCE_PGBOUNCER_CONTAINER;
const LOG_DIR = process.env.GBRAIN_TEST_CONVERGENCE_LOG_DIR;

/** The chaos modes. `skip` names the PR that turns a mode master fails on; the mode stays written and runs when named in GBRAIN_TEST_CONVERGENCE_MODES. */
const MODES = {
  a: { title: 'client kills', skip: null },
  b: { title: 'serve kills mid-publish', skip: null },
  c: { title: 'concurrent writers: put, remember and a managed maintenance job', skip: null },
  'c-db': { title: 'a DB-only competitor', skip: null },
  d: { title: 'out-of-band git mv/git rm of committed files and deletion of uncommitted files', skip: null },
  e: { title: 'a deterministic mid-run edit after freezeEntry', skip: null },
  f: { title: 'a pooler drop mid-bulk', skip: null },
  g: { title: 'two concurrent drainers: a --all run beside a serve', skip: null },
  lease: { title: 'the drain-lease holder killed with two followers queued behind it', skip: null },
  'knock-on': { title: 'one page failure inside a bulk group', skip: null },
  systemic: { title: 'a systemic database refusal: an unknown P0001 or a 55000 from a trigger on every page write', skip: null },
} as const satisfies Record<string, { title: string; skip: string | null }>;
type Mode = keyof typeof MODES;
const requestedModes = process.env.GBRAIN_TEST_CONVERGENCE_MODES?.split(',').map(mode => mode.trim()).filter(Boolean);
for (const mode of requestedModes ?? []) if (!(mode in MODES)) throw new Error(`GBRAIN_TEST_CONVERGENCE_MODES names unknown mode '${mode}' (known: ${Object.keys(MODES).join(', ')}).`);
const runs = (mode: Mode): boolean => requestedModes ? requestedModes.includes(mode) : MODES[mode].skip === null;

const SOURCE = 'workspace';
const BIG = 'companies/acme-example';
const ENTITY = 'people/alice-example';
/**
 * The kill loop's fault points: the seams a managed sync import crosses. Its pages are already in Git, so the
 * file-publication pair (`before_publication`/`after_publication`) never fires for it. Per-page seams are counted
 * per submit_job request (nth inside the first 60% of a round); `lane:applied` and `sync:before_group_admission`
 * fire once per bulk group, and a small round may form one group, so they kill at the first; `sync:mid_checkpoint`
 * fires on every cursor save (the first or second). #6712's `sync:retry_deferred` and `sync:held_settled` need a file
 * that changes after its freeze: their round primes one with an uncommitted edit at `sync:after_freeze`, which is
 * deferred once (the first) and, when its retry finds the same newer bytes, held `worktree_dirty` (the hold); the
 * harness commits the edit after the round.
 */
const KILL_POINTS = [
  { point: 'publication:before_commit', per: 'page' }, { point: 'publication:after_commit', per: 'page' },
  { point: 'consumer:preparing', per: 'page' }, { point: 'lane:applied', per: 'group' },
  { point: 'sync:before_group_admission', per: 'group' }, { point: 'sync:mid_checkpoint', per: 'save' },
  { point: 'sync:held_settled', per: 'held' }, { point: 'sync:retry_deferred', per: 'deferred' },
  // #6712 PR 1: inside the guarded kernel run of prescreened entries (its round also commits mode-only changes, so it has some).
  { point: 'sync:prescreened', per: 'group' },
  // #6712 PR 2 (L5): after the checkpoint committed and the lease was released, before the owed tail runs (the next sync runs it).
  { point: 'sync:tail_started', per: 'group' },
] as const satisfies ReadonlyArray<{ point: FaultPoint; per: 'page' | 'group' | 'save' | 'held' | 'deferred' }>;
const MAX_RECOVERY_RUNS = 2;
/** Oracle tests are named by the persistence gate's violation class (scripts/persistence/model.ts) they would report. */
const as = (violation: ViolationClass, title: string): string => `[${violation}] ${title}`;
/**
 * The longest a sync may sit with no progress after an owner was killed: the
 * window in which a dead owner's heartbeat still reads live, one renewal
 * interval for the survivor to notice, and slack for a slow group. Waiting out
 * a publication lease (`publicationLeaseMs`, 365 s by default) blows it.
 */
const OWNER_KILL_STALL_BOUND_S = (CONSUMER_LIVE_MS + CONSUMER_RENEWAL_MS + 30_000) / 1000;

/** mulberry32: a fixed seed gives the same fault plan and writer targets on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the status oracle

/** Every `gbrain sync status --json` field the operator loop reads (sync-status.ts `SyncStatus`). */
const STATUS_FIELDS = ['source_id', 'run_id', 'cursor', 'committed_last_10m', 'live_job_id', 'holds', 'last_error', 'needs_human',
  'resume_argv', 'checkpoint_blockers', 'cursors', 'terminal_failures', 'next'] as const;
interface StatusExpectation { holds?: Array<{ code: string; path: string }>; needsHuman?: boolean }
/**
 * What a converged source's status must say. Field-present assertions first: a renderer that drops a field fails
 * here, not in an agent's loop. `checkpoint_blockers` and `cursors` are arrays on every status (#6712 PR 0 made
 * `checkpoint_blockers` always present). The harness reads `sync status --json --detail`: since #6712 PR 2 the
 * terminal summary, blocker list and cursor join run only behind the flag.
 */
/** The default (no `--detail`) status after the chaos: every skipped heavy read says so and names the `--detail` command (#6712 PR 2, DX F1). */
function fastStatusProblems(status: Record<string, unknown> | null): string[] {
  if (!status) return ['sync status --json printed no JSON document'];
  return (['checkpoint_blockers_read', 'cursors_read', 'terminal_failures_read'] as const).flatMap(field => {
    const read = status[field] as { status?: string; fix?: { argv?: string[] } } | undefined;
    return read?.status === 'not_read' && read.fix?.argv?.includes('--detail') ? [] : [`sync status --json: ${field} is ${JSON.stringify(read)}, expected not_read with a --detail fix`];
  });
}

function statusProblems(status: Record<string, unknown> | null, expected: StatusExpectation = {}): string[] {
  if (!status) return ['sync status --json printed no JSON document'];
  const out = STATUS_FIELDS.filter(field => !(field in status)).map(field => `sync status --json: field ${field} missing`);
  if (out.length) return out;
  const cursor = status.cursor as { done?: boolean } | null;
  if (!Array.isArray(status.cursors)) out.push('sync status --json: cursors is not an array');
  if (!Array.isArray(status.checkpoint_blockers)) out.push('sync status --json: checkpoint_blockers is not an array');
  else if (status.checkpoint_blockers.length) out.push(`sync status --json: ${status.checkpoint_blockers.length} checkpoint blocker(s)`);
  // A finished run's cursor is retired, so a converged source shows none (null) or a done one.
  if (cursor && cursor.done !== true) out.push(`sync status --json: cursor not done (${JSON.stringify(cursor)})`);
  const terminal = status.terminal_failures as { status?: string; active_blockers?: unknown[] } | null;
  if (terminal?.status !== 'ok') out.push(`sync status --json: terminal_failures.status is ${terminal?.status}`);
  else if (!Array.isArray(terminal.active_blockers)) out.push('sync status --json: terminal_failures.active_blockers is not an array');
  else if (terminal.active_blockers.length) out.push(`sync status --json: ${terminal.active_blockers.length} active terminal blocker(s)`);
  if (status.needs_human !== (expected.needsHuman ?? false)) out.push(`sync status --json: needs_human is ${status.needs_human}, expected ${expected.needsHuman ?? false}`);
  const holds = Array.isArray(status.holds) ? (status.holds as Array<{ code: string; path: string }>).map(h => `${h.code}:${h.path}`).sort() : ['holds is not an array'];
  const want = (expected.holds ?? []).map(h => `${h.code}:${h.path}`).sort();
  if (JSON.stringify(holds) !== JSON.stringify(want)) out.push(`sync status --json: holds [${holds.join(', ')}], expected [${want.join(', ')}]`);
  if (status.last_error !== null) out.push(`sync status --json: last_error ${JSON.stringify(status.last_error)}`);
  if (!expected.holds?.length && status.next !== null) out.push(`sync status --json: next ${JSON.stringify(status.next)}`);
  return out;
}

// ---------------------------------------------------------------- the acknowledged-write ledger

/**
 * One writer operation that returned success, recorded by the harness at the moment it saw the success (never read
 * back from the brain), or a write the brain accepted (exit 10) that had not settled when its writer stopped, recorded
 * when its receipt, read after recovery, said committed (`Brain.settlePending`). `touches` is where the write landed: the page in the database, its file, or (for `remember`)
 * an additive fact row. `marker` is text that only this write put there; `null` on a page location is a deletion.
 */
interface Ack { kind: 'commit' | 'put' | 'remember' | 'maintenance' | 'db_only' | 'git_mv' | 'git_rm' | 'unlink'; slug: string;
  marker: string | null; touches: Array<'db' | 'file'> | 'fact'; start: number; ack: number }
class Ledger {
  acks: Ack[] = [];
  record(ack: Ack): void { this.acks.push(ack); }
  /**
   * For every slug and location, the writes no later acknowledged write causally supersedes (none started after it
   * was acknowledged); the final state must show one of them. An additive fact survives unless a page write on its
   * slug may have been ordered after it.
   */
  problems(disk: Map<string, string>, db: Map<string, { body: string } | null>, facts: Set<string>): string[] {
    const out: string[] = [];
    const pageWrites = this.acks.filter(a => a.touches !== 'fact' && a.kind !== 'maintenance');
    for (const slug of new Set(pageWrites.map(a => a.slug))) {
      for (const where of ['db', 'file'] as const) {
        const writes = pageWrites.filter(a => a.slug === slug && (a.touches as string[]).includes(where));
        if (!writes.length) continue;
        const maximal = writes.filter(w => !writes.some(later => later.start > w.ack));
        const seen = where === 'file' ? disk.get(slug) ?? null : db.get(slug)?.body ?? null;
        if (maximal.some(w => w.marker === null ? seen === null : seen?.includes(w.marker))) continue;
        out.push(`${where} ${slug}: lost acknowledged write; has ${seen === null ? 'nothing' : JSON.stringify(seen.slice(0, 80))}, expected one of ${maximal.map(w => `${w.kind}@${Math.round(w.ack)}:${w.marker === null ? '(absent)' : JSON.stringify(w.marker)}`).join(' | ')}`);
      }
    }
    for (const fact of this.acks.filter(a => a.touches === 'fact')) {
      const excused = pageWrites.some(w => w.slug === fact.slug && (w.touches as string[]).includes('db') && w.ack > fact.start);
      if (!excused && !facts.has(fact.marker!)) out.push(`fact on ${fact.slug}: lost acknowledged remember ${JSON.stringify(fact.marker)}`);
    }
    return out;
  }
}

// ---------------------------------------------------------------- the fixture

function noteText(i: number, version: string): string {
  return `---\ntype: concept\ntitle: Note ${i} Example\n---\n\n${version} body for note ${i}, an observation about widget-co and acme-example.\n\n${'Supporting detail sentence. '.repeat(8 + (i % 5))}\n`;
}
const noteMarker = (i: number, version: string) => `${version} body for note ${i},`;
const noteSlug = (i: number) => `notes/note-${String(i).padStart(4, '0')}`;
function bigPage(facts: number, timeline: number, version: string): string {
  const day = (n: number) => new Date(Date.UTC(2018, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
  const paragraphs = Array.from({ length: 30 }, (_, i) => `Section ${i} (${version}): acme-example ${'expanded with a steady stream of synthetic operating detail. '.repeat(6)}`);
  const rows = Array.from({ length: facts }, (_, i) =>
    `| ${i + 1} | Synthetic claim ${i + 1} about acme-example | fact | 0.9 | world | medium | ${day(i)} |  | fixture |  |`);
  const bullets = Array.from({ length: timeline }, (_, i) => `- **${day(i)}** | Synthetic event ${i + 1} at acme-example`);
  return [
    '---', 'type: company', 'title: Acme Example', '---', '', '# Acme Example', '', ...paragraphs.flatMap(p => [p, '']),
    '## Facts', '', '<!--- gbrain:facts:begin -->',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
    ...rows, '<!--- gbrain:facts:end -->', '', '<!-- timeline -->', '', ...bullets, '',
  ].join('\n');
}
const entityText = '---\ntype: person\ntitle: Alice Example\n---\n\nAlice Example works with acme-example.\n';

// ---------------------------------------------------------------- one brain

interface Fault { point: FaultPoint; nth: number; marker: string; operation?: string; path?: string; action?: 'kill' | 'edit' | 'stall' | 'throw';
  edit?: { file: string; content: string }; release?: string; ms?: number; sqlstate?: string;
  prime?: { point: FaultPoint; nth: number; path?: string; edit: { file: string; content: string } } }
interface Run { code: number; out: string; err: string; ms: number }
interface SyncRun { proc: ReturnType<typeof Bun.spawn>; result: Promise<Run> }

async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 300_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}
function lastJson(out: string): Record<string, unknown> | null {
  try { return JSON.parse(out) as Record<string, unknown>; } catch { /* several documents */ }
  for (const line of out.trim().split('\n').reverse()) { try { return JSON.parse(line) as Record<string, unknown>; } catch { /* not the envelope */ } }
  return null;
}
/** The longest `stalled Ns` progress line a sync printed: how long it waited on a predecessor's leftovers. */
function worstStall(err: string): number { return Math.max(0, ...[...err.matchAll(/stalled (\d+)s/g)].map(m => Number(m[1]))); }

/**
 * One scenario's brain: its database, home, Git worktree, proxies, child processes, ledger and log. `context()` is
 * what every failure prints: seed, modes, the fault plan and the one-line repro.
 */
class Brain {
  home = ''; repo = ''; database = '';
  admin: ReturnType<typeof postgres> | undefined;
  engine: PostgresEngine | undefined;
  pooledProxy: LatencyProxy | undefined; directProxy: LatencyProxy | undefined;
  pooledUrl = ''; directUrl = '';
  serves: StdioServe[] = [];
  ledger = new Ledger();
  /** Writes the brain accepted (exit 10) that had not settled when their writer stopped; `settlePending` reads their receipts after recovery. */
  pending: Array<{ write: Omit<Ack, 'ack'>; requestId: string }> = [];
  plan: string[] = [];
  fired: Record<string, string | null> = {};
  killedPids = new Set<number>();
  recoveryRuns: Array<Run & { envelope: Record<string, unknown> | null }> = [];
  elapsed: Record<string, number> = {};
  calibration: string[] = [];
  readonly rand: () => number;
  constructor(readonly name: string, readonly modes: Mode[]) { this.rand = prng(SEED ^ [...name].reduce((h, c) => Math.imul(h, 31) + c.charCodeAt(0), 7)); }

  between(lo: number, hi: number): number { return lo + Math.floor(this.rand() * (hi - lo + 1)); }
  note(line: string): void {
    console.error(`[convergence ${this.name}] ${line}`);
    if (LOG_DIR) { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(join(LOG_DIR, 'convergence.log'), `[${this.name}] ${line}\n`); }
  }
  keepLog(name: string, text: string): void { if (LOG_DIR) { mkdirSync(join(LOG_DIR, this.name), { recursive: true }); writeFileSync(join(LOG_DIR, this.name, name), text); } }
  context(): string {
    const env = [`GBRAIN_TEST_CONVERGENCE_SEED=${SEED}`, `GBRAIN_TEST_CONVERGENCE_MODES=${this.modes.join(',')}`, `GBRAIN_TEST_CONVERGENCE_NOTES=${NOTES}`,
      `GBRAIN_TEST_CONVERGENCE_KILLS=${KILLS}`, `GBRAIN_TEST_CONVERGENCE_LATENCY_MS=${LATENCY_MS}`];
    return [`seed ${SEED}; modes ${this.modes.join(',')}; notes ${NOTES}; latency ${LATENCY_MS} ms`,
      `fault plan: ${this.plan.join('; ') || 'none'}`,
      `fired: ${Object.entries(this.fired).map(([k, v]) => `${k} => ${v ?? 'did not fire'}`).join('; ') || 'none'}`,
      `repro (Postgres + PgBouncer from scripts/persistence/README.md): ${env.join(' ')} GBRAIN_PGBOUNCER_URL="$GBRAIN_PGBOUNCER_URL" GBRAIN_PGBOUNCER_DIRECT_URL="$GBRAIN_PGBOUNCER_DIRECT_URL" bun run test:convergence`].join('\n');
  }
  /** Throws with the problems and the failure context; a passing check prints nothing. */
  verdict(problems: string[]): void {
    if (problems.length) throw new Error(`${problems.length} problem(s):\n  ${problems.slice(0, 40).join('\n  ')}\n${this.context()}`);
  }
  marker(tag: string): string { return join(this.home, `fault-${tag}.json`); }
  recordFault(tag: string, label: string): string | null {
    const at = existsSync(this.marker(tag)) ? readFileSync(this.marker(tag), 'utf8') : null;
    this.fired[label] = at;
    if (at) { const fired = JSON.parse(at) as { pid: number; action: string }; if (fired.action === 'kill') this.killedPids.add(fired.pid); }
    return at;
  }

  git(...args: string[]): string { return execFileSync('git', ['-C', this.repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  /**
   * Writes files and commits exactly those paths, as the shared-checkout rules require of every committer; each write
   * is acknowledged when the commit returns. Sweeping the worktree (`git add -A`) would commit a writer's in-flight
   * write-through bytes as an out-of-band Git change of a page that writer is still writing.
   */
  commit(message: string, files: Array<{ slug: string; content: string; marker: string }>): void {
    const start = performance.now();
    for (const f of files) { mkdirSync(dirname(join(this.repo, `${f.slug}.md`)), { recursive: true }); writeFileSync(join(this.repo, `${f.slug}.md`), f.content); }
    const paths = files.map(f => `${f.slug}.md`);
    this.git('add', '--', ...paths); this.git('commit', '-qm', message, '--', ...paths);
    const ack = performance.now();
    for (const f of files) this.ledger.record({ kind: 'commit', slug: f.slug, marker: f.marker, touches: ['db', 'file'], start, ack });
  }
  /** #6712 PR 1: a mode-only commit of these notes (same blobs), which the discovery prescreen passes without an import. */
  chmodNotes(indexes: number[], message: string): void {
    const paths = indexes.map(i => `${noteSlug(i)}.md`);
    for (const path of paths) chmodSync(join(this.repo, path), 0o755);
    this.git('add', '--', ...paths); this.git('commit', '-qm', message, '--', ...paths);
  }
  writeNotes(indexes: number[], version: string, message: string, extra: Array<{ slug: string; content: string; marker: string }> = []): void {
    this.commit(message, [...indexes.map(i => ({ slug: noteSlug(i), content: noteText(i, version), marker: noteMarker(i, version) })), ...extra]);
  }
  bigFile(facts: number, timeline: number, version: string) { return { slug: BIG, content: bigPage(facts, timeline, version), marker: `Section 0 (${version})` }; }

  childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
    return keylessBrainEnv(process.env, this.home, {
      DATABASE_URL: this.pooledUrl, GBRAIN_DATABASE_URL: undefined, GBRAIN_DIRECT_DATABASE_URL: this.directUrl,
      GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: SOURCE, GBRAIN_SWEEP: '0', GBRAIN_HOOKS: undefined,
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_SKILL_NAG: '1', GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS: '300',
      GBRAIN_SYNC_NO_DELEGATE: undefined, GBRAIN_TEST_CONVERGENCE_FAULT: undefined,
      ...extra,
    });
  }
  faultArgs(fault?: Fault): { preload: string[]; env: Record<string, string | undefined> } {
    if (!fault) return { preload: [], env: {} };
    return { preload: ['--preload', FAULT_PRELOAD], env: { GBRAIN_TEST_CONVERGENCE_FAULT: JSON.stringify(fault) } };
  }
  spawnCli(args: string[], opts: { fault?: Fault; stdin?: string; timeoutMs?: number } = {}): SyncRun {
    const { preload, env } = this.faultArgs(opts.fault);
    const started = performance.now();
    const proc = Bun.spawn([process.execPath, '--no-env-file', ...preload, join(REPO_ROOT, 'src/cli.ts'), ...args], {
      cwd: REPO_ROOT, env: this.childEnv(env), stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]), stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs ?? SYNC_TIMEOUT_MS);
    const result = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      .then(([out, err, code]) => ({ code, out, err, ms: performance.now() - started }))
      .finally(() => clearTimeout(timer));
    return { proc, result };
  }
  sync(args: string[], fault?: Fault): SyncRun { return this.spawnCli(['sync', '--source', SOURCE, ...args], { fault }); }
  async committedSince(at: string): Promise<number> {
    return (await this.engine!.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests WHERE state='committed' AND completed_at > $1::timestamptz AND operation='submit_job'`, [at]))[0].n;
  }
  async now(): Promise<string> { return (await this.engine!.executeRaw<{ at: string }>('SELECT now()::text AS at'))[0].at; }

  async setup(seed: (b: Brain) => void, config: Record<string, string> = {}): Promise<void> {
    assertSafeE2eDatabaseUrl(directTarget!);
    this.home = mkdtempSync(join(tmpdir(), 'gb-conv-'));
    mkdirSync(join(this.home, '.gbrain'));
    this.database = `gbrain_test_convergence_${randomUUID().replaceAll('-', '')}`;
    this.admin = postgres(directTarget!, { max: 1, prepare: false });
    await this.admin.unsafe(`CREATE DATABASE ${this.database}`);
    const direct = new URL(directTarget!); direct.pathname = `/${this.database}`;
    const pooled = new URL(pooledTarget!); pooled.pathname = `/${this.database}`;
    this.pooledProxy = new LatencyProxy({ host: pooled.hostname, port: Number(pooled.port) || 5432 }, LATENCY_MS / 2);
    this.directProxy = new LatencyProxy({ host: direct.hostname, port: Number(direct.port) || 5432 }, LATENCY_MS / 2);
    await Promise.all([this.pooledProxy.listen(), this.directProxy.listen()]);
    const viaPooled = new URL(pooled); viaPooled.hostname = '127.0.0.1'; viaPooled.port = String(this.pooledProxy.port); viaPooled.searchParams.set('prepare', 'false');
    const viaDirect = new URL(direct); viaDirect.hostname = '127.0.0.1'; viaDirect.port = String(this.directProxy.port);
    this.pooledUrl = viaPooled.toString(); this.directUrl = viaDirect.toString();
    this.engine = new PostgresEngine();
    await withEnv({ GBRAIN_HOME: this.home, GBRAIN_DIRECT_DATABASE_URL: undefined }, async () => {
      await this.engine!.connect({ database_url: direct.toString(), poolSize: 4 });
      await this.engine!.initSchema();
    });
    writeFileSync(join(this.home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: this.pooledUrl, embedding_disabled: true }));
    this.repo = mkdtempSync(join(tmpdir(), 'gb-conv-repo-'));
    this.git('init', '-q'); this.git('config', 'user.email', 'example@example.invalid'); this.git('config', 'user.name', 'Example');
    seed(this);
    await withEnv({ GBRAIN_HOME: this.home }, async () => {
      await this.engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await this.engine!.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [SOURCE, this.repo]);
      await claimWorktree(this.engine!, SOURCE, this.repo);
      for (const [key, value] of Object.entries(config)) await this.engine!.setConfig(key, value);
      await this.engine!.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    });
    this.note(`seed=${SEED} latency=${LATENCY_MS}ms round trip via proxies (pooled -> ${pooled.host}, direct -> ${direct.host}); modes ${this.modes.join(',')}`);
    // Phase 0: a fault-free import, so the oracle is calibrated before any chaos.
    const started = performance.now();
    const baseline = await this.sync(['--no-pull', '--no-delegate', '--json']).result;
    this.elapsed.baseline_import_ms = performance.now() - started;
    if (baseline.code !== 0) throw new Error(`baseline sync exited ${baseline.code}\n${baseline.out}\n${baseline.err}\n${this.context()}`);
    this.calibration = await this.diskDbMismatches(new Set());
    if (existsSync(join(this.repo, `${BIG}.md`))) {
      const rows = await this.childRowProblems();
      this.calibration.push(...rows.problems, ...(rows.timelineDuplicates || rows.timelineStrays ? [`timeline: ${rows.timelineDuplicates} duplicate and ${rows.timelineStrays} stray rows after a fault-free import`] : []));
    }
    this.note(`phase 0: fault-free import in ${(this.elapsed.baseline_import_ms / 1000).toFixed(1)}s; oracle calibration problems: ${this.calibration.length}`);
  }

  /** A fresh resident serve and at most MAX_RECOVERY_RUNS plain syncs, no operator step. */
  async recover(): Promise<void> {
    const started = performance.now();
    const serve = new StdioServe(this);
    await serve.start();
    for (let run = 1; run <= MAX_RECOVERY_RUNS; run++) {
      const r = await this.sync(['--no-pull', '--json']).result;
      const envelope = lastJson(r.out);
      this.recoveryRuns.push({ ...r, envelope });
      this.keepLog(`recovery-${run}-client.log`, `${r.out}\n${r.err}`);
      this.note(`recovery run ${run}: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s outcome=${String(envelope?.outcome ?? envelope?.sync_status ?? envelope?.error ?? 'none')}`);
      if (r.code === 0 && envelope?.outcome === 'synced') break;
    }
    this.elapsed.recovery_ms = performance.now() - started;
    this.keepLog('recovery-serve.log', serve.stderr);
    this.note(`elapsed: ${Object.entries(this.elapsed).map(([k, ms]) => `${k.replace(/_ms$/, '')} ${(ms / 1000).toFixed(1)}s`).join(', ')}; recovery took ${this.recoveryRuns.length} sync run(s)`);
  }

  /**
   * #6841: an accepted write still queued when its writer gave up may commit later, after a write the ledger holds.
   * Once the brain has converged, each one's receipt is read the way the write protocol tells a client to after exit
   * 10 (get_write_request). A committed write is acknowledged then: it may have landed any time since its start, so it
   * is concurrent with every write in that window. Any other state means it never landed and stays out of the ledger.
   */
  async settlePending(receiptState = async (requestId: string) =>
    lastJson((await this.spawnCli(['call', '--source', SOURCE, 'get_write_request', JSON.stringify({ request_id: requestId })]).result).out)?.state): Promise<void> {
    for (const { write, requestId } of this.pending) {
      const state = await receiptState(requestId);
      if (state === 'committed') this.ledger.record({ ...write, ack: performance.now() });
      this.note(`accepted ${write.kind} of ${write.slug} (request ${requestId}) unsettled when its writer stopped: receipt ${String(state ?? 'unreadable')}`);
    }
  }

  async teardown(): Promise<void> {
    for (const serve of this.serves) await serve.stop().catch(() => {});
    try { await this.engine?.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); } catch { /* best effort */ }
    await this.engine?.disconnect().catch(() => {});
    await this.pooledProxy?.close().catch(() => {});
    await this.directProxy?.close().catch(() => {});
    if (this.admin) {
      try { if (this.database) await this.admin.unsafe(`DROP DATABASE IF EXISTS ${this.database} WITH (FORCE)`); } finally { await this.admin.end(); }
    }
    for (const dir of [this.home, this.repo]) if (dir) rmSync(dir, { recursive: true, force: true });
  }

  // ------------------------------------------------------------ oracle reads

  diskPages(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md')) out.set(relative(this.repo, full).replace(/\.md$/, ''), readFileSync(full, 'utf8'));
      }
    };
    walk(this.repo);
    return out;
  }
  async dbPages(): Promise<Map<string, { hash: string | null; body: string }>> {
    const rows = await this.engine!.executeRaw<{ slug: string; content_hash: string | null; body: string }>(
      `SELECT slug, content_hash, coalesce(compiled_truth,'') || E'\\n' || coalesce(timeline,'') AS body FROM pages WHERE source_id=$1 AND deleted_at IS NULL`, [SOURCE]);
    return new Map(rows.map(r => [r.slug, { hash: r.content_hash, body: r.body }]));
  }
  async diskDbMismatches(exclude: Set<string>): Promise<string[]> {
    const disk = this.diskPages(), db = await this.dbPages(), out: string[] = [];
    for (const [slug, content] of disk) {
      if (exclude.has(slug)) continue;
      if (!db.has(slug)) out.push(`${slug}: file exists, no live page`);
      else if (db.get(slug)!.hash !== fileHash(slug, content)) out.push(`${slug}: page content_hash differs from the file`);
    }
    for (const slug of db.keys()) if (!disk.has(slug) && !exclude.has(slug)) out.push(`${slug}: live page, no file`);
    return out;
  }
  async ledgerProblems(): Promise<string[]> {
    const facts = new Set((await this.engine!.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE source_id=$1 AND expired_at IS NULL', [SOURCE])).map(r => r.fact));
    return this.ledger.problems(this.diskPages(), await this.dbPages(), facts);
  }
  async openRequests(): Promise<unknown[]> {
    const open = await this.engine!.executeRaw<{ request_id: string; slug: string; state: string; recovery: boolean; blocked_reason: string | null }>(
      `SELECT request_id::text, slug, state, recovery IS NOT NULL AS recovery, blocked_reason FROM persistence_requests
        WHERE state IN ('queued','running','recovering') OR recovery IS NOT NULL ORDER BY sequence`);
    const worktrees = await this.engine!.executeRaw<{ id: string; state: string }>(`SELECT id::text, state FROM persistence_worktrees WHERE state<>'active'`);
    return [...open.map(r => `open request ${JSON.stringify(r)}`), ...worktrees.map(w => `worktree ${w.id} is ${w.state}`)];
  }
  async unexplainedTerminal(exclude: Set<string>): Promise<string[]> {
    const rows = await this.engine!.executeRaw<{ request_id: string; slug: string; state: string; error_code: string | null; operation: string }>(
      `SELECT request_id::text, slug, state, error_code, operation FROM persistence_requests WHERE state IN ('conflict','failed','cancelled') ORDER BY sequence`);
    const disk = this.diskPages(), db = await this.dbPages();
    this.note(`terminal non-committed requests: ${rows.length} (${[...new Set(rows.map(r => `${r.state}:${r.error_code}`))].join(', ') || 'none'})`);
    return rows.filter(row => {
      const content = disk.get(row.slug);
      const superseded = exclude.has(row.slug) || (content !== undefined && db.get(row.slug)?.hash === fileHash(row.slug, content));
      return !superseded && !(row.error_code && row.error_code in CODES);
    }).map(row => `unexplained ${row.state} request ${row.request_id} (${row.slug}, ${row.error_code ?? 'no code'})`);
  }
  async cursorProblems(): Promise<string[]> {
    const [source] = await this.engine!.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [SOURCE]);
    const head = this.git('rev-parse', 'HEAD');
    return source.last_commit === head ? [] : [`sources.last_commit ${source.last_commit} is not HEAD ${head}`];
  }
  async status(detail = true): Promise<Record<string, unknown> | null> {
    const r = await this.spawnCli(['sync', 'status', '--source', SOURCE, '--json', ...(detail ? ['--detail'] : [])]).result;
    this.keepLog(detail ? 'status.json' : 'status-fast.json', `${r.out}\n${r.err}`);
    return lastJson(r.out);
  }
  recoveryProblems(): string[] {
    const last = this.recoveryRuns.at(-1);
    return last?.code === 0 && last.envelope?.outcome === 'synced' ? []
      : [`no plain sync succeeded within ${MAX_RECOVERY_RUNS} runs: ${this.recoveryRuns.map(r => `exit ${r.code} outcome ${String(r.envelope?.outcome ?? r.envelope?.error ?? 'none')}`).join('; ')}`];
  }
  /**
   * The large page's child rows against its file. Facts are keyed by fence row, so
   * loss, duplication and strays are all problems. Timeline rows are judged for
   * loss only; duplicate and stray timeline rows come back as a measured count,
   * because derived timeline rows are never pruned (a known defect outside #6650).
   */
  async childRowProblems(): Promise<{ problems: string[]; timelineDuplicates: number; timelineStrays: number }> {
    const content = this.diskPages().get(BIG);
    if (!content) return { problems: [`${BIG}: no file`], timelineDuplicates: 0, timelineStrays: 0 };
    const out: string[] = [];
    const expectedTimeline = [...content.matchAll(/^- \*\*(\d{4}-\d{2}-\d{2})\*\* \| (.+)$/gm)].map(m => `${m[1]}|${m[2]}`);
    const timeline = await this.engine!.executeRaw<{ key: string; n: number }>(
      `SELECT t.date::text || '|' || t.summary AS key, count(*)::int AS n FROM timeline_entries t JOIN pages p ON p.id=t.page_id
        WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL AND t.event_page_id IS NULL GROUP BY 1`, [SOURCE, BIG]);
    const have = new Map(timeline.map(r => [r.key, r.n]));
    const lostTimeline = expectedTimeline.filter(k => !have.has(k));
    const dupTimeline = timeline.filter(r => r.n > 1);
    const extraTimeline = timeline.filter(r => !expectedTimeline.includes(r.key));
    if (lostTimeline.length) out.push(`timeline: ${lostTimeline.length} of ${expectedTimeline.length} file entries missing (first: ${lostTimeline[0]})`);
    const expectedFacts = parseFactsFence(content).facts.map(f => `${f.rowNum}|${f.claim}`);
    const facts = await this.engine!.executeRaw<{ key: string; n: number }>(
      `SELECT row_num::text || '|' || fact AS key, count(*)::int AS n FROM facts
        WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL GROUP BY 1`, [SOURCE, BIG]);
    const haveFacts = new Map(facts.map(r => [r.key, r.n]));
    const lostFacts = expectedFacts.filter(k => !haveFacts.has(k));
    const dupFacts = facts.filter(r => r.n > 1);
    const extraFacts = facts.filter(r => !expectedFacts.includes(r.key));
    if (lostFacts.length) out.push(`facts: ${lostFacts.length} of ${expectedFacts.length} fence rows missing (first: ${lostFacts[0]})`);
    if (dupFacts.length) out.push(`facts: ${dupFacts.length} rows duplicated (first: ${dupFacts[0].key} x${dupFacts[0].n})`);
    if (extraFacts.length) out.push(`facts: ${extraFacts.length} rows not in the fence (first: ${extraFacts[0].key})`);
    return { problems: out, timelineDuplicates: dupTimeline.reduce((n, r) => n + r.n - 1, 0), timelineStrays: extraTimeline.length };
  }
}

function fileHash(slug: string, content: string): string {
  const parsed = parseMarkdown(content, `${slug}.md`);
  return contentHash({ title: parsed.title, type: parsed.type, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter, tags: [...parsed.tags].sort() });
}

/** One stdio MCP session against a spawned `gbrain serve`; the serve is the host's resident persistence owner. */
class StdioServe {
  readonly child: ChildProcess;
  stderr = '';
  exited: Promise<number | null>;
  private nextId = 1;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();
  private buf = '';
  constructor(private brain: Brain, fault?: Fault) {
    const { preload, env } = brain.faultArgs(fault);
    this.child = spawn(process.execPath, ['--no-env-file', ...preload, join(REPO_ROOT, 'src/cli.ts'), 'serve'], { cwd: REPO_ROOT, env: brain.childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(done => this.child.once('exit', code => done(code)));
    this.child.stderr!.on('data', (d: Buffer) => { this.stderr += d.toString('utf8'); });
    this.child.stdin!.on('error', () => {});
    this.child.stdout!.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, idx).trim(); this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg.id as number | undefined;
          if (id !== undefined && this.pending.has(id)) { this.pending.get(id)!(msg); this.pending.delete(id); }
        } catch { /* serve chatter */ }
      }
    });
    brain.serves.push(this);
  }
  get pid(): number { return this.child.pid!; }
  get alive(): boolean { return this.child.exitCode === null && this.child.signalCode === null; }
  request(method: string, params: Record<string, unknown>, timeoutMs = 240_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((done, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, msg => { clearTimeout(t); done(msg); });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async start(): Promise<void> {
    await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'convergence', version: '1' } });
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await until(async () => (await this.brain.engine!.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM persistence_consumers WHERE pid=$1 AND kind='serve' AND renewed_at > now() - interval '30 seconds'`, [this.pid]))[0].n > 0,
      `serve ${this.pid} heartbeat`, 120_000);
  }
  async stop(): Promise<void> {
    if (!this.alive) return;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 10_000);
    await this.exited; clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- the writers of mode (c)

/**
 * A writer call that retries an unsettled attempt (exit 10, a lost owner) with the same request id and a terminal refusal with a new one.
 * When the attempts or the chaos run out on an unsettled attempt, the request it names may still commit, so it comes back `pending`.
 */
async function acknowledged(b: Brain, label: string, call: (requestId: string) => SyncRun, stop: () => boolean): Promise<{ start: number; ack: number } | { pending: string } | null> {
  let requestId = randomUUID();
  let unsettled = false;
  for (let attempt = 1; attempt <= 20 && !stop(); attempt++) {
    const start = performance.now();
    const r = await call(requestId).result;
    b.keepLog(`writer-${label.replaceAll('/', '_')}-${attempt}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
    if (r.code === 0) return { start, ack: performance.now() };
    const terminal = /\((conflict|failed|cancelled)\)/.test(r.err);
    b.note(`writer ${label} attempt ${attempt} exit ${r.code}${terminal ? ' (terminal; next attempt uses a new request id)' : ''}: ${r.err.trim().split('\n').slice(-1)[0] ?? ''}`);
    unsettled = !terminal;
    if (terminal) requestId = randomUUID();
    await Bun.sleep(3000);
  }
  return unsettled ? { pending: requestId } : null;
}
const outcome = (ok: { ack: number } | { pending: string } | null) => !ok ? 'unacknowledged' : 'pending' in ok ? `pending ${ok.pending}` : 'ok';
/** Rewrites notes through the coordinator (`gbrain put`), remembers facts on the entity page and runs the managed timeline maintenance job until `stop`. */
async function runWriters(b: Brain, putTargets: string[], stop: () => boolean): Promise<string[]> {
  const results: string[] = [];
  const put = async () => {
    for (const [k, slug] of putTargets.entries()) {
      if (stop()) break;
      const marker = `Writer rewrite ${k} of ${slug} (${randomUUID().slice(0, 8)})`;
      const content = `---\ntype: concept\ntitle: ${slug.split('/')[1]} rewritten\n---\n\n${marker} through the coordinator.\n`;
      // The start is taken before the first attempt: a retried put may have committed on an earlier attempt.
      const start = performance.now();
      const ok = await acknowledged(b, slug, requestId => b.spawnCli(['put', slug, '--source-id', SOURCE, '--force', '--request-id', requestId, '--wait-ms', '10000'], { stdin: content }), stop);
      const write = { kind: 'put', slug, marker, touches: ['db', 'file'], start } satisfies Omit<Ack, 'ack'>;
      if (ok && 'ack' in ok) b.ledger.record({ ...write, ack: ok.ack });
      if (ok && 'pending' in ok) b.pending.push({ write, requestId: ok.pending });
      results.push(`put ${slug}=${outcome(ok)}`);
      await Bun.sleep(b.between(200, 1500));
    }
  };
  const remember = async () => {
    for (let k = 0; !stop(); k++) {
      const fact = `Alice Example noted item ${k} (${randomUUID().slice(0, 8)}) with acme-example.`;
      const start = performance.now();
      const ok = await acknowledged(b, `remember-${k}`, requestId => b.spawnCli(['call', '--source', SOURCE, 'remember',
        JSON.stringify({ fact, entity: ENTITY, infer_entity: false, provenance: 'convergence harness', request_id: requestId })]), stop);
      const write = { kind: 'remember', slug: ENTITY, marker: fact, touches: 'fact', start } satisfies Omit<Ack, 'ack'>;
      if (ok && 'ack' in ok) b.ledger.record({ ...write, ack: ok.ack });
      if (ok && 'pending' in ok) b.pending.push({ write, requestId: ok.pending });
      results.push(`remember ${k}=${outcome(ok)}`);
      await Bun.sleep(b.between(1000, 4000));
    }
  };
  const maintenance = async () => {
    for (let k = 0; !stop(); k++) {
      const start = performance.now();
      const r = await b.spawnCli(['extract', 'timeline', '--source', 'db']).result;
      b.keepLog(`maintenance-${k}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
      if (r.code === 0) b.ledger.record({ kind: 'maintenance', slug: '*', marker: null, touches: ['db'], start, ack: performance.now() });
      results.push(`maintenance ${k}=exit ${r.code}`);
      await Bun.sleep(b.between(5000, 10000));
    }
  };
  await Promise.all([put(), remember(), maintenance()]);
  return results;
}

// ---------------------------------------------------------------- the shared oracle

interface EndState { exclude?: Set<string>; status?: StatusExpectation; bigPage?: boolean }
/** The oracle tests every scenario ends with; `end()` is read when the tests run (after the scenario's beforeAll). */
function oracleTests(b: Brain, end: () => EndState): void {
  test('the oracle is calibrated: a fault-free import satisfies it', () => b.verdict(b.calibration));
  test('every planned fault fired, so the chaos actually happened', () => b.verdict(Object.entries(b.fired).filter(([, at]) => at === null).map(([fault]) => `${fault} did not fire`)));
  test(as('wedge', `a plain sync succeeds within ${MAX_RECOVERY_RUNS} runs after the chaos, with no operator step`), () => b.verdict(b.recoveryProblems()));
  test(as('projection_drift', 'disk == database for every page the end state does not name'), async () => b.verdict(await b.diskDbMismatches(end().exclude ?? new Set())));
  test(as('wedge', 'no request blocks the checkpoint or a root'), async () => b.verdict((await b.openRequests()).map(String)));
  test(as('untyped_error', 'every non-committed terminal request is superseded or carries a registered error code'), async () => b.verdict(await b.unexplainedTerminal(end().exclude ?? new Set())));
  test(as('wedge', 'the cursor reached HEAD'), async () => b.verdict(await b.cursorProblems()));
  test(as('lost_write', 'every acknowledged write survives or is causally superseded by a later acknowledged write'), async () => {
    b.note(`ledger: ${b.ledger.acks.length} acknowledged writes (${[...new Set(b.ledger.acks.map(a => a.kind))].map(kind => `${kind} ${b.ledger.acks.filter(a => a.kind === kind).length}`).join(', ')})`);
    b.verdict(await b.ledgerProblems());
  });
  test(as('wedge', 'sync status --json reports the converged state with every field present'), async () => b.verdict(statusProblems(await b.status(), end().status)));
  test(as('wedge', 'plain sync status --json names every heavy read it skipped instead of reading as all-clear'), async () => b.verdict(fastStatusProblems(await b.status(false))));
  if (end().bigPage !== false) test(as('lost_write', 'the large page keeps every fence fact exactly once and loses no timeline entry'), async () => {
    const { problems, timelineDuplicates, timelineStrays } = await b.childRowProblems();
    b.note(`large page timeline (measured, not asserted): ${timelineDuplicates} duplicate rows, ${timelineStrays} rows not in the file`);
    b.verdict(problems);
  });
}

/** A describe that runs when any of its modes runs; skipped (with every skip reason in its title) otherwise. */
function scenario(modes: Mode[], title: string, body: () => void): void {
  const active = enabled && modes.some(runs);
  const reasons = [...new Set(modes.map(m => MODES[m].skip).filter(Boolean))];
  (active ? describe : describe.skip)(`${title} [${modes.map(m => `(${m})`).join(' ')}]${!active && reasons.length ? ` (skipped until ${reasons.join('; ')})` : ''}`, body);
}

// ---------------------------------------------------------------- always-on calibration

// Runs on every invocation, harness enabled or not: the calibration the chaos run's verdicts rest on.
describe('convergence harness calibration (#6650 L0, #6712 PR 0)', () => {
  test('the owner-kill stall bound is below the default publication lease it exists to catch', () => {
    expect(OWNER_KILL_STALL_BOUND_S * 1000).toBeLessThan(publicationLeaseMs(PUBLICATION_CEILING_DEFAULT_MS));
  });
  test('a seed reproduces its fault plan and writer targets', () => {
    const draw = (seed: number) => { const next = prng(seed); return Array.from({ length: 16 }, next); };
    expect(draw(SEED)).toEqual(draw(SEED));
    expect(draw(SEED)).not.toEqual(draw(SEED + 1));
  });
  const converged = (): Record<string, unknown> => ({ source_id: SOURCE, run_id: 'r', cursor: { index: 3, total: 3, pinned_target: 'abc', last_advance_at: null, done: true },
    committed_last_10m: 3, live_job_id: null, rate_pages_per_min: null, eta_seconds: null, holds: [], last_error: null, needs_human: false, resume_argv: ['--source', SOURCE],
    checkpoint_blockers: [], cursors: [], terminal_failures: { status: 'ok', window_days: 7, active_blockers: [], unresolved: { rows: 0 } }, next: null });
  test('the status oracle accepts a converged status, with the finished cursor done or retired', () => {
    expect(statusProblems(converged())).toEqual([]);
    expect(statusProblems({ ...converged(), cursor: null, run_id: null })).toEqual([]);
  });
  test('the fast-status oracle accepts named skipped reads and fails a skipped read that looks read', () => {
    const notRead = { status: 'not_read', fix: { argv: ['gbrain', 'sync', 'status', '--source', SOURCE, '--detail', '--json'] } };
    const fast = { checkpoint_blockers_read: notRead, cursors_read: notRead, terminal_failures_read: notRead };
    expect(fastStatusProblems(fast)).toEqual([]);
    expect(fastStatusProblems({ ...fast, terminal_failures_read: { status: 'read' } })).toEqual(['sync status --json: terminal_failures_read is {"status":"read"}, expected not_read with a --detail fix']);
    expect(fastStatusProblems({ ...fast, cursors_read: undefined })).toHaveLength(1);
  });
  // Forced probe: every field the oracle requires fails it when missing, so a renderer that drops one cannot pass.
  test('the status oracle fails when any required field is missing or not an array', () => {
    for (const field of STATUS_FIELDS) {
      const status = converged(); delete status[field];
      expect(statusProblems(status)).toEqual([`sync status --json: field ${field} missing`]);
    }
    expect(statusProblems({ ...converged(), cursor: { index: 2, total: 3, done: false } })).toContain('sync status --json: cursor not done ({"index":2,"total":3,"done":false})');
    expect(statusProblems({ ...converged(), cursors: {} })).toContain('sync status --json: cursors is not an array');
    expect(statusProblems({ ...converged(), checkpoint_blockers: null })).toContain('sync status --json: checkpoint_blockers is not an array');
    expect(statusProblems({ ...converged(), checkpoint_blockers: [{ request_id: 'x' }] })).toContain('sync status --json: 1 checkpoint blocker(s)');
    expect(statusProblems({ ...converged(), terminal_failures: { status: 'unknown', reason: 'timeout' } })).toContain('sync status --json: terminal_failures.status is unknown');
  });
  test('the ledger accepts the latest acknowledged write and any of two concurrent ones, and flags a lost one', () => {
    const ledger = new Ledger();
    ledger.record({ kind: 'commit', slug: 'n', marker: 'v1', touches: ['db', 'file'], start: 0, ack: 1 });
    ledger.record({ kind: 'put', slug: 'n', marker: 'v2', touches: ['db', 'file'], start: 2, ack: 5 });
    ledger.record({ kind: 'commit', slug: 'n', marker: 'v3', touches: ['db', 'file'], start: 4, ack: 6 });
    ledger.record({ kind: 'remember', slug: 'e', marker: 'fact-1', touches: 'fact', start: 0, ack: 1 });
    const page = (body: string) => new Map([['n', { body }]]);
    expect(ledger.problems(new Map([['n', 'v2']]), page('v3'), new Set(['fact-1']))).toEqual([]);
    expect(ledger.problems(new Map([['n', 'v1']]), page('v1'), new Set(['fact-1']))).toHaveLength(2);
    expect(ledger.problems(new Map([['n', 'v2']]), page('v2'), new Set())).toEqual(['fact on e: lost acknowledged remember "fact-1"']);
  });
  // Forced probe (#6841): a put the brain accepted but had not settled when its writer gave up committed after a later
  // harness commit; dropped from the ledger, its bytes read as the commit's lost write. Its receipt decides it now.
  test('an accepted write that settles after its writer stopped counts by its receipt', async () => {
    const b = new Brain('pending-probe', ['c']);
    const pending = { code: 10, out: '', err: 'Exit 10: accepted, not yet committed.', ms: 0 };
    let attempts = 0;
    const ok = await acknowledged(b, 'notes/n', () => ({ proc: undefined as never, result: Promise.resolve(pending) }), () => attempts++ > 0);
    expect(ok).toEqual({ pending: expect.any(String) });
    const put = { kind: 'put', slug: 'n', marker: 'put-bytes', touches: ['db', 'file'], start: 0 } satisfies Omit<Ack, 'ack'>;
    b.ledger.record({ kind: 'commit', slug: 'n', marker: 'commit-bytes', touches: ['db', 'file'], start: 1, ack: 2 });
    b.pending.push({ write: put, requestId: (ok as { pending: string }).pending });
    const final = (body: string) => b.ledger.problems(new Map([['n', body]]), new Map([['n', { body }]]), new Set());
    await b.settlePending(async () => 'committed');
    expect(final('put-bytes')).toEqual([]);
    expect(final('commit-bytes')).toEqual([]);
    const refused = new Brain('pending-probe', ['c']);
    refused.ledger.record({ kind: 'commit', slug: 'n', marker: 'commit-bytes', touches: ['db', 'file'], start: 1, ack: 2 });
    refused.pending.push({ write: put, requestId: 'r' });
    await refused.settlePending(async () => 'conflict');
    expect(refused.ledger.problems(new Map([['n', 'put-bytes']]), new Map([['n', { body: 'put-bytes' }]]), new Set())).toHaveLength(2);
  });
  // Forced probe: a harness commit leaves another writer's uncommitted bytes alone (a swept commit raced `remember`'s write-through into a concurrent_write hold).
  test('a harness commit commits only the files it wrote', () => {
    const b = new Brain('commit-probe', ['a']);
    b.repo = mkdtempSync(join(tmpdir(), 'gb-conv-probe-'));
    try {
      b.git('init', '-q'); b.git('config', 'user.email', 'example@example.invalid'); b.git('config', 'user.name', 'Example');
      b.commit('fixture', [{ slug: noteSlug(0), content: 'v0\n', marker: 'v0' }, { slug: ENTITY, content: 'e0\n', marker: 'e0' }]);
      writeFileSync(join(b.repo, `${ENTITY}.md`), 'in-flight write-through\n');
      writeFileSync(join(b.repo, 'stray.md'), 'untracked\n');
      b.commit('round one', [{ slug: noteSlug(0), content: 'v1\n', marker: 'v1' }]);
      expect(b.git('show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual([`${noteSlug(0)}.md`]);
      expect(b.git('diff', '--name-only')).toBe(`${ENTITY}.md`);
      expect(b.git('ls-files', '--others', '--exclude-standard')).toBe('stray.md');
    } finally { rmSync(b.repo, { recursive: true, force: true }); }
  });
  test('every mode runs: #6712 PR 2 turned on the last skipped one (f, a pooler drop mid-bulk)', () => {
    for (const mode of ['a', 'b', 'c', 'c-db', 'd', 'e', 'f', 'g', 'lease', 'knock-on', 'systemic'] as const) expect(MODES[mode].skip).toBeNull();
  });
});

// ---------------------------------------------------------------- (a) (b) (c): the kill loop under concurrent writers

scenario(['a', 'b', 'c'], 'managed sync converges after a seeded kill loop of clients and serves under concurrent writers', () => {
  const b = new Brain('kill-loop', (['a', 'b', 'c'] as Mode[]).filter(runs));
  const syncErrs: Record<string, string> = {};
  const ownerKillStalls: Record<string, number> = {};
  const afterClientKill: string[] = [];
  beforeAll(async () => {
    await b.setup(brain => brain.commit('fixture', [
      ...Array.from({ length: NOTES }, (_, i) => ({ slug: noteSlug(i), content: noteText(i, 'Initial'), marker: noteMarker(i, 'Initial') })),
      brain.bigFile(120, 400, 'v0'), { slug: ENTITY, content: entityText, marker: 'Alice Example works with acme-example.' },
    ]));
    // The fault plan, drawn from the seed before anything runs: one kill per round.
    const kinds = [runs('a') && 'client', runs('b') && 'serve', runs('a') && runs('b') && 'serve+client'].filter(Boolean) as Array<'client' | 'serve' | 'serve+client'>;
    const perRound = Math.min(100, Math.max(10, Math.round(NOTES * 0.1)));
    // Victims and fault points cycle from seeded offsets, so six kills reach each victim kind twice and KILL_POINTS.length kills reach every point.
    const offset = b.between(0, 2), pointOffset = b.between(0, KILL_POINTS.length - 1);
    const plan = Array.from({ length: kinds.length ? KILLS : 0 }, (_, k) => {
      const kind = kinds[(k + offset) % kinds.length];
      const { point, per } = KILL_POINTS[(k + pointOffset) % KILL_POINTS.length];
      const nth = per === 'page' ? b.between(2, Math.floor(perRound * 0.6)) : per === 'group' || per === 'held' || per === 'deferred' ? 1 : b.between(1, 2);
      return { round: k + 1, kind, point, nth, operation: per === 'page' || point === 'lane:applied' ? 'submit_job' : undefined, primed: per === 'held' || per === 'deferred' };
    });
    b.plan = plan.map(p => `round ${p.round} ${p.kind} ${p.point} #${p.nth}`);
    const putTargets = runs('c') ? [...new Set(Array.from({ length: 40 }, () => b.between(0, NOTES - 1)))].slice(0, Math.round(NOTES * 0.05)).map(noteSlug) : [];
    b.note(`plan: ${b.plan.join('; ') || 'no kills'}; ${perRound} notes per round; writers ${runs('c') ? `put ${putTargets.length} notes, remember, maintenance` : 'off'}`);
    let chaosDone = false;
    const writers: Promise<string[]> = runs('c') ? runWriters(b, putTargets, () => chaosDone) : Promise.resolve([]);
    const chaosStarted = performance.now();
    for (const p of plan) {
      const started = performance.now();
      const tag = `round-${p.round}`;
      const first = (p.round * perRound) % NOTES;
      const indexes = Array.from({ length: perRound }, (_, i) => (first + i) % NOTES);
      if (p.point === 'sync:prescreened') b.chmodNotes(Array.from({ length: 3 }, (_, i) => (first + perRound + 1 + 2 * i) % NOTES), `round ${p.round} modes`);
      const edited = p.primed ? indexes[Math.floor(perRound / 2)]! : null;
      const fault: Fault = { point: p.point, nth: p.nth, marker: b.marker(tag), operation: p.operation,
        ...(edited !== null ? { prime: { point: 'sync:after_freeze', nth: 1, path: `${noteSlug(edited)}.md`,
          edit: { file: join(b.repo, `${noteSlug(edited)}.md`), content: noteText(edited, `Round ${p.round} edit`) } } } : {}) };
      b.writeNotes(indexes, `Round ${p.round}`, `round ${p.round}`, p.round % 3 === 1 ? [b.bigFile(120 + 20 * p.round, 400 + 40 * p.round, `v${p.round}`)] : []);
      let line: string;
      if (p.kind === 'client') {
        const r = await b.sync(['--no-pull', '--no-delegate', '--json'], fault).result;
        syncErrs[tag] = r.err; b.keepLog(`${tag}-client.log`, `${r.out}\n${r.err}`);
        line = `client exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s`;
      } else {
        const serve = new StdioServe(b, fault);
        await serve.start();
        const client = b.sync(['--no-pull', '--json']);
        await Promise.race([serve.exited, client.result]);
        if (p.kind === 'serve+client' && !serve.alive) { client.proc.kill('SIGKILL'); b.killedPids.add(client.proc.pid); }
        const r = await client.result;
        syncErrs[tag] = r.err; ownerKillStalls[`${tag} (${p.kind})`] = worstStall(r.err);
        b.keepLog(`${tag}-client.log`, `${r.out}\n${r.err}`); b.keepLog(`${tag}-serve.log`, serve.stderr);
        line = `serve ${serve.alive ? 'survived' : 'killed'}; client exit ${r.code}${client.proc.signalCode ? ` (${client.proc.signalCode})` : ''} in ${(r.ms / 1000).toFixed(1)}s, worst stall ${worstStall(r.err)}s`;
        if (plan[p.round - 2]?.kind === 'client') afterClientKill.push(tag);
        await serve.stop();
      }
      if (edited !== null) {
        const editStart = performance.now();
        b.git('add', '--', `${noteSlug(edited)}.md`); b.git('commit', '-qm', `round ${p.round}: the editor commits`, '--', `${noteSlug(edited)}.md`);
        b.ledger.record({ kind: 'commit', slug: noteSlug(edited), marker: noteMarker(edited, `Round ${p.round} edit`), touches: ['db', 'file'], start: editStart, ack: performance.now() });
      }
      const fired = b.recordFault(tag, `round ${p.round} ${p.kind} ${p.point} #${p.nth}`);
      b.note(`round ${p.round} (${p.kind}): ${fired ? `fault fired ${fired}` : 'no fault fired'}; ${line}`);
      b.elapsed[`${tag}_ms`] = performance.now() - started;
    }
    chaosDone = true;
    const results = await writers;
    b.elapsed.chaos_ms = performance.now() - chaosStarted;
    b.note(`writers: ${results.join(' ')}`);
    await b.recover();
    await b.settlePending();
    for (const [i, run] of b.recoveryRuns.entries()) { syncErrs[`recovery ${i + 1}`] = run.err; ownerKillStalls[`recovery run ${i + 1}`] = worstStall(run.err); }
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);

  oracleTests(b, () => ({}));
  test(as('wedge', "a killed client's stale heartbeat never keeps ownership from a live serve"), () => {
    const deadOwners = Object.entries(syncErrs).flatMap(([run, err]) => [...err.matchAll(/the live write owner on this host is a (\w+) process \(PID (\d+)\)/g)]
      .filter(m => b.killedPids.has(Number(m[2]))).map(m => `${run}: ${m[0]}`));
    const notDelegated = afterClientKill.filter(tag => !/running the managed catch-up inside it as this CLI's writer/.test(syncErrs[tag] ?? ''))
      .map(tag => `${tag}: the client after a client kill did not delegate to the live serve`);
    b.verdict([...deadOwners, ...notDelegated]);
  });
  test(as('wedge', 'recovery after an owner kill does not wait out the publication lease'), () => {
    b.note(`worst stall after an owner kill (bound ${OWNER_KILL_STALL_BOUND_S}s): ${Object.entries(ownerKillStalls).map(([k, v]) => `${k} ${v}s`).join(', ')}`);
    b.verdict(Object.entries(ownerKillStalls).filter(([, stall]) => stall > OWNER_KILL_STALL_BOUND_S).map(([k, v]) => `${k} stalled ${v}s`));
  });
});

// ---------------------------------------------------------------- (c-db): a DB-only competitor

scenario(['c-db'], 'a DB-only write racing a file change ends as a named hold with both versions kept', () => {
  const b = new Brain('db-only', ['c-db']);
  const notes = 20;
  const raced = noteSlug(3), quiet = noteSlug(11);
  beforeAll(async () => {
    // A DB-only write needs write-through off (the #6194 contract): the coordinator then publishes page writes to the database only.
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'), { 'sync.write_through': 'false' });
    const indexes = Array.from({ length: 8 }, (_, i) => i);
    b.writeNotes(indexes, 'Git edit', 'git edit');
    const tag = 'stall', release = join(b.home, 'release-stall');
    b.plan = [`stall at sync:after_freeze for ${raced}.md; DB-only put of ${raced} and ${quiet}`];
    const run = b.sync(['--no-pull', '--no-delegate', '--json'], { point: 'sync:after_freeze', nth: 1, path: `${raced}.md`, marker: b.marker(tag), action: 'stall', release });
    await until(() => existsSync(b.marker(tag)), 'the run to freeze the raced entry', SYNC_TIMEOUT_MS);
    for (const slug of [raced, quiet]) {
      const marker = `Database-only edit of ${slug} (${randomUUID().slice(0, 8)})`;
      const start = performance.now();
      const r = await b.spawnCli(['put', slug, '--source-id', SOURCE, '--force', '--wait-ms', '30000'], { stdin: `---\ntype: concept\ntitle: ${slug} database edit\n---\n\n${marker}.\n` }).result;
      b.keepLog(`db-only-${slug.replace('/', '_')}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
      if (r.code !== 0) throw new Error(`the DB-only put of ${slug} exited ${r.code}: ${r.err}\n${b.context()}`);
      b.ledger.record({ kind: 'db_only', slug, marker, touches: ['db'], start, ack: performance.now() });
    }
    writeFileSync(release, '');
    const r = await run.result;
    b.keepLog('raced-run.log', `${r.out}\n${r.err}`);
    b.recordFault(tag, b.plan[0]);
    b.note(`raced run: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s`);
    await b.recover();
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  oracleTests(b, () => ({ exclude: new Set([raced, quiet]), bigPage: false,
    status: { holds: [{ code: 'concurrent_write', path: `${raced}.md` }], needsHuman: true } }));
  test(as('lost_write', 'the held file keeps its committed bytes and the page keeps the DB-only write'), () => {
    const disk = b.diskPages();
    b.verdict([
      ...(disk.get(raced)?.includes(noteMarker(3, 'Git edit')) ? [] : [`${raced}: the file lost its committed Git edit`]),
      ...(disk.get(quiet)?.includes(noteMarker(11, 'Initial')) ? [] : [`${quiet}: the file changed although only the database was written`]),
    ]);
  });
});

// ---------------------------------------------------------------- (d): out-of-band git mv / git rm and uncommitted deletions

scenario(['d'], 'committed git mv/git rm mid-run converge; an uncommitted deletion is a ghost with the repair ghost-pages exit', () => {
  const b = new Brain('git-moves', ['d']);
  const notes = Math.min(NOTES, 200);
  const share = Math.max(2, Math.round(notes * 0.01));
  const moved: string[] = [], removed: string[] = [], ghosts: string[] = [];
  let ghostScan: Record<string, unknown> | null = null;
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
    const indexes = Array.from({ length: 40 }, (_, i) => i);
    b.writeNotes(indexes, 'Round one', 'round one');
    const others = Array.from({ length: notes - 40 }, (_, i) => i + 40).sort(() => b.rand() - 0.5);
    moved.push(...others.slice(0, share).map(noteSlug)); removed.push(...others.slice(share, 2 * share).map(noteSlug)); ghosts.push(...others.slice(2 * share, 3 * share).map(noteSlug));
    const tag = 'stall', release = join(b.home, 'release-stall');
    b.plan = [`stall at sync:after_freeze #5; git mv ${moved.join(',')}; git rm ${removed.join(',')}; unlink (uncommitted) ${ghosts.join(',')}`];
    const run = b.sync(['--no-pull', '--no-delegate', '--json'], { point: 'sync:after_freeze', nth: 5, marker: b.marker(tag), action: 'stall', release });
    await until(() => existsSync(b.marker(tag)), 'the run to freeze its fifth entry', SYNC_TIMEOUT_MS);
    const start = performance.now();
    mkdirSync(join(b.repo, 'moved'), { recursive: true });
    for (const slug of moved) b.git('mv', `${slug}.md`, `moved/${slug.split('/')[1]}.md`);
    for (const slug of removed) b.git('rm', '-q', `${slug}.md`);
    b.git('commit', '-qm', 'out-of-band moves and removals');
    for (const slug of ghosts) rmSync(join(b.repo, `${slug}.md`));
    const ack = performance.now();
    for (const slug of moved) {
      const i = Number(slug.split('-')[1]);
      b.ledger.record({ kind: 'git_mv', slug, marker: null, touches: ['db', 'file'], start, ack });
      b.ledger.record({ kind: 'git_mv', slug: `moved/${slug.split('/')[1]}`, marker: noteMarker(i, 'Initial'), touches: ['db', 'file'], start, ack });
    }
    for (const slug of removed) b.ledger.record({ kind: 'git_rm', slug, marker: null, touches: ['db', 'file'], start, ack });
    for (const slug of ghosts) b.ledger.record({ kind: 'unlink', slug, marker: null, touches: ['file'], start, ack });
    writeFileSync(release, '');
    const r = await run.result;
    b.keepLog('stalled-run.log', `${r.out}\n${r.err}`);
    b.recordFault(tag, b.plan[0]);
    b.note(`stalled run: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s`);
    await b.recover();
    const scan = await b.spawnCli(['pages', 'ghosts', '--source', SOURCE, '--json']).result;
    b.keepLog('ghosts.json', `${scan.out}\n${scan.err}`);
    ghostScan = lastJson(scan.out);
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  oracleTests(b, () => ({ exclude: new Set(ghosts), bigPage: false }));
  test(as('projection_drift', 'each uncommitted deletion is reported as a ghost page whose exit is repair ghost-pages'), () => {
    const listed = ((ghostScan?.ghosts ?? []) as Array<{ slug: string }>).map(g => g.slug).sort();
    const next = JSON.stringify(ghostScan?.next ?? []);
    b.verdict([
      ...(JSON.stringify(listed) === JSON.stringify([...ghosts].sort()) ? [] : [`pages ghosts lists [${listed.join(', ')}], expected [${[...ghosts].sort().join(', ')}]`]),
      ...(next.includes(`gbrain repair ghost-pages --source ${SOURCE}`) ? [] : [`pages ghosts next does not name gbrain repair ghost-pages: ${next}`]),
    ]);
  });
});

// ---------------------------------------------------------------- (e): a deterministic mid-run edit

scenario(['e'], 'an edit after freezeEntry is held worktree_dirty, then converges strictly once committed', () => {
  const b = new Brain('mid-run-edit', ['e']);
  const notes = Math.min(NOTES, 60);
  const target = 7;
  let raced: Record<string, unknown> | null = null;
  let heldAfterRun: Array<{ code: string; path: string }> = [];
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
    b.writeNotes(Array.from({ length: 20 }, (_, i) => i), 'Round one', 'round one');
    const tag = 'edit', file = join(b.repo, `${noteSlug(target)}.md`);
    b.plan = [`edit ${noteSlug(target)}.md at sync:after_freeze #1 (uncommitted)`];
    const start = performance.now();
    const r = await b.sync(['--no-pull', '--no-delegate', '--json'], { point: 'sync:after_freeze', nth: 1, path: `${noteSlug(target)}.md`, marker: b.marker(tag), action: 'edit',
      edit: { file, content: noteText(target, 'Uncommitted edit') } }).result;
    b.keepLog('edited-run.log', `${r.out}\n${r.err}`);
    b.recordFault(tag, b.plan[0]);
    raced = lastJson(r.out);
    heldAfterRun = ((await b.status())?.holds ?? []) as Array<{ code: string; path: string }>;
    b.note(`edited run: exit ${r.code}; holds ${JSON.stringify(heldAfterRun.map(h => `${h.code}:${h.path}`))}`);
    b.git('add', '--', `${noteSlug(target)}.md`); b.git('commit', '-qm', 'the editor commits', '--', `${noteSlug(target)}.md`);
    b.ledger.record({ kind: 'commit', slug: noteSlug(target), marker: noteMarker(target, 'Uncommitted edit'), touches: ['db', 'file'], start, ack: performance.now() });
    await b.recover();
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  test(as('lost_write', 'the run that met the uncommitted edit names worktree_dirty for it'), () => {
    const path = `${noteSlug(target)}.md`;
    const envelopeNames = JSON.stringify(raced ?? {}).includes('worktree_dirty');
    b.verdict(heldAfterRun.some(h => h.code === 'worktree_dirty' && h.path === path) && envelopeNames ? []
      : [`expected a worktree_dirty hold on ${path} in the run's receipt and status; status holds ${JSON.stringify(heldAfterRun)}, receipt ${JSON.stringify(raced).slice(0, 400)}`]);
  });
  oracleTests(b, () => ({ bigPage: false }));
});

// ---------------------------------------------------------------- (f): a pooler drop mid-bulk

scenario(['f'], 'a pooler drop mid-bulk leaves no new hold and converges', () => {
  const b = new Brain('pooler-drop', ['f']);
  const notes = Math.min(NOTES, 200);
  let holdsBefore = 0, holdsAfter = 0, stall = 0;
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
    b.writeNotes(Array.from({ length: Math.min(notes, 120) }, (_, i) => i), 'Round one', 'round one');
    holdsBefore = ((await b.status())?.holds as unknown[] | undefined)?.length ?? 0;
    const at = await b.now();
    const how = PGBOUNCER_CONTAINER ? `docker restart -t 0 ${PGBOUNCER_CONTAINER}` : 'drop every pooled connection at the proxy';
    b.plan = [`${how} after 20 committed pages`];
    const run = b.sync(['--no-pull', '--no-delegate', '--json']);
    const dropped = until(async () => (await b.committedSince(at)) >= 20, 'twenty committed pages', SYNC_TIMEOUT_MS).then(() => {
      if (PGBOUNCER_CONTAINER) execFileSync('docker', ['restart', '-t', '0', PGBOUNCER_CONTAINER], { stdio: 'ignore' });
      else b.note(`dropped ${b.pooledProxy!.drop()} pooled connections`);
      return 'dropped';
    });
    const r = await run.result;
    b.fired[b.plan[0]] = await dropped.catch(() => null);
    b.keepLog('dropped-run.log', `${r.out}\n${r.err}`);
    stall = worstStall(r.err);
    b.note(`dropped run: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s, worst stall ${stall}s`);
    await b.recover();
    holdsAfter = ((await b.status())?.holds as unknown[] | undefined)?.length ?? 0;
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  test(as('wedge', 'the pooler drop created no hold'), () => b.verdict(holdsAfter > holdsBefore ? [`${holdsAfter - holdsBefore} new hold(s) after the pooler drop`] : []));
  // A dropped pooled connection is an owner losing its session: the drain resumes within the owner-kill bound, not a publication lease.
  test(as('wedge', `the run resumed within ${OWNER_KILL_STALL_BOUND_S}s of the pooler drop`), () =>
    b.verdict(stall > OWNER_KILL_STALL_BOUND_S ? [`the dropped run stalled ${stall}s on one step`] : []));
  oracleTests(b, () => ({ bigPage: false }));
});

// ---------------------------------------------------------------- (g): two concurrent drainers

scenario(['g'], 'a --all run beside a serve draining the same source converges', () => {
  const b = new Brain('two-drainers', ['g']);
  const notes = Math.min(NOTES, 200);
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
    b.writeNotes(Array.from({ length: Math.min(notes, 120) }, (_, i) => i), 'Round one', 'round one');
    b.plan = ['a delegated sync drains in the serve while sync --all --no-delegate drains beside it'];
    const serve = new StdioServe(b);
    await serve.start();
    const [delegated, all] = await Promise.all([b.sync(['--no-pull', '--json']).result,
      b.spawnCli(['sync', '--all', '--no-pull', '--no-delegate', '--json']).result]);
    b.keepLog('delegated.log', `${delegated.out}\n${delegated.err}`); b.keepLog('all.log', `${all.out}\n${all.err}`);
    b.note(`delegated sync exit ${delegated.code}; --all exit ${all.code}`);
    await serve.stop();
    await b.recover();
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  oracleTests(b, () => ({ bigPage: false }));
});

// ---------------------------------------------------------------- (lease): the drain-lease holder dies with followers queued

scenario(['lease'], 'a killed drain-lease holder is taken over by a queued follower and the source converges', () => {
  const b = new Brain('lease-takeover', ['lease']);
  const notes = Math.min(NOTES, 200);
  const followers: Array<{ code: number; envelope: Record<string, unknown> | null; followed: boolean }> = [];
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
    b.writeNotes(Array.from({ length: Math.min(notes, 120) }, (_, i) => i), 'Round one', 'round one');
    const tag = 'leader', release = join(b.home, 'release-leader');
    b.plan = ['leader stalls at sync:lease_acquired #1; two --no-delegate followers queue behind it; the leader is SIGKILLed'];
    const leader = b.sync(['--no-pull', '--no-delegate', '--json'], { point: 'sync:lease_acquired', nth: 1, marker: b.marker(tag), action: 'stall', release });
    await until(() => existsSync(b.marker(tag)), 'the leader to take the drain lease', SYNC_TIMEOUT_MS);
    const queued = [0, 1].map(() => b.sync(['--no-pull', '--no-delegate', '--json', '--timeout', '10m']));
    // Both followers must be following the live leader before it dies (they print the holder once they see it).
    await Bun.sleep(5_000);
    leader.proc.kill('SIGKILL'); b.killedPids.add(leader.proc.pid);
    const killed = await leader.result;
    b.keepLog('leader.log', `${killed.out}\n${killed.err}`);
    b.recordFault(tag, b.plan[0]);
    for (const [i, run] of queued.entries()) {
      const r = await run.result;
      b.keepLog(`follower-${i + 1}.log`, `${r.out}\n${r.err}`);
      followers.push({ code: r.code, envelope: lastJson(r.out), followed: r.err.includes('following it until it finishes') });
      b.note(`follower ${i + 1}: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s outcome=${String(lastJson(r.out)?.outcome ?? 'none')}`);
    }
    await b.recover();
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  test(as('wedge', 'a follower takes over the dead holder inside the lease TTL; no follower ends blocked'), () => b.verdict([
    ...(followers.some(f => f.followed) ? [] : ['no follower reported following the live leader']),
    ...(followers.some(f => f.code === 0 && f.envelope?.outcome === 'synced') ? [] : [`no follower finished the source: ${JSON.stringify(followers.map(f => [f.code, f.envelope?.outcome]))}`]),
    ...followers.filter(f => f.envelope?.outcome === 'blocked').map(f => `a follower ended blocked: ${JSON.stringify(f.envelope?.next ?? f.envelope).slice(0, 400)}`),
  ]));
  oracleTests(b, () => ({ bigPage: false }));
});

// ---------------------------------------------------------------- (systemic): a refusal on every page write

for (const sqlstate of ['P0001', '55000'] as const) {
  scenario(['systemic'], `a systemic ${sqlstate} refusal stops the run with a named blocker and converges once lifted`, () => {
    const b = new Brain(`systemic-${sqlstate}`, ['systemic']);
    const notes = Math.min(NOTES, 200);
    let refused: { code: number; envelope: Record<string, unknown> | null; terminal: number } | null = null;
    beforeAll(async () => {
      await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
      b.writeNotes(Array.from({ length: Math.min(notes, 40) }, (_, i) => i), 'Round one', 'round one');
      b.plan = [`trigger on pages raising SQLSTATE ${sqlstate} (an unregistered raiser) for one sync run, then dropped`];
      await b.engine!.executeRaw(`CREATE FUNCTION convergence_systemic_refusal() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION USING ERRCODE = '${sqlstate}', MESSAGE = 'convergence harness: systemic refusal'; END $$`);
      await b.engine!.executeRaw('CREATE TRIGGER convergence_systemic_refusal BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION convergence_systemic_refusal()');
      b.fired[b.plan[0]] = 'installed';
      const at = await b.now();
      const r = await b.sync(['--no-pull', '--no-delegate', '--json']).result;
      b.keepLog('refused-run.log', `${r.out}\n${r.err}`);
      await b.engine!.executeRaw('DROP TRIGGER convergence_systemic_refusal ON pages; DROP FUNCTION convergence_systemic_refusal()');
      const terminal = (await b.engine!.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests WHERE operation='submit_job'
        AND created_at > $1::timestamptz AND state IN ('failed','conflict','cancelled')`, [at]))[0].n;
      refused = { code: r.code, envelope: lastJson(r.out), terminal };
      b.note(`refused run: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s outcome=${String(refused.envelope?.outcome ?? refused.envelope?.sync_status ?? 'none')}; ${terminal} terminal non-committed request(s)`);
      await b.recover();
    }, SCENARIO_TIMEOUT_MS);
    afterAll(() => b.teardown(), 120_000);
    test(as('wedge', 'the refused run does not report success and its receipt names the SQLSTATE'), () => b.verdict([
      ...(refused?.code !== 0 && refused?.envelope?.outcome !== 'synced' ? [] : [`the refused run reported success (exit ${refused?.code}, outcome ${String(refused?.envelope?.outcome)})`]),
      ...(JSON.stringify(refused?.envelope ?? {}).includes(sqlstate) ? [] : [`the refused run's receipt does not name ${sqlstate}: ${JSON.stringify(refused?.envelope).slice(0, 400)}`]),
    ]));
    oracleTests(b, () => ({ bigPage: false }));
  });
}

// ---------------------------------------------------------------- (knock-on): one page, one fate

scenario(['knock-on'], 'one failed page inside a bulk group cancels no other page of the run', () => {
  const b = new Brain('knock-on', ['knock-on']);
  const notes = Math.min(NOTES, 200);
  const refused = noteSlug(5);
  let cancelled: string[] = [];
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
    const changed = Array.from({ length: Math.min(notes, 80) }, (_, i) => i);
    b.plan = ['throw SQLSTATE P0001 once at publication:before_commit #5 (submit_job)',
      `trigger on pages raising SQLSTATE P0001 for ${refused} only, for one sync run, then dropped`];
    const at = await b.now();
    b.writeNotes(changed, 'Round one', 'round one');
    const tag = 'throw';
    const r = await b.sync(['--no-pull', '--no-delegate', '--json'], { point: 'publication:before_commit', nth: 5, operation: 'submit_job', marker: b.marker(tag), action: 'throw', sqlstate: 'P0001' }).result;
    b.keepLog('failed-run.log', `${r.out}\n${r.err}`);
    const fired = b.recordFault(tag, b.plan[0]);
    const failed = fired ? (JSON.parse(fired) as { requestId?: string }).requestId : undefined;
    b.note(`one-shot failure run: exit ${r.code}`);
    b.writeNotes(changed, 'Round two', 'round two');
    await b.engine!.executeRaw(`CREATE FUNCTION convergence_page_refusal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.slug = '${refused}' THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'convergence harness: page refusal'; END IF; RETURN NEW; END $$`);
    await b.engine!.executeRaw('CREATE TRIGGER convergence_page_refusal BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION convergence_page_refusal()');
    b.fired[b.plan[1]] = 'installed';
    const refusedRun = await b.sync(['--no-pull', '--no-delegate', '--json']).result;
    b.keepLog('refused-page-run.log', `${refusedRun.out}\n${refusedRun.err}`);
    await b.engine!.executeRaw('DROP TRIGGER convergence_page_refusal ON pages; DROP FUNCTION convergence_page_refusal()');
    cancelled = (await b.engine!.executeRaw<{ request_id: string; slug: string; error_code: string | null }>(
      `SELECT request_id::text, slug, error_code FROM persistence_requests WHERE operation='submit_job' AND created_at > $1::timestamptz AND state='cancelled'
        AND request_id::text <> $2 AND slug <> $3`, [at, failed ?? '', refused])).map(row => `${row.slug} (${row.error_code})`);
    b.note(`refused-page run: exit ${refusedRun.code}; ${cancelled.length} other request(s) cancelled`);
    await b.recover();
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  test(as('wedge', 'the failed page cancelled no other page of its run'), () => b.verdict(cancelled.map(c => `cancelled as a knock-on: ${c}`)));
  oracleTests(b, () => ({ bigPage: false }));
});
