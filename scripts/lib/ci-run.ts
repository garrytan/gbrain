/**
 * One completed workflow run's failure evidence, shared by the nightly-red
 * and master-red watchers (scripts/nightly-issue.ts, scripts/lib/master-red.ts).
 *
 * `collectEvidence` reads the run's jobs, the failing jobs' check-run
 * annotations (a cancelled job is not run unless its annotation says it hit
 * timeout-minutes; a red run whose only failures are aggregators of cancelled
 * jobs is ignored, changing no state) and, for workflows that upload it, the `ci-manifest` artifact
 * (scripts/ci-manifest.ts). It returns structured failure records (job, step,
 * every failing test file and test identity) kept apart from sanitized error
 * excerpts, plus `complete` and `problems`: a jobs page, annotation or
 * manifest that could not be read is incomplete evidence, never zero
 * failures, and incomplete evidence never clears a failure.
 *
 * `reproduceCommand` builds the one reproduce line every issue prints from
 * validated fields only (a strict test-path pattern), never from run text.
 */
import { checkManifest, MANIFEST_ARTIFACT, MANIFEST_FILE, passedFiles, type CiManifest } from '../ci-manifest.ts';
import { fetchArtifactJson, inert, redactCredentials, type GitHubClient } from './gh-issue.ts';

export interface RunInfo {
  id: number;
  name: string;
  event: string;
  status?: string;
  conclusion: string | null;
  run_number: number;
  run_attempt: number;
  path: string;
  workflow_id: number;
  head_branch: string;
  head_sha: string;
  html_url: string;
  created_at?: string;
  head_repository?: { full_name: string };
  repository?: { full_name: string };
}
export interface JobInfo {
  id: number;
  name: string;
  conclusion: string | null;
  html_url?: string;
  steps?: Array<{ number: number; name: string; conclusion: string | null }>;
}
export interface Annotation { annotation_level: string; title?: string | null; message: string; path?: string }

/** `test` is sanitized for display; `name` (the exact JUnit test name) and `signature` feed stress-gate exemption records only. */
export interface FailedTest { file: string; test: string; lane: string; arm: string; job?: string; postgres: boolean; name?: string; signature?: string }
export interface FailedJob { job: string; job_id: number; step: string; conclusion: string; files: string[]; excerpt: string[]; owner_signal: boolean }
export interface RunEvidence {
  verdict: 'red' | 'green' | 'ignored';
  /** Jobs as evaluated: a cancelled job GitHub stamped as timed out reads `timed_out`. */
  jobs: JobInfo[];
  /** Jobs cancelled with their run, by a user or by fail-fast: not run, so they neither fail nor clear anything. */
  cancelled: string[];
  annotations: Record<number, Annotation[]>;
  failed: FailedJob[];
  succeeded: string[];
  tests: FailedTest[];
  files: string[];
  passed: string[];
  manifest: 'read' | 'not-expected' | 'unreadable';
  complete: boolean;
  problems: string[];
}

