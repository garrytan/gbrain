/**
 * Master-red incidents (green master wave, Lane 4 + E4): one `master-red`
 * issue per workflow (Test, E2E Tests) for push-to-master runs only;
 * scheduled runs stay in nightly-red (scripts/nightly-issue.ts).
 *
 * Reconciliation: every watch reads the completed push-to-master runs of its
 * workflow and evaluates, in (run_number, run_attempt) order, every run above
 * the high-water mark stored in the JSON block of the newest master-red issue
 * of that workflow (open or closed). A dropped watch therefore loses nothing,
 * an out-of-order completion is ignored, a successful re-run is a newer
 * attempt, and a run cancelled by a newer push changes no state. A missing or
 * malformed block is rebuilt from the actions API (fold from the last green
 * run before the newest red one), never guessed.
 *
 * Open on red (suspect range: last green push SHA -> first red SHA plus the
 * PRs merged in it), update while red, close on a green run where every
 * previously failing job ran and passed with complete evidence (E2E Tests
 * also needs every previously failing test file among the files that run
 * executed and passed; the scheduled full run or an issue-bound replay also
 * satisfies it). A failing job that has not run since keeps the issue open
 * with the manual-close next step. Closing without a merged repair PR linked
 * opens one `flake` issue per previously failing test; a flake closes after
 * its repair PR merged and a later complete run passed that test's file and
 * arm (platform-only flakes: the job that failed passed).
 *
 * Writes are compare-and-retry: before the first write the issue is re-read,
 * and the plan is recomputed when its updated_at or high-water mark moved.
 * Docs: docs/RELEASING.md#master-red-issues, docs/ci-red-runbook.md#ci-issue-labels.
 */
import {
  commentIssue, createIssue, ensureLabel, getIssue, inert, inertBlock, jsonBlock, linkedPulls, listLabeled, readJsonBlock, updateIssue,
  type GitHubClient, type Issue,
} from './gh-issue.ts';
import { collectEvidence, EXEMPTION_DAYS, EXEMPTION_MARKER, exemptionRows, plusDays, reproduceCommand, stressBackend, verdictOf, workflowFile, type EvidenceOptions, type FailedJob, type FailedTest, type RunEvidence, type RunInfo } from './ci-run.ts';

export const MR_LABEL = 'master-red';
export const FLAKE_LABEL = 'flake';
export const MR_MARKER = 'master-red:json';
export const FLAKE_MARKER = 'flake:json';
export const MR_SCHEMA = 'master-red/v1';
export const FLAKE_SCHEMA = 'flake/v1';
export const MR_DOCS = 'docs/RELEASING.md#master-red-issues';
export const FLAKE_DOCS = 'docs/ci-red-runbook.md#flake-issues';
export const PUSH_ALLOWLIST: Record<string, string> = { Test: 'test.yml', 'E2E Tests': 'e2e.yml' };
export const MAX_FOLD = 30;
export const MAX_FLAKES_PER_CLOSE = 10;
export const MAX_PR_LOOKUPS = 40;
export const FLAKE_EXPIRY_DAYS = 14;
const RETRIES = 3;

export interface RunRef { run_id: number; run_number: number; run_attempt: number; sha: string }
export interface Suspect { from_sha: string | null; to_sha: string; prs: number[]; complete: boolean; note: string }
export interface MasterRedState {
  schema: typeof MR_SCHEMA;
  workflow: string;
  workflow_file: string;
  evaluated: RunRef | null;
  status: 'red' | 'green';
  first_red: RunRef | null;
  latest_red: RunRef | null;
  last_green: RunRef | null;
  suspect: Suspect | null;
  open_jobs: FailedJob[];
  open_files: string[];
  failed_jobs: FailedJob[];
  tests: FailedTest[];
  evidence: { run_id: number; complete: boolean; problems: string[] } | null;
  blocked: string[];
  /** Expiry of the stress-gate exemption records this issue carries (14 days after the watcher last saw it red). */
  exemption_expires?: string;
  rebuilt?: string;
}
export interface FlakeRecord {
  schema: typeof FLAKE_SCHEMA;
  workflow: string;
  file: string;
  test: string;
  lane: string;
  arm: string;
  platform: 'linux' | 'windows' | 'macos';
  backend: string;
  job: string;
  signature: string;
  first_seen: RunRef;
  master_red_issue: number;
  owner: string;
  opened: string;
  expires: string;
  reproduce: string | null;
}
export interface MasterRedStep {
  action: 'create' | 'update' | 'close' | 'record-closed';
  issue?: number;
  state: MasterRedState;
  comment?: string;
  flakes: Array<{ title: string; body: string; record: FlakeRecord }>;
}
export interface MasterRedPlan {
  /** Summary of the last step ('none' when nothing is written). */
  action: MasterRedStep['action'] | 'none';
  title: string;
  issue?: number;
  body?: string;
  comment?: string;
  state: MasterRedState;
  steps: MasterRedStep[];
  evaluated: number[];
  flakes: MasterRedStep['flakes'];
  reason: string;
  /** Evidence of the triggering run when this watch evaluated it (not persisted). */
  evidence?: RunEvidence;
}

