/**
 * The real-process brain harness shared by the managed-sync convergence gate (test/sync-convergence.serial.test.ts)
 * and the busy-agent soak cell (test/busy-agent-soak.serial.test.ts): one isolated Postgres database behind
 * transaction-mode PgBouncer, reached by every child process through latency proxies, a Git worktree bound to one
 * managed source, real `src/cli.ts` child processes (optionally under the fault preload
 * test/fixtures/convergence-fault-kill.ts), a resident stdio serve, the acknowledged-write ledger and the oracle reads.
 * Each suite passes its own knobs (seed, latency, log directory, repro line). Setup: scripts/persistence/README.md.
 */
import { test } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { contentHash } from '../../src/core/utils.ts';
import { CODES } from '../../src/core/error-registry.ts';
import type { FaultPoint } from '../../src/core/persistence/fault-points.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';
import { keylessBrainEnv } from './provider-env.ts';
import { withEnv } from './with-env.ts';
import { LatencyProxy } from './latency-proxy.ts';
import type { ViolationClass } from '../../scripts/persistence/model.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const FAULT_PRELOAD = join(REPO_ROOT, 'test/fixtures/convergence-fault-kill.ts');
export const SOURCE = 'workspace';
export const BIG = 'companies/acme-example';
export const ENTITY = 'people/alice-example';
export const MAX_RECOVERY_RUNS = 2;

/** What a suite passes to every brain: the knobs its failures print, where its logs go, and the targets behind the proxies. */
export interface HarnessKnobs {
  /** Prefixes every progress line (`[<tag> <scenario>]`) and names the log file `<tag>.log` in logDir. */
  tag: string;
  seed: number;
  latencyMs: number;
  /** Per child process (a sync or a writer call) unless a call passes its own. */
  syncTimeoutMs: number;
  logDir: string | undefined;
  pooledTarget: string;
  directTarget: string;
  /** The suite's other knobs, printed after the seed and modes in every failure. */
  summary: string;
  /** The local command that reruns these modes, printed in every failure. */
  repro: (modes: string[]) => string;
}

