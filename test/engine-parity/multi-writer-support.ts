/**
 * Support for the multi-writer conformance cases that run writer processes (C18, C19): the job fixtures the case file and the
 * writer script share, the pure check of what a crash must leave behind, and the helper that starts a bounded writer process
 * and reads the lines it prints.
 *
 * Pure parts first (no engine, no `bun:test`): `acknowledgedWriteViolations` is the C19 check, and test/multi-writer-cases.test.ts
 * proves with controls that it rejects a missing and a duplicated acknowledged write.
 */
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, ClaimJobSpec, JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority } from '../../src/core/minions/submission-authority.ts';

export function jobValues(name: string, extra: Partial<JobInsertValues> = {}): JobInsertValues {
  return {
    name, queue: 'default', status: 'waiting', priority: 0, data: {}, max_attempts: 3, backoff_type: 'exponential',
    backoff_delay: 1000, backoff_jitter: 0.2, delay_until: null, parent_job_id: null, on_child_fail: 'fail_parent',
    max_children: null, timeout_ms: null, lock_duration_ms: null, remove_on_complete: false, remove_on_fail: false,
    idempotency_key: null, quiet_hours: null, stagger_key: null, private_queue_owner_job_id: null,
    private_queue_owner_token: null, private_queue_lease_until: null, submission_authority: APPLICATION_AUTHORITY,
    spend_authorization: null, max_stalled: null, ...extra,
  };
}

export const JOB_POLICY: AdmitJobPolicy = {
  decide: async (_tx, row) => coalesceDecision(row, APPLICATION_AUTHORITY),
  parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
};

export function claimSpec(token: string, extra: Partial<ClaimJobSpec> = {}): ClaimJobSpec {
  return {
    lockToken: token, lockDurationMs: 30_000, queue: 'default', names: ['work'], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 }, ...extra,
  };
}

/** Submits a job under a request key (a repeated key coalesces onto the first row). */
export const admitKeyed = (engine: BrainEngine, key: string) => engine.admitJob({ maxSpawnDepth: 5, insert: jobValues('work', { idempotency_key: key }) }, JOB_POLICY);

const codeOf = (e: unknown): string => (e as { code?: string } | null)?.code ?? 'threw';

/** The page slug and body of round `round` of C18 writer `id`, and the job request key of writer `id`. */
export const stressSlug = (id: number, round: number): string => `notes/c18-${id}-${round}`;
export const stressBody = (id: number, round: number): string => `body ${id} ${round}`;
export const stressKey = (id: number): string => `req-${id}`;

/** What one of the eight concurrent writers of a process did. */
export interface StressResult { id: number; pages: string[]; refused: string[]; job: number | null }

/** What a stress process reports: its writers, and when its load started and ended (wall clock, ms), so the case can prove the loads overlapped. */
export interface StressReport { results: StressResult[]; startedAt: number; finishedAt: number }

/**
 * The C18 workload of one process: eight concurrent writers (writer ids `index * 8 + w`), each writing two pages, submitting a job
 * under its request key and claiming a job. Errors are kept by code, never thrown, so the case can say which writer was refused.
 */
export async function runStressWriters(engine: BrainEngine, index: number): Promise<StressResult[]> {
  return Promise.all(Array.from({ length: 8 }, async (_, w) => {
    const id = index * 8 + w;
    const refused: string[] = [];
    const pages: string[] = [];
    for (let round = 0; round < 2; round++) {
      const slug = stressSlug(id, round);
      try { await engine.putPage(slug, { type: 'note', title: `W${id}`, compiled_truth: stressBody(id, round), timeline: '' }); pages.push(slug); } catch (e) { refused.push(codeOf(e)); }
    }
    try { await admitKeyed(engine, stressKey(id)); } catch (e) { refused.push(codeOf(e)); }
    let job: number | null = null;
    try { const row = await engine.claimNextJob(claimSpec(`w${id}:a`)); job = row ? Number(row.id) : null; } catch (e) { refused.push(codeOf(e)); }
    return { id, pages, refused, job };
  }));
}

/** What the parent reads after the stress run: every process's report, the body of each page it found by slug, and the job ids stored under each request key. */
export interface StressObservation {
  reports: readonly StressReport[];
  pageBodies: ReadonlyMap<string, string>;
  jobIdsByKey: ReadonlyMap<string, readonly number[]>;
}