const refOf = (run: RunInfo): RunRef => ({ run_id: run.id, run_number: run.run_number, run_attempt: run.run_attempt, sha: run.head_sha });
const order = (a: Pick<RunRef, 'run_number' | 'run_attempt'>, b: Pick<RunRef, 'run_number' | 'run_attempt'>) => a.run_number - b.run_number || a.run_attempt - b.run_attempt;
const runUrl = (repo: string, id: number) => `https://github.com/${repo}/actions/runs/${id}`;
const testKey = (t: Pick<FailedTest, 'file' | 'test' | 'arm'>) => `${t.file}\u001f${t.test}\u001f${t.arm}`;
export const masterRedTitle = (workflow: string) => `Master red: ${inert(workflow, 100)}`;
const isE2E = (state: Pick<MasterRedState, 'workflow_file'>) => state.workflow_file === 'e2e.yml';

export function blankState(run: RunInfo): MasterRedState {
  return {
    schema: MR_SCHEMA, workflow: inert(run.name, 100), workflow_file: workflowFile(run), evaluated: null, status: 'green',
    first_red: null, latest_red: null, last_green: null, suspect: null, open_jobs: [], open_files: [], failed_jobs: [], tests: [], evidence: null, blocked: [],
  };
}

export function validState(value: unknown, workflowFileName: string): MasterRedState | undefined {
  const s = value as Partial<MasterRedState> | undefined;
  if (!s || s.schema !== MR_SCHEMA || s.workflow_file !== workflowFileName) return undefined;
  if (!Array.isArray(s.open_jobs) || !Array.isArray(s.open_files) || !Array.isArray(s.tests) || (s.status !== 'red' && s.status !== 'green')) return undefined;
  if (s.evaluated !== null && (typeof s.evaluated?.run_number !== 'number' || typeof s.evaluated?.run_attempt !== 'number')) return undefined;
  return { blocked: [], failed_jobs: [], ...s } as MasterRedState;
}

/** Clear what this evidence proves passed; returns the names still open. Incomplete evidence clears nothing. */
function clear(state: MasterRedState, ev: RunEvidence): void {
  if (!ev.complete) return;
  state.open_jobs = state.open_jobs.filter(j => !ev.succeeded.includes(j.job));
  if (isE2E(state)) state.open_files = state.open_files.filter(f => !ev.passed.includes(f));
}

/** Fold one evaluated run into the incident state (pure). */
export function applyRun(prev: MasterRedState, run: RunInfo, ev: RunEvidence): MasterRedState {
  const state: MasterRedState = structuredClone(prev);
  const ref = refOf(run);
  state.evaluated = ref;
  if (ev.verdict === 'ignored') return state;
  state.evidence = { run_id: run.id, complete: ev.complete, problems: ev.problems };
  if (ev.verdict === 'red') {
    if (state.status !== 'red') {
      state.status = 'red';
      state.first_red = ref;
      state.suspect = { from_sha: state.last_green?.sha ?? null, to_sha: run.head_sha, prs: [], complete: false, note: 'not looked up yet' };
      state.open_jobs = [];
      state.open_files = [];
      state.failed_jobs = [];
      state.tests = [];
    }
    state.latest_red = ref;
    clear(state, ev);
    for (const job of ev.failed) {
      state.open_jobs = [...state.open_jobs.filter(j => j.job !== job.job), job];
      state.failed_jobs = [...state.failed_jobs.filter(j => j.job !== job.job), job];
    }
    if (isE2E(state)) state.open_files = [...new Set([...state.open_files, ...ev.files])].sort();
    const seen = new Set(state.tests.map(testKey));
    for (const t of ev.tests) if (!seen.has(testKey(t))) { state.tests.push(t); seen.add(testKey(t)); }
    state.blocked = [];
    return state;
  }
  if (state.status === 'red') {
    clear(state, ev);
    if (state.open_jobs.length || state.open_files.length) {
      state.blocked = [...state.open_jobs.map(j => j.job), ...state.open_files];
      return state;
    }
    state.status = 'green';
    state.blocked = [];
  }
  state.last_green = ref;
  return state;
}

/** A scheduled full run or an issue-bound replay that ran at or after the latest red SHA (pure). */
export function applyExternalPass(prev: MasterRedState, ev: RunEvidence): MasterRedState {
  const state: MasterRedState = structuredClone(prev);
  if (state.status !== 'red' || ev.verdict !== 'green') return state;
  clear(state, ev);
  if (!state.open_jobs.length && !state.open_files.length) {
    state.status = 'green';
    state.blocked = [];
  } else {
    state.blocked = [...state.open_jobs.map(j => j.job), ...state.open_files];
  }
  return state;
}