/** Job conclusions that are failures. A cancelled job is not run (see `collectEvidence`), unless GitHub stamped it as timed out. */
export const FAILING = new Set(['failure', 'timed_out', 'startup_failure']);
export const TIMED_OUT_ANNOTATION = /has exceeded the maximum execution time/;
export const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
export const AGGREGATORS = new Set(['test-status', 'e2e-status']);
export const MANIFEST_WORKFLOWS = new Set(['test.yml', 'e2e.yml']);
export const TEST_FILE = /^test\/[\w./-]+\.test\.ts$/;
export const OWNER_SIGNAL = /gh secret set|secret is empty|secrets? (?:is |are )?(?:empty|missing|not configured)/i;
const GENERIC_ERROR = /^Process completed with exit code \d+\.?$/;
const FILE_IN_TEXT = /(?:^|[\s(/'"])(test\/[\w./-]+?\.test\.ts)\b/g;
const POSTGRES_SIGNAL = /PostgreSQL arm|DATABASE_URL|postgres/i;
export const EXCERPTS_PER_JOB = 5;

export const workflowFile = (run: Pick<RunInfo, 'path'>) => run.path.split('/').pop() ?? run.path;

export function verdictOf(conclusion: string | null): RunEvidence['verdict'] {
  if (conclusion === 'success') return 'green';
  return RED_CONCLUSIONS.has(conclusion ?? '') ? 'red' : 'ignored';
}

/** `bun run test:stress <file> --iterations 10 [--postgres]`, or undefined when the path fails validation. */
export const EXEMPTION_MARKER = 'gbrain-stress-exemption';
export const EXEMPTION_OWNER = 'agent on release duty';
export const EXEMPTION_DAYS = 14;
export interface ExemptionRow { file: string; test: string; backend: string; signature: string; owner: string; expires: string }

/** The stress gate's backend arm for a failing file: E2E files run on Postgres, Postgres-armed unit files on both arms, the rest on PGLite. */
export function stressBackend(t: Pick<FailedTest, 'file' | 'postgres'>): string {
  return t.file.startsWith('test/e2e/') ? 'postgres' : t.postgres ? 'pglite+postgres' : 'pglite';
}

/**
 * Stress-gate exemption rows (scripts/stress/README.md): one per failing test
 * identity with its exact test name and failure signature; identities without
 * both (annotation-only failures, messages carrying credentials) get none.
 */
export function exemptionRows(tests: FailedTest[], expires: string): ExemptionRow[] {
  const rows = new Map<string, ExemptionRow>();
  for (const t of tests) {
    if (!t.name || !t.signature || !TEST_FILE.test(t.file)) continue;
    const row = { file: t.file, test: t.name, backend: stressBackend(t), signature: t.signature, owner: EXEMPTION_OWNER, expires };
    rows.set(JSON.stringify([row.file, row.test, row.backend, row.signature]), row);
  }
  return [...rows.values()];
}

export const plusDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function reproduceCommand(file: string, postgres: boolean): string | undefined {
  if (!TEST_FILE.test(file) || file.includes('..')) return undefined;
  return `bun run test:stress ${file} --iterations 10${postgres ? ' --postgres' : ''}`;
}

export async function pagedJobs(client: GitHubClient, run: RunInfo): Promise<{ jobs: JobInfo[]; complete: boolean }> {
  const jobs: JobInfo[] = [];
  let total = 0;
  for (let page = 1; page <= 5; page++) {
    const r = await client.request<{ jobs: JobInfo[]; total_count: number }>('GET', `repos/{repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    jobs.push(...r.jobs);
    total = r.total_count;
    if (jobs.length >= r.total_count || r.jobs.length < 100) break;
  }
  return { jobs, complete: jobs.length >= total };
}

/** Test files named by failure annotations: the annotation path, else paths quoted in the message (stack frames). */
export function annotationFiles(annotations: Annotation[]): string[] {
  const files = new Set<string>();
  for (const a of annotations.filter(x => x.annotation_level === 'failure')) {
    if (a.path && TEST_FILE.test(a.path)) files.add(a.path);
    for (const m of `${a.title ?? ''} ${a.message}`.matchAll(FILE_IN_TEXT)) if (TEST_FILE.test(m[1]!)) files.add(m[1]!);
  }
  return [...files].sort();
}

export function failedJobRecord(job: JobInfo, annotations: Annotation[]): FailedJob {
  const step = job.steps?.find(s => FAILING.has(s.conclusion ?? ''));
  const errors = annotations.filter(a => a.annotation_level === 'failure' && !GENERIC_ERROR.test(a.message.trim()))
    .map(a => [a.title, a.message].filter(Boolean).join(': '));
  return {
    job: inert(job.name), job_id: job.id, step: inert(step?.name ?? '(job-level)'), conclusion: inert(job.conclusion ?? '', 20),
    files: annotationFiles(annotations),
    excerpt: errors.slice(0, EXCERPTS_PER_JOB).map(e => inert(redactCredentials(e), 400)),
    owner_signal: errors.length > 0 && OWNER_SIGNAL.test(errors.join(' ')),
  };
}

export interface EvidenceOptions { manifest?: (run: RunInfo) => Promise<{ value?: unknown; reason?: string }> }

export async function collectEvidence(client: GitHubClient, run: RunInfo, opts: EvidenceOptions = {}): Promise<RunEvidence> {
  const problems: string[] = [];
  const listed = await pagedJobs(client, run);
  if (!listed.complete) problems.push(`the jobs list of run ${run.id} was truncated`);
  const byJob: Record<number, Annotation[]> = {};
  const read = async (job: JobInfo) => {
    if (byJob[job.id]) return byJob[job.id]!;
    try {
      byJob[job.id] = await client.request<Annotation[]>('GET', `repos/{repo}/check-runs/${job.id}/annotations?per_page=50`);
    } catch (e) {
      problems.push(`annotations of job '${inert(job.name)}' could not be read (${inert(e instanceof Error ? e.message : String(e), 120)})`);
      byJob[job.id] = [];
    }
    return byJob[job.id]!;
  };
  const cancelled: string[] = [];
  const jobs: JobInfo[] = [];
  for (const job of listed.jobs) {
    if (job.conclusion !== 'cancelled') { jobs.push(job); continue; }
    const timedOut = (await read(job)).some(a => TIMED_OUT_ANNOTATION.test(a.message));
    if (timedOut) jobs.push({ ...job, conclusion: 'timed_out' });
    else { jobs.push(job); cancelled.push(inert(job.name)); }
  }
  const failing = jobs.filter(j => FAILING.has(j.conclusion ?? ''));
  const real = failing.filter(j => !AGGREGATORS.has(j.name));
  const shown = real.length ? real : cancelled.length ? [] : failing;
  const failed: FailedJob[] = [];
  for (const job of shown) failed.push(failedJobRecord(job, await read(job)));
  const tests: FailedTest[] = [];
  let passed: string[] = [];
  let manifestState: RunEvidence['manifest'] = 'not-expected';
  if (MANIFEST_WORKFLOWS.has(workflowFile(run))) {
    const got = await (opts.manifest ?? (r => fetchArtifactJson(client, r.id, MANIFEST_ARTIFACT, MANIFEST_FILE)))(run);
    const checked = got.value === undefined ? { problem: got.reason ?? 'the manifest could not be read' } : checkManifest(got.value, { sha: run.head_sha, run_id: run.id, run_attempt: run.run_attempt });
    if (checked.manifest) {
      manifestState = 'read';
      const m: CiManifest = checked.manifest;
      if (!m.complete) problems.push(`the ${MANIFEST_ARTIFACT} artifact is incomplete: ${m.problems.slice(0, 3).map(p => inert(p, 160)).join('; ')}${m.problems.length > 3 ? ` (+${m.problems.length - 3} more)` : ''}`);
      for (const f of m.failures) {
        if (!TEST_FILE.test(f.file)) continue;
        tests.push({ file: f.file, test: inert(f.test, 300), lane: inert(f.lane, 60), arm: inert(f.arm, 60), postgres: POSTGRES_SIGNAL.test(`${f.arm} ${f.lane}`), ...(f.signature && f.test.length <= 500 ? { name: f.test, signature: f.signature.slice(0, 200) } : {}) });
      }
      passed = [...passedFiles(m)].filter(f => TEST_FILE.test(f)).sort();
    } else {
      manifestState = 'unreadable';
      problems.push(`${checked.problem}`);
    }
  }
  for (const job of failed) {
    const postgres = POSTGRES_SIGNAL.test(`${job.job} ${job.excerpt.join(' ')}`);
    for (const file of job.files) {
      if (!tests.some(t => t.file === file)) tests.push({ file, test: '', lane: '', arm: '', job: job.job, postgres });
    }
  }
  const files = [...new Set([...tests.map(t => t.file), ...failed.flatMap(j => j.files)])].sort();
  const verdict = verdictOf(run.conclusion) === 'red' && !failed.length && cancelled.length ? 'ignored' : verdictOf(run.conclusion);
  return {
    verdict,
    jobs,
    cancelled,
    annotations: byJob,
    failed,
    succeeded: jobs.filter(j => j.conclusion === 'success').map(j => inert(j.name)),
    tests,
    files,
    passed,
    manifest: manifestState,
    complete: problems.length === 0,
    problems,
  };
}