const BUSY = new Set(['store_locked', 'pglite_busy', 'owner_unavailable', 'owner_busy']);

/**
 * Every way the C18 run breaks "64 writers in 8 processes, no lost update, no double claim, no busy error", as messages; empty
 * when it holds: the loads overlapped (every process started before any finished), the 64 writers are 0..63 once each, none was
 * refused or got a busy error, every expected page slug has its exact body, the stored jobs are exactly the 64 request keys with one
 * row each, and the claimed ids are distinct and are exactly the stored jobs' ids.
 */
export function stressViolations(seen: StressObservation): string[] {
  const out: string[] = [];
  const lastStart = Math.max(...seen.reports.map(r => r.startedAt));
  const firstEnd = Math.min(...seen.reports.map(r => r.finishedAt));
  if (!(lastStart < firstEnd)) out.push('the loads did not overlap: one process finished before another started');
  const writers = seen.reports.flatMap(r => r.results);
  const ids = writers.map(w => w.id).sort((x, y) => x - y);
  if (ids.length !== 64 || ids.some((id, i) => id !== i)) out.push(`the writers are not 0..63 once each: ${ids.join(',')}`);
  for (const w of writers) {
    for (const code of w.refused) out.push(`writer ${w.id} was refused (${code})${BUSY.has(code) ? ': a busy error' : ''}`);
    for (let round = 0; round < 2; round++) {
      const body = seen.pageBodies.get(stressSlug(w.id, round));
      if (body === undefined) out.push(`${stressSlug(w.id, round)}: the page is missing`);
      else if (body !== stressBody(w.id, round)) out.push(`${stressSlug(w.id, round)}: its body is wrong`);
    }
  }
  const expectedKeys = Array.from({ length: 64 }, (_, id) => stressKey(id)).sort();
  const keys = [...seen.jobIdsByKey.keys()].sort();
  if (keys.join('|') !== expectedKeys.join('|')) out.push('the stored jobs are not exactly the 64 request keys');
  for (const [key, rows] of seen.jobIdsByKey) if (rows.length !== 1) out.push(`request key ${key} has ${rows.length} rows`);
  const claimed = writers.map(w => w.job).filter((id): id is number => id !== null);
  if (claimed.length !== new Set(claimed).size) out.push('a job was claimed twice');
  const stored = [...seen.jobIdsByKey.values()].flat().sort((x, y) => x - y);
  if (claimed.slice().sort((x, y) => x - y).join(',') !== stored.join(',')) out.push('the claimed ids are not the stored jobs\' ids');
  return out;
}

// ---- C19: what a crash must leave behind --------------------------------------------------------------------------

/** The request key and page slug of the n-th write of the C19 writer process. */
export const crashKey = (n: number): string => `c19-request-${n}`;
export const crashSlug = (n: number): string => `notes/c19-${n}`;
export const crashBody = (n: number): string => `acknowledged ${n}`;

/** What the reopened brain holds after the writer was killed: job rows per request key, and the page bodies by slug. */
export interface CrashObservation {
  /** The writes the writer printed as acknowledged, by number. */
  acknowledged: readonly number[];
  /** How many job rows each request key has (a key with no row is absent). */
  jobRowsByKey: ReadonlyMap<string, number>;
  /** The body of each page the brain has, by slug. */
  pageBodies: ReadonlyMap<string, string>;
}

/**
 * Every way the reopened brain breaks "acknowledged writes present, none duplicated", as messages; empty when it holds. An
 * acknowledged write must have its page with its body and exactly one job row under its key. A write that was in flight when the
 * writer died was never acknowledged: it may have landed or not, but still at most one row.
 */
export function acknowledgedWriteViolations(seen: CrashObservation): string[] {
  const out: string[] = [];
  const counts = new Map<number, number>();
  for (const n of seen.acknowledged) counts.set(n, (counts.get(n) ?? 0) + 1);
  for (const [n, times] of counts) if (times > 1) out.push(`write ${n} was acknowledged ${times} times`);
  for (const n of counts.keys()) {
    const rows = seen.jobRowsByKey.get(crashKey(n)) ?? 0;
    if (rows === 0) out.push(`acknowledged write ${n}: its job row is missing`);
    if (rows > 1) out.push(`acknowledged write ${n}: its job has ${rows} rows`);
    const body = seen.pageBodies.get(crashSlug(n));
    if (body === undefined) out.push(`acknowledged write ${n}: its page is missing`);
    else if (body !== crashBody(n)) out.push(`acknowledged write ${n}: its page holds another body`);
  }
  for (const [key, rows] of seen.jobRowsByKey) if (rows > 1 && !out.some(m => m.includes(`${rows} rows`))) out.push(`request key ${key} has ${rows} rows`);
  return out;
}