export async function suspectRange(client: GitHubClient, from: string | null, to: string): Promise<Suspect> {
  if (!from) return { from_sha: null, to_sha: to, prs: [], complete: false, note: 'no green push run of this workflow was found before the first red run' };
  try {
    const cmp = await client.request<{ commits: Array<{ sha: string }>; total_commits: number }>('GET', `repos/{repo}/compare/${from}...${to}`);
    const shas = cmp.commits.map(c => c.sha);
    const prs = new Set<number>();
    for (const sha of shas.slice(-MAX_PR_LOOKUPS)) {
      const pulls = await client.request<Array<{ number: number; merged_at: string | null; base?: { ref: string } }>>('GET', `repos/{repo}/commits/${sha}/pulls`);
      for (const p of pulls) if (p.merged_at && (!p.base || p.base.ref === 'master')) prs.add(p.number);
    }
    const complete = cmp.total_commits === shas.length && shas.length <= MAX_PR_LOOKUPS;
    return {
      from_sha: from, to_sha: to, prs: [...prs].sort((a, b) => a - b), complete,
      note: complete ? `${shas.length} commit(s) in range` : `${cmp.total_commits} commits in range; PRs looked up for the newest ${Math.min(shas.length, MAX_PR_LOOKUPS)}`,
    };
  } catch (e) {
    return { from_sha: from, to_sha: to, prs: [], complete: false, note: `compare or commit-to-PR lookup failed (${inert(e instanceof Error ? e.message : String(e), 120)})` };
  }
}

function filesList(state: MasterRedState): string[] {
  const lines: string[] = [];
  const byFile = new Map<string, FailedTest[]>();
  for (const t of state.tests) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
  for (const [file, tests] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    const repro = reproduceCommand(file, tests.some(t => t.postgres));
    const names = tests.filter(t => t.test).map(t => `\`${inert(t.test, 160)}\`${t.arm ? ` [${inert(t.arm, 40)}]` : ''}`);
    const open = isE2E(state) ? (state.open_files.includes(file) ? ' (not yet passed since)' : ' (passed since)') : '';
    lines.push(`- \`${file}\`${open}: ${names.length ? names.join(', ') : 'failing (test names in the job log)'}; reproduce: ${repro ? `\`${repro}\`` : '(path failed validation; read the job log)'}`);
  }
  return lines;
}

function nextStep(state: MasterRedState, repo: string, issue: number | undefined): string {
  const ref = issue ? `#${issue}` : 'this issue';
  if (state.status === 'green') return 'None: every previously failing job ran and passed on a later run.';
  const lines: string[] = [];
  const owner = state.open_jobs.filter(j => j.owner_signal);
  if (owner.length && owner.length === state.open_jobs.length) {
    lines.push(`**Owner action (not a code fix).** A setting only the repository owner can change is missing (see the errors above, e.g. an empty secret). Ask the owner to apply the named fix; the next green push run closes ${ref}.`);
  } else {
    lines.push(`**Repair PR.** Read the failing log (\`gh run view ${state.latest_red?.run_id ?? state.evaluated?.run_id} --log-failed\`), reproduce each failing file with its command above, find the cause in the suspect range, and open a repair PR whose body says \`Fixes ${ref}\`. Ask Garry to fast-track it. A \`.github/nightly-known-red.tsv\` row is not a response: known-red rows never apply to push runs.`);
    if (owner.length) lines.push(`Also an **owner action** for ${owner.map(j => `\`${j.job}\``).join(', ')}: ask the repository owner to apply the fix its error names.`);
  }
  if (state.blocked.length) {
    lines.push(`**Not run since:** ${state.blocked.map(b => `\`${inert(b, 160)}\``).join(', ')} failed and has not run and passed on a later run with complete evidence, so ${ref} stays open. `
      + `If a job was renamed or removed, close ${ref} by hand with a comment naming its replacement. `
      + (isE2E(state) ? `For an E2E file the selection skipped, dispatch a replay: \`gh workflow run e2e.yml --ref master -f full_corpus=true\`, then \`gh workflow run nightly-watch.yml -f run_id=<that run id> -f replay_issue=${issue ?? '<this issue>'}\`; the nightly scheduled run also counts.`
        : 'The next push run or the nightly scheduled run that runs it closes this issue.'));
  }
  if (state.evidence && !state.evidence.complete) {
    lines.push(`**Incomplete evidence** for run ${runUrl(repo, state.evidence.run_id)}: ${state.evidence.problems.map(p => inert(p, 200)).join('; ')}. Nothing was cleared from that run. Re-check after the next push run, or re-evaluate a run with \`gh workflow run nightly-watch.yml -f run_id=<run id>\`. Docs: docs/ci-red-runbook.md#ci-failure-manifest`);
  }
  lines.push(`Owner: the agent on release duty; first response (a comment or a linked repair PR) within 1 hour, measured by CI health, not enforced. Docs: ${MR_DOCS}`);
  return lines.join('\n\n');
}

