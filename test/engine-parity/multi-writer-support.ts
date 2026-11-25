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

/** What one of the eight concurrent writers of a process did. */
export interface StressResult { pages: string[]; refused: string[]; job: number | null }

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
      const slug = `notes/c18-${id}-${round}`;
      try { await engine.putPage(slug, { type: 'note', title: `W${id}`, compiled_truth: `body ${id} ${round}`, timeline: '' }); pages.push(slug); } catch (e) { refused.push(codeOf(e)); }
    }
    try { await admitKeyed(engine, `req-${id}`); } catch (e) { refused.push(codeOf(e)); }
    let job: number | null = null;
    try { const row = await engine.claimNextJob(claimSpec(`w${id}:a`)); job = row ? Number(row.id) : null; } catch (e) { refused.push(codeOf(e)); }
    return { pages, refused, job };
  }));
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
  /** crash: stop after this many acknowledged writes, or at the deadline. stress: this process's number. */
  max?: number;
  index?: number;
  deadlineMs: number;
}

export interface WriterProcess {
  /** The complete lines printed so far. */
  lines(): string[];
  /** Resolves when `predicate` holds for the lines printed so far, or rejects after `ms`. */
  until(predicate: (lines: string[]) => boolean, ms: number, what: string): Promise<void>;
  kill(): Promise<{ signal: string | null; exitCode: number | null }>;
  exited: Promise<{ signal: string | null; exitCode: number | null }>;
  stderr(): string;
}

/** Starts the writer process; its stdout is read to the end, so lines printed before a kill are all seen. */
export function startWriter(config: WriterConfig): WriterProcess {
  const proc = Bun.spawn([process.execPath, WRITER_SCRIPT], {
    cwd: join(import.meta.dir, '..', '..'), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
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
  const exited = proc.exited.then(async () => { await reading; return { signal: proc.signalCode, exitCode: proc.exitCode }; });
  return {
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