// ---- the writer process --------------------------------------------------------------------------------------------

export const WRITER_SCRIPT = join(import.meta.dir, 'fixtures', 'mw-writer.ts');

/** What the writer process is told, as JSON in the MW_WRITER environment variable. */
export interface WriterConfig {
  role: 'crash' | 'stress';
  backend: 'postgres' | 'rust';
  databaseUrl?: string;
  databasePath?: string;
  /** Rust only: the multi-user route the arm runs under (the child sets the switch itself: the preload strips it from its environment). */
  muRoute?: 'env' | 'config';
  /** Rust only: the process started with GBRAIN_RUST_MULTIUSER=1 (an ambient multi-user run); the child's store must resolve it on. */
  ambient?: boolean;
  /** crash: stop after this many acknowledged writes, or at the deadline. stress: this process's number. */
  max?: number;
  index?: number;
  /** stress: after READY, wait for the parent's `GO` line on stdin before writing (the parent's start barrier). */
  startOnGo?: boolean;
  deadlineMs: number;
}

export interface WriterProcess {
  /** The complete lines printed so far. */
  lines(): string[];
  /** Tells a process that waits for the start barrier to begin. */
  go(): void;
  /** Resolves when `predicate` holds for the lines printed so far, or rejects after `ms`. */
  until(predicate: (lines: string[]) => boolean, ms: number, what: string): Promise<void>;
  kill(): Promise<{ signal: string | null; exitCode: number | null }>;
  /** Waits up to `ms` for the process to exit by itself, then kills it; always resolves once the process is gone. */
  reap(ms: number): Promise<{ signal: string | null; exitCode: number | null }>;
  exited: Promise<{ signal: string | null; exitCode: number | null }>;
  stderr(): string;
}

/** Starts the writer process; its stdout is read to the end, so lines printed before a kill are all seen. */
export function startWriter(config: WriterConfig): WriterProcess {
  const proc = Bun.spawn([process.execPath, WRITER_SCRIPT], {
    cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe', stdin: 'pipe',
    env: { ...process.env, MW_WRITER: JSON.stringify(config) },
  });
  let text = '';
  let errors = '';
  const drain = async (stream: ReadableStream<Uint8Array>, into: (chunk: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) into(decoder.decode(chunk, { stream: true }));
  };
  const reading = Promise.all([drain(proc.stdout, c => { text += c; }), drain(proc.stderr, c => { errors += c; })]);
  const complete = () => { const parts = text.split('\n'); parts.pop(); return parts; };
  const exited = proc.exited.then(async () => { await reading; clearTimeout(watchdog); return { signal: proc.signalCode, exitCode: proc.exitCode }; });
  // A process never outlives its deadline by more than a grace: a hung disconnect cannot leave one behind.
  const watchdog = setTimeout(() => proc.kill('SIGKILL'), config.deadlineMs + 15_000);
  return {
    go() { proc.stdin.write('GO\n'); void proc.stdin.flush(); },
    async reap(ms) {
      const timer = Bun.sleep(ms).then(() => 'late' as const);
      if ((await Promise.race([exited, timer])) === 'late') proc.kill('SIGKILL');
      return exited;
    },
    lines: complete,
    stderr: () => errors,
    exited,
    async until(predicate, ms, what) {
      const end = Date.now() + ms;
      while (!predicate(complete())) {
        if (Date.now() > end) { proc.kill('SIGKILL'); throw new Error(`the writer process did not ${what} within ${ms} ms; stderr: ${errors.slice(0, 400)}`); }
        if (proc.exitCode !== null) { await reading; if (predicate(complete())) return; throw new Error(`the writer process exited (${proc.exitCode}) before it did ${what}; stderr: ${errors.slice(0, 400)}`); }
        await Bun.sleep(10);
      }
    },
    async kill() { proc.kill('SIGKILL'); return exited; },
  };
}