export function renderMasterRed(state: MasterRedState, repo: string, issue?: number): string {
  const s = state.suspect;
  const short = (sha: string | null | undefined) => (sha ? `\`${sha.slice(0, 12)}\`` : 'unknown');
  const lines = [
    `Workflow **${state.workflow}** (\`.github/workflows/${state.workflow_file}\`) on master push runs — state: **${state.status}**. Scheduled runs report in \`nightly-red\` issues.`,
    '',
    `- Latest evaluated run: ${state.evaluated ? `${runUrl(repo, state.evaluated.run_id)} (run ${state.evaluated.run_number}, attempt ${state.evaluated.run_attempt}, ${short(state.evaluated.sha)})` : 'none'}`,
    `- First red run: ${state.first_red ? `${runUrl(repo, state.first_red.run_id)} (${short(state.first_red.sha)})` : 'unknown'}`,
    `- Suspect range: last green ${short(s?.from_sha)} → first red ${short(s?.to_sha)}${s?.from_sha ? ` (https://github.com/${repo}/compare/${s.from_sha}...${s.to_sha})` : ''}; PRs merged in range: ${s?.prs.length ? s.prs.map(n => `#${n}`).join(', ') : 'none found'} (${s ? inert(s.note, 200) : 'not computed'}${s && !s.complete ? '; partial' : ''})`,
    `- Re-check: \`gh workflow run nightly-watch.yml -f run_id=${state.evaluated?.run_id ?? '<run id>'}\``,
    ...(state.rebuilt ? [`- State rebuilt from the actions API: ${inert(state.rebuilt, 200)}`] : []),
    '',
  ];
  if (state.open_jobs.length) {
    lines.push('| failing job | step | result | test files |', '|---|---|---|---|');
    for (const j of state.open_jobs) lines.push(`| \`${j.job}\` | \`${j.step}\` | ${j.conclusion} | ${j.files.length ? j.files.map(f => `\`${f}\``).join(', ') : '—'} |`);
    lines.push('');
  }
  if (state.tests.length) {
    lines.push(`<details><summary>Every failing test file this incident (${new Set(state.tests.map(t => t.file)).size})</summary>`, '', ...filesList(state), '', '</details>', '');
  }
  for (const j of state.open_jobs.filter(x => x.excerpt.length)) lines.push(`Errors in \`${j.job}\` (sanitized excerpts):`, '~~~text', inertBlock(j.excerpt.join('\n')), '~~~', '');
  const rows = state.status === 'red' && state.exemption_expires ? exemptionRows(state.tests, state.exemption_expires) : [];
  if (rows.length) {
    lines.push(`Stress-gate exemption records (${rows.length}): a PR's stress gate does not count a failure that matches one of these exactly (file, test name, backend, signature) until ${state.exemption_expires}; any other failure still fails. Docs: ${FLAKE_DOCS}`, '', jsonBlock(EXEMPTION_MARKER, rows), '');
  }
  lines.push('### Next step for the agent', '', nextStep(state, repo, issue), '', jsonBlock(MR_MARKER, state), '');
  return lines.join('\n');
}