/** mulberry32: a fixed seed gives the same fault plan and writer targets on every run. */
export function prng(seed: number): () => number {
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
export const STATUS_FIELDS = ['source_id', 'run_id', 'cursor', 'committed_last_10m', 'live_job_id', 'holds', 'last_error', 'needs_human',
  'resume_argv', 'checkpoint_blockers', 'cursors', 'terminal_failures', 'next'] as const;
export interface StatusExpectation { holds?: Array<{ code: string; path: string }>; needsHuman?: boolean }
/**
 * What a converged source's status must say. Field-present assertions first: a renderer that drops a field fails
 * here, not in an agent's loop. `checkpoint_blockers` and `cursors` are arrays on every status (#6712 PR 0 made
 * `checkpoint_blockers` always present). The harness reads `sync status --json --detail`: since #6712 PR 2 the
 * terminal summary, blocker list and cursor join run only behind the flag.
 */
/** The default (no `--detail`) status after the chaos: every skipped heavy read says so and names the `--detail` command (#6712 PR 2, DX F1). */
export function fastStatusProblems(status: Record<string, unknown> | null): string[] {
  if (!status) return ['sync status --json printed no JSON document'];
  return (['checkpoint_blockers_read', 'cursors_read', 'terminal_failures_read'] as const).flatMap(field => {
    const read = status[field] as { status?: string; fix?: { argv?: string[] } } | undefined;
    return read?.status === 'not_read' && read.fix?.argv?.includes('--detail') ? [] : [`sync status --json: ${field} is ${JSON.stringify(read)}, expected not_read with a --detail fix`];
  });
}

export function statusProblems(status: Record<string, unknown> | null, expected: StatusExpectation = {}): string[] {
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
export interface Ack { kind: 'commit' | 'put' | 'remember' | 'maintenance' | 'db_only' | 'git_mv' | 'git_rm' | 'unlink'; slug: string;
  marker: string | null; touches: Array<'db' | 'file'> | 'fact'; start: number; ack: number }
export class Ledger {
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

export function noteText(i: number, version: string): string {
  return `---\ntype: concept\ntitle: Note ${i} Example\n---\n\n${version} body for note ${i}, an observation about widget-co and acme-example.\n\n${'Supporting detail sentence. '.repeat(8 + (i % 5))}\n`;
}
export const noteMarker = (i: number, version: string) => `${version} body for note ${i},`;
export const noteSlug = (i: number) => `notes/note-${String(i).padStart(4, '0')}`;
export function bigPage(facts: number, timeline: number, version: string): string {
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
export const entityText = '---\ntype: person\ntitle: Alice Example\n---\n\nAlice Example works with acme-example.\n';

// ---------------------------------------------------------------- one brain

export interface Fault { point: FaultPoint; nth: number; marker: string; operation?: string; path?: string; action?: 'kill' | 'edit' | 'stall' | 'throw';
  edit?: { file: string; content: string }; release?: string; ms?: number; sqlstate?: string;
  prime?: { point: FaultPoint; nth: number; path?: string; edit: { file: string; content: string } } }
export interface Run { code: number; out: string; err: string; ms: number }
export interface SyncRun { proc: ReturnType<typeof Bun.spawn>; result: Promise<Run> }

export async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 300_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}
export function lastJson(out: string): Record<string, unknown> | null {
  try { return JSON.parse(out) as Record<string, unknown>; } catch { /* several documents */ }
  for (const line of out.trim().split('\n').reverse()) { try { return JSON.parse(line) as Record<string, unknown>; } catch { /* not the envelope */ } }
  return null;
}
/** The longest `stalled Ns` progress line a sync printed: how long it waited on a predecessor's leftovers. */
export function worstStall(err: string): number { return Math.max(0, ...[...err.matchAll(/stalled (\d+)s/g)].map(m => Number(m[1]))); }

/**
 * One scenario's brain: its database, home, Git worktree, proxies, child processes, ledger and log. `context()` is
 * what every failure prints: seed, modes, the fault plan and the one-line repro.
 */
export class Brain {
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
  constructor(readonly name: string, readonly modes: string[], readonly knobs: HarnessKnobs) { this.rand = prng(knobs.seed ^ [...name].reduce((h, c) => Math.imul(h, 31) + c.charCodeAt(0), 7)); }

  between(lo: number, hi: number): number { return lo + Math.floor(this.rand() * (hi - lo + 1)); }
  note(line: string): void {
    console.error(`[${this.knobs.tag} ${this.name}] ${line}`);
    if (this.knobs.logDir) { mkdirSync(this.knobs.logDir, { recursive: true }); appendFileSync(join(this.knobs.logDir, `${this.knobs.tag}.log`), `[${this.name}] ${line}\n`); }
  }
  keepLog(name: string, text: string): void { if (this.knobs.logDir) { mkdirSync(join(this.knobs.logDir, this.name), { recursive: true }); writeFileSync(join(this.knobs.logDir, this.name, name), text); } }
  context(): string {
    return [`seed ${this.knobs.seed}; modes ${this.modes.join(',')}; ${this.knobs.summary}`,
      `fault plan: ${this.plan.join('; ') || 'none'}`,
      `fired: ${Object.entries(this.fired).map(([k, v]) => `${k} => ${v ?? 'did not fire'}`).join('; ') || 'none'}`,
      `repro (Postgres + PgBouncer from scripts/persistence/README.md): ${this.knobs.repro(this.modes)}`].join('\n');
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
    const timer = setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs ?? this.knobs.syncTimeoutMs);
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
    assertSafeE2eDatabaseUrl(this.knobs.directTarget);
    this.home = mkdtempSync(join(tmpdir(), 'gb-conv-'));
    mkdirSync(join(this.home, '.gbrain'));
    this.database = `gbrain_test_${this.knobs.tag.replaceAll('-', '_')}_${randomUUID().replaceAll('-', '')}`;
    this.admin = postgres(this.knobs.directTarget, { max: 1, prepare: false });
    await this.admin.unsafe(`CREATE DATABASE ${this.database}`);
    const direct = new URL(this.knobs.directTarget); direct.pathname = `/${this.database}`;
    const pooled = new URL(this.knobs.pooledTarget); pooled.pathname = `/${this.database}`;
    this.pooledProxy = new LatencyProxy({ host: pooled.hostname, port: Number(pooled.port) || 5432 }, this.knobs.latencyMs / 2);
    this.directProxy = new LatencyProxy({ host: direct.hostname, port: Number(direct.port) || 5432 }, this.knobs.latencyMs / 2);
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
    this.note(`seed=${this.knobs.seed} latency=${this.knobs.latencyMs}ms round trip via proxies (pooled -> ${pooled.host}, direct -> ${direct.host}); modes ${this.modes.join(',')}`);
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

  /** A fresh resident serve and at most MAX_RECOVERY_RUNS plain syncs, no operator step; a synced run that HEAD has moved past since (a queued write's Git commit landing during or after it) is followed by the next. */
  async recover(): Promise<void> {
    const started = performance.now();
    const serve = new StdioServe(this);
    await serve.start();
    for (let run = 1; run <= MAX_RECOVERY_RUNS; run++) {
      const r = await this.sync(['--no-pull', '--json']).result;
      const envelope = lastJson(r.out);
      this.recoveryRuns.push({ ...r, envelope });
      this.keepLog(`recovery-${run}-client.log`, `${r.out}\n${r.err}`);
      const [source] = await this.engine!.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [SOURCE]);
      const head = this.git('rev-parse', 'HEAD');
      const behind = source.last_commit && source.last_commit !== head ? this.git('log', '--format=%h %s', `${source.last_commit}..HEAD`).split('\n').filter(Boolean) : [];
      this.note(`recovery run ${run}: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s outcome=${String(envelope?.outcome ?? envelope?.sync_status ?? envelope?.error ?? 'none')}${behind.length ? `; ${behind.length} commit(s) landed after it: ${behind.join('; ')}` : ''}`);
      if (r.code === 0 && envelope?.outcome === 'synced' && !behind.length) break;
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
        WHERE state IN ('queued','deferred','running','recovering') OR recovery IS NOT NULL ORDER BY sequence`);
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

export function fileHash(slug: string, content: string): string {
  const parsed = parseMarkdown(content, `${slug}.md`);
  return contentHash({ title: parsed.title, type: parsed.type, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline, frontmatter: parsed.frontmatter, tags: [...parsed.tags].sort() });
}

/** One stdio MCP session against a spawned `gbrain serve`; the serve is the host's resident persistence owner. */
export class StdioServe {
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

/**
 * A writer call that retries an unsettled attempt (exit 10, a lost owner) with the same request id and a terminal refusal with a new one.
 * When the attempts or the chaos run out on an unsettled attempt, the request it names may still commit, so it comes back `pending`.
 */
export async function acknowledged(b: Brain, label: string, call: (requestId: string) => SyncRun, stop: () => boolean): Promise<{ start: number; ack: number } | { pending: string } | null> {
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
export const outcome = (ok: { ack: number } | { pending: string } | null) => !ok ? 'unacknowledged' : 'pending' in ok ? `pending ${ok.pending}` : 'ok';

/** Oracle tests are named by the persistence gate's violation class (scripts/persistence/model.ts) they would report. */
export const as = (violation: ViolationClass, title: string): string => `[${violation}] ${title}`;

// ---------------------------------------------------------------- the shared oracle

export interface EndState { exclude?: Set<string>; status?: StatusExpectation; bigPage?: boolean }
/** The oracle tests every scenario ends with; `end()` is read when the tests run (after the scenario's beforeAll). */
export function oracleTests(b: Brain, end: () => EndState): void {
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