export function flakeFor(state: MasterRedState, t: FailedTest, issue: number, today: string): { title: string; body: string; record: FlakeRecord } {
  const job = state.failed_jobs.find(j => (t.job ? j.job === t.job : j.files.includes(t.file))) ?? state.failed_jobs[0];
  const jobName = t.job ?? job?.job ?? '';
  const platform: FlakeRecord['platform'] = /windows/i.test(jobName) ? 'windows' : /macos|darwin/i.test(jobName) ? 'macos' : 'linux';
  const expires = new Date(Date.parse(`${today}T00:00:00Z`) + FLAKE_EXPIRY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const reproduce = reproduceCommand(t.file, t.postgres) ?? null;
  const record: FlakeRecord = {
    schema: FLAKE_SCHEMA, workflow: state.workflow, file: t.file, test: t.test, lane: t.lane, arm: t.arm, platform, backend: stressBackend(t), job: jobName,
    signature: t.signature ?? inert(job?.excerpt[0] ?? '', 200), first_seen: state.first_red!, master_red_issue: issue,
    owner: 'agent on release duty', opened: today, expires, reproduce,
  };
  const title = `Flake: ${inert(`${t.file}${t.test ? ` › ${t.test}` : ''}`, 200)}`;
  const owner = /runner|no space left|lost communication|secret/i.test(record.signature);
  const body = [
    `\`${t.file}\`${t.test ? ` › \`${inert(t.test, 200)}\`` : ''}${t.arm ? ` [${inert(t.arm, 40)}]` : ''} failed on master (${state.workflow}, first seen in https://github.com/{repo}/actions/runs/${record.first_seen.run_id}) and passed later without a repair PR, so master-red #${issue} closed on green. The failure is intermittent.`,
    '',
    `- Reproduce: ${reproduce ? `\`${reproduce}\`` : '(path failed validation; read the job log)'}`,
    `- Failure signature: ${record.signature ? `\`${record.signature}\`` : 'see the master-red issue'}`,
    `- Owner: ${record.owner}; review by ${expires}.`,
    '',
    '### Next step for the agent',
    '',
    owner
      ? '**Owner action (not a code fix).** The signature names a runner, disk or secret problem: ask the repository owner to fix the runner or setting, then close this issue with the evidence.'
      : `**Root-cause it.** Run the reproduce command until it fails, find the race, and open a repair PR whose body says \`Fixes #<this issue>\`. Never widen a timeout or weaken an assertion. This issue closes after that PR merges and the next complete run passes this test's file and arm${platform === 'linux' ? '' : ` (the \`${inert(jobName, 80)}\` job passes)`}.`,
    '',
    `Docs: ${FLAKE_DOCS}`,
    '',
    ...(() => { const rows = exemptionRows([t], expires); return rows.length ? [jsonBlock(EXEMPTION_MARKER, rows), ''] : []; })(),
    jsonBlock(FLAKE_MARKER, record),
    '',
  ].join('\n');
  return { title, body, record };
}

export interface ReconcileOptions extends EvidenceOptions { dryRun: boolean; today: string; triggering?: RunInfo }

/** The open incident issue (the oldest open one wins a create race), else the newest closed issue that carries the state block. */
async function newestIssue(client: GitHubClient, title: string): Promise<Issue | undefined> {
  const mine = (await listLabeled(client, MR_LABEL, 'all')).filter(i => i.title === title);
  return mine.filter(i => i.state === 'open').sort((a, b) => a.number - b.number)[0] ?? mine.find(i => (i.body ?? '').includes(`<!-- ${MR_MARKER} -->`)) ?? mine[0];
}

class CreateRace extends Error {}

async function pushRuns(client: GitHubClient, run: RunInfo): Promise<RunInfo[]> {
  const r = await client.request<{ workflow_runs: RunInfo[] }>('GET', `repos/{repo}/actions/workflows/${run.workflow_id}/runs?event=push&branch=master&per_page=100`);
  const runs = r.workflow_runs.filter(x => x.event === 'push' && x.head_branch === 'master' && x.status === 'completed');
  const listed = runs.findIndex(x => x.id === run.id);
  if (run.event === 'push' && run.head_branch === 'master' && run.status === 'completed') {
    if (listed < 0) runs.push(run);
    else if (runs[listed]!.run_attempt < run.run_attempt) runs[listed] = run;
  }
  return runs.sort((a, b) => order(a, b));
}

/** Pending runs above the high-water mark, or a rebuilt base state plus its pending runs. */
/** `bootstrap` (no master-red issue exists yet): a past incident that already ended green is not recorded; only a still-red one opens. */
export function pendingRuns(state: MasterRedState | undefined, runs: RunInfo[], blank: MasterRedState, rebuildReason: string, bootstrap = false): { state: MasterRedState; pending: RunInfo[] } {
  const sorted = [...runs].sort((a, b) => order(a, b));
  if (state) return { state, pending: sorted.filter(r => !state.evaluated || order(r, state.evaluated) > 0) };
  const counted = sorted.filter(r => verdictOf(r.conclusion) !== 'ignored');
  const lastRed = counted.map(r => verdictOf(r.conclusion)).lastIndexOf('red');
  if (lastRed < 0 || (bootstrap && verdictOf(counted.at(-1)!.conclusion) === 'green')) {
    const newest = counted.at(-1);
    return { state: { ...blank, evaluated: newest ? refOf(newest) : null, last_green: newest ? refOf(newest) : null, rebuilt: rebuildReason }, pending: [] };
  }
  const green = counted.slice(0, lastRed).map(r => verdictOf(r.conclusion)).lastIndexOf('green');
  if (green < 0) return { state: { ...blank, rebuilt: `${rebuildReason}; no green run among the ${runs.length} newest, so the first red run may be older` }, pending: sorted };
  const g = counted[green]!;
  return { state: { ...blank, evaluated: refOf(g), last_green: refOf(g), rebuilt: rebuildReason }, pending: sorted.filter(r => order(r, g) > 0) };
}

function failingKey(state: MasterRedState): string {
  return [...state.open_jobs.map(j => `${j.job}>${j.step}`), ...state.open_files, ...state.tests.map(testKey)].sort().join('\n');
}

export async function planMasterRed(client: GitHubClient, repo: string, run: RunInfo, opts: ReconcileOptions, cache = new Map<number, RunEvidence>()): Promise<{ plan: MasterRedPlan; issue?: Issue }> {
  const title = masterRedTitle(run.name);
  const issue = await newestIssue(client, title);
  const blank = blankState(run);
  const stored = issue ? validState(readJsonBlock(issue.body, MR_MARKER), blank.workflow_file) : undefined;
  const reason = !issue ? 'no master-red issue for this workflow yet' : 'the JSON block of the newest master-red issue was missing or malformed';
  const runs = await pushRuns(client, run);
  const { state: base, pending } = pendingRuns(stored, runs, blank, reason, !issue);
  let state = base;
  const evaluated: number[] = [];
  const closed: MasterRedState[] = [];
  const counted = pending.filter(r => verdictOf(r.conclusion) !== 'ignored');
  const window = counted.slice(-MAX_FOLD);
  if (counted.length > window.length) state.rebuilt = `${counted.length - window.length} older unevaluated run(s) were not read (more than ${MAX_FOLD} pending)`;
  for (const r of window) {
    const key = r.id * 1000 + r.run_attempt;
    const ev = cache.get(key) ?? await collectEvidence(client, r, opts);
    cache.set(key, ev);
    const before = state.status;
    state = applyRun(state, r, ev);
    if (before === 'red' && state.status === 'green') closed.push(state);
    evaluated.push(r.id);
  }
  for (const s of [...closed, state]) {
    if (s.first_red && s.suspect?.note === 'not looked up yet') s.suspect = await suspectRange(client, s.suspect.from_sha, s.suspect.to_sha);
  }
  if (state.status === 'red' && evaluated.length) state.exemption_expires = plusDays(opts.today, EXEMPTION_DAYS);
  const plan = decide(stored, state, closed, issue, repo, title, evaluated, opts.today);
  plan.evidence = cache.get(run.id * 1000 + run.run_attempt);
  return { plan, issue };
}

function changeComment(prev: MasterRedState | undefined, state: MasterRedState, repo: string): string | undefined {
  const latest = state.evaluated ? runUrl(repo, state.evaluated.run_id) : 'the latest run';
  if (!prev || failingKey(prev) !== failingKey(state)) return `Failing set changed (latest run ${latest}); the body has every failing job, test file and reproduce command.`;
  if (state.blocked.length && state.blocked.join('\n') !== (prev.blocked ?? []).join('\n')) {
    return `Run ${latest} is green, but ${state.blocked.map(b => `\`${inert(b, 120)}\``).join(', ')} has not run and passed since it failed. Keeping this open; see "Not run since" in the body.`;
  }
  if (state.evidence && !state.evidence.complete && state.evidence.run_id !== prev.evidence?.run_id) return `Run ${runUrl(repo, state.evidence.run_id)} has incomplete evidence, so nothing was cleared from it (see the body).`;
  return undefined;
}

function closeComment(state: MasterRedState, repo: string, dropped: boolean): string {
  const g = state.last_green!;
  return `Green: ${runUrl(repo, g.run_id)} (run ${g.run_number}, attempt ${g.run_attempt}) passed and every previously failing job${isE2E(state) ? ' and test file' : ''} ran and passed with complete evidence. Closing.`
    + (dropped ? ' This incident started and ended between two watches (the red run\'s own watch was dropped or superseded), so it is recorded here for its suspect range and flake follow-up.' : '');
}

function decide(prev: MasterRedState | undefined, state: MasterRedState, closed: MasterRedState[], issue: Issue | undefined, repo: string, title: string, evaluated: number[], today: string): MasterRedPlan {
  let open = issue?.state === 'open' ? issue : undefined;
  const steps: MasterRedStep[] = [];
  const flakesOf = (s: MasterRedState, n: number | undefined) => s.tests.slice(0, MAX_FLAKES_PER_CLOSE).map(t => flakeFor(s, t, n ?? 0, today));
  for (const c of closed) {
    if (open) {
      steps.push({ action: 'close', issue: open.number, state: c, comment: closeComment(c, repo, false), flakes: flakesOf(c, open.number) });
      open = undefined;
    } else {
      steps.push({ action: 'record-closed', state: c, comment: closeComment(c, repo, true), flakes: flakesOf(c, undefined) });
    }
  }
  const last = closed.at(-1);
  if (state.status === 'red') {
    if (open) {
      if (evaluated.length || !prev) steps.push({ action: 'update', issue: open.number, state, comment: changeComment(prev?.status === 'red' ? prev : undefined, state, repo), flakes: [] });
    } else {
      steps.push({ action: 'create', state, flakes: [] });
    }
  } else if (!closed.length && issue && (evaluated.length || !prev)) {
    steps.push({ action: 'update', issue: issue.number, state, flakes: [] });
  } else if (last && last !== state) {
    steps[steps.length - 1]!.state = state;
  }
  const final = steps.at(-1);
  const reason = !final ? (issue ? 'no unevaluated push runs' : 'green and no master-red issue')
    : final.action === 'create' ? `new master-red incident (first red run ${state.first_red?.run_id})`
      : final.action === 'close' ? 'green and every previously failing job passed'
        : final.action === 'record-closed' ? 'an incident opened and closed between watches'
          : state.status === 'red' ? (state.blocked.length ? 'green but failing jobs not re-run' : 'still red') : 'green; high-water mark recorded on the newest issue';
  return {
    action: final?.action ?? 'none', title, issue: final?.issue, steps, state, evaluated, reason,
    body: final ? renderMasterRed(final.state, repo, final.issue) : undefined, comment: final?.comment, flakes: steps.flatMap(st => st.flakes),
  };
}

/** Re-read before writing; true when the issue moved since it was planned. */
async function moved(client: GitHubClient, title: string, planned: Issue | undefined): Promise<boolean> {
  const fresh = await newestIssue(client, title);
  if (!planned || !fresh) return fresh?.number !== planned?.number;
  const current = fresh.number === planned.number ? await getIssue(client, planned.number) : fresh;
  const hw = (i: Issue) => JSON.stringify(readJsonBlock<MasterRedState>(i.body, MR_MARKER)?.evaluated ?? null);
  return current.number !== planned.number || current.updated_at !== planned.updated_at || hw(current) !== hw(planned) || current.state !== planned.state;
}

export async function openFlakes(client: GitHubClient, repo: string, step: MasterRedStep): Promise<{ opened: number[]; skipped: string[]; note?: string }> {
  if (!step.issue || !step.flakes.length) return { opened: [], skipped: [] };
  let linked;
  try {
    linked = await linkedPulls(client, step.issue);
  } catch (e) {
    return { opened: [], skipped: [], note: `Could not read the PRs linked to #${step.issue} (${inert(e instanceof Error ? e.message : String(e), 120)}), so no flake issue was opened. Check by hand: \`gh api repos/${repo}/issues/${step.issue}/timeline\`. Docs: ${FLAKE_DOCS}` };
  }
  const merged = linked.filter(p => p.merged_at);
  if (merged.length) return { opened: [], skipped: [], note: `Repair PR(s) ${merged.map(p => `#${p.number}`).join(', ')} merged; no flake follow-up.` };
  const existing = (await listLabeled(client, FLAKE_LABEL, 'open')).map(i => readJsonBlock<FlakeRecord>(i.body, FLAKE_MARKER)).filter(Boolean) as FlakeRecord[];
  const have = new Set(existing.map(r => testKey(r)));
  const opened: number[] = [];
  await ensureLabel(client, FLAKE_LABEL, 'd93f0b', 'An intermittent master failure that passed without a repair (nightly-watch)');
  for (const f of step.flakes) {
    if (have.has(testKey(f.record))) continue;
    const record = { ...f.record, master_red_issue: step.issue };
    const body = f.body.replaceAll('{repo}', repo).replace(/master-red #0\b/g, `master-red #${step.issue}`).replace(jsonBlock(FLAKE_MARKER, f.record), jsonBlock(FLAKE_MARKER, record));
    opened.push((await createIssue(client, f.title, body, [FLAKE_LABEL])).number);
    have.add(testKey(f.record));
  }
  const skipped = step.state.tests.slice(MAX_FLAKES_PER_CLOSE).map(t => `${t.file}${t.test ? ` › ${t.test}` : ''}`);
  return { opened, skipped, note: `No merged repair PR is linked, so this closed as intermittent: flake issue(s) ${opened.map(n => `#${n}`).join(', ') || '(already open)'}${skipped.length ? `; ${skipped.length} more failing test(s) were not given their own issue (open them by hand if they recur): ${skipped.slice(0, 10).map(x => `\`${inert(x, 120)}\``).join(', ')}` : ''}. Docs: ${FLAKE_DOCS}` };
}

export async function watchMasterRed(client: GitHubClient, repo: string, run: RunInfo, opts: ReconcileOptions): Promise<MasterRedPlan> {
  const cache = new Map<number, RunEvidence>();
  for (let attempt = 1; ; attempt++) {
    const { plan, issue } = await planMasterRed(client, repo, run, opts, cache);
    if (opts.dryRun || plan.action === 'none') return plan;
    if (await moved(client, plan.title, issue)) {
      if (attempt >= RETRIES) throw new Error(`the master-red issue for ${run.name} kept moving while this watch planned (${RETRIES} attempts); another watch is writing it. Re-check with: gh workflow run nightly-watch.yml -f run_id=${run.id}`);
      continue;
    }
    try {
      await writePlan(client, repo, plan);
    } catch (e) {
      if (!(e instanceof CreateRace) || attempt >= RETRIES) throw e;
      continue;
    }
    return plan;
  }
}

async function writePlan(client: GitHubClient, repo: string, plan: MasterRedPlan): Promise<void> {
  await ensureLabel(client, MR_LABEL, 'b60205', 'A push-to-master run of Test or E2E Tests is red (nightly-watch)');
  for (const step of plan.steps) {
    if (step.action === 'create' || step.action === 'record-closed') {
      step.issue = (await createIssue(client, plan.title, renderMasterRed(step.state, repo), [MR_LABEL])).number;
      const older = step.action === 'create' && (await listLabeled(client, MR_LABEL, 'open')).filter(i => i.title === plan.title && i.number < step.issue!).sort((a, b) => a.number - b.number)[0];
      if (older) {
        await updateIssue(client, step.issue, { body: `Duplicate of #${older.number}: two watches created this incident at the same time; #${older.number} carries the state. Nothing to do here.`, state: 'closed', labels: [] });
        throw new CreateRace(`#${step.issue} duplicated #${older.number}`);
      }
    }
    await updateIssue(client, step.issue!, { body: renderMasterRed(step.state, repo, step.issue) });
    if (step.action === 'update') {
      if (step.comment) await commentIssue(client, step.issue!, step.comment);
      continue;
    }
    if (step.action === 'create') continue;
    const flakes = await openFlakes(client, repo, step);
    await commentIssue(client, step.issue!, [step.comment, flakes.note].filter(Boolean).join('\n\n'));
    await updateIssue(client, step.issue!, { state: 'closed' });
  }
  plan.issue = plan.steps.at(-1)?.issue;
}

/** Close open flake issues whose repair PR merged before this run and whose test this complete run passed. */
export async function closeFlakes(client: GitHubClient, repo: string, run: RunInfo, evidence: RunEvidence | (() => Promise<RunEvidence>), dryRun: boolean): Promise<number[]> {
  const open = (await listLabeled(client, FLAKE_LABEL, 'open')).map(issue => ({ issue, rec: readJsonBlock<FlakeRecord>(issue.body, FLAKE_MARKER) })).filter(x => x.rec?.schema === FLAKE_SCHEMA);
  if (!open.length) return [];
  const ev = typeof evidence === 'function' ? await evidence() : evidence;
  if (!ev.complete || ev.verdict === 'ignored') return [];
  const closed: number[] = [];
  for (const { issue, rec: found } of open) {
    const rec = found!;
    const passed = rec.platform === 'linux'
      ? ev.passed.includes(rec.file) && !ev.tests.some(t => t.file === rec.file && t.arm === rec.arm)
      : ev.succeeded.includes(rec.job);
    if (!passed) continue;
    const pulls = await linkedPulls(client, issue.number).catch(() => []);
    const merged = pulls.find(p => p.merged_at && (!run.created_at || p.merged_at < run.created_at));
    if (!merged) continue;
    closed.push(issue.number);
    if (dryRun) continue;
    await commentIssue(client, issue.number, `Repair PR #${merged.number} merged and ${runUrl(repo, run.id)} (${run.event}, \`${run.head_sha.slice(0, 12)}\`) passed \`${rec.file}\`${rec.arm ? ` [${inert(rec.arm, 40)}]` : ''}${rec.platform === 'linux' ? '' : ` (job \`${inert(rec.job, 80)}\`)`} with complete evidence. Closing.`);
    await updateIssue(client, issue.number, { state: 'closed' });
  }
  return closed;
}

/** Feed a scheduled full run or an issue-bound replay into the open master-red issue of the same workflow. */
export async function externalPass(client: GitHubClient, repo: string, run: RunInfo, ev: RunEvidence, opts: { dryRun: boolean; today: string; issueNumber?: number }): Promise<MasterRedPlan | undefined> {
  const title = masterRedTitle(run.name);
  const issue = opts.issueNumber ? await getIssue(client, opts.issueNumber) : await newestIssue(client, title);
  if (!issue || issue.state !== 'open' || issue.title !== title) return undefined;
  const prev = validState(readJsonBlock(issue.body, MR_MARKER), workflowFile(run));
  if (!prev || prev.status !== 'red' || !prev.latest_red) return undefined;
  const kind = run.event === 'schedule' ? 'scheduled full run' : 'issue-bound replay';
  const plan = (state: MasterRedState, step: MasterRedStep | undefined, reason: string): MasterRedPlan => ({
    action: step?.action ?? 'none', title, issue: issue.number, state, steps: step ? [step] : [], evaluated: [run.id], flakes: step?.flakes ?? [], reason,
    body: step ? renderMasterRed(state, repo, issue.number) : undefined, comment: step?.comment, evidence: ev,
  });
  let contains = false;
  try {
    const cmp = await client.request<{ status: string }>('GET', `repos/{repo}/compare/${prev.latest_red.sha}...${run.head_sha}`);
    contains = cmp.status === 'ahead' || cmp.status === 'identical';
  } catch { contains = false; }
  if (!contains) return plan(prev, undefined, `run ${run.id} does not contain the latest red commit ${prev.latest_red.sha.slice(0, 12)}`);
  const state = applyExternalPass(prev, ev);
  const result = state.status === 'green'
    ? plan(state, { action: 'close', issue: issue.number, state, flakes: prev.tests.slice(0, MAX_FLAKES_PER_CLOSE).map(t => flakeFor(prev, t, issue.number, opts.today)),
      comment: `Green: ${kind} ${runUrl(repo, run.id)} (\`${run.head_sha.slice(0, 12)}\`) ran and passed every previously failing job and test file with complete evidence. Closing.` }, `${kind} cleared every failure`)
    : plan(state, { action: 'update', issue: issue.number, state, flakes: [],
      comment: ev.complete ? `${kind} ${runUrl(repo, run.id)} cleared what it ran; still open: ${state.blocked.map(b => `\`${inert(b, 120)}\``).join(', ')}.`
        : `${kind} ${runUrl(repo, run.id)} has incomplete evidence (${ev.problems.map(p => inert(p, 160)).join('; ')}), so nothing was cleared.` }, `${kind} did not clear every failure`);
  if (!opts.dryRun) await writePlan(client, repo, result);
  return result;
}
