/**
 * The upgrade matrix as a condition of stable promotion (stability plan item 3a, GST-2818).
 *
 * A forward promotion names one run of .github/workflows/upgrade-matrix.yml (`matrix_run` in the record and the
 * promote-stable.yml input). judgeMatrixRun() accepts it only when the run is a full-profile gate run (schedule
 * or dispatch, from master's harness, no fault injection) whose receipt (the upgrade-matrix-receipt artifact the
 * summary job writes) names exactly the release being promoted (tag, commit and tree) and was written by that
 * run's own harness, and when the run is green. The one way past a red run is the break path below.
 *
 * The daily check (scripts/stable-daily.ts) also holds stable while the matrix's own break issue is open
 * (ISSUE_MARKER, upgrade-matrix/marker.ts); any other issue with the label holds nothing. A security or data-loss
 * fix may pass an open break when its candidate's run fails only on from-versions that issue names: the break is
 * already known and the fix makes nothing worse elsewhere. Otherwise a maintainer promotes by hand
 * (promote-stable.yml), which the record shows as promoted_by.
 *
 * No dependencies beyond node: stable-daily.yml and promote-stable.yml install none.
 */
import { failingFrom, ISSUE_LABEL, ISSUE_MARKER, parseRedFrom } from './upgrade-matrix/marker.ts';

export const MATRIX_WORKFLOW = '.github/workflows/upgrade-matrix.yml';
export const MATRIX_RECEIPT_ARTIFACT = 'upgrade-matrix-receipt';
export const MATRIX_RECEIPT_SCHEMA = 'gbrain-upgrade-matrix-run/1';
/** The `important:` classes that may pass an open upgrade break (with a run that fails only on the from-versions it names). */
export const BREAK_PASS_CLASSES = ['security', 'data-loss'] as const;

export interface MatrixRunRow {
  id: number;
  status: string | null;
  conclusion: string | null;
  head_sha: string;
  head_branch?: string | null;
  event?: string | null;
  path?: string | null;
  html_url: string;
}

/** The run receipt (scripts/upgrade-matrix.ts buildSummary), as far as promotion reads it. */
export interface MatrixReceipt {
  schema?: string;
  harness?: { sha?: string };
  candidate?: { tag?: string | null; sha?: string; tree?: string };
  profile?: string;
  from?: Array<{ tag: string; roles?: string[] }>;
  skipped?: Array<{ role: string; reason?: string }>;
  status?: string;
  cells?: Array<{ id: string; from: string; verdict: string; fault?: string | null }>;
  red?: string[];
  holds?: string[];
  foreign_receipts?: string[];
}

export interface BreakIssue { number: number; url: string; from: string[] | null }

export type MatrixJudgement = { ok: true; why: string; excused: string[] } | { ok: false; why: string };

const normalise = (p: string) => p.trim().replace(/@.*$/, '').replace(/^\.\//, '');

/** Runs whose receipt can be gate evidence: master's harness, by schedule or dispatch (pull-request runs test their own harness). */
export const isGateRun = (run: MatrixRunRow) => (run.event === 'schedule' || run.event === 'workflow_dispatch') && run.head_branch === 'master';

/** A receipt from a harness that resolves the stable-window role (scripts/upgrade-matrix/versions.ts): it tested or skipped it. Older receipts never tested the stable releases users may still be on. */
const coversStableWindow = (r: MatrixReceipt) =>
  (r.from ?? []).some(f => (f.roles ?? []).includes('stable-window')) || (r.skipped ?? []).some(s => s.role === 'stable-window');

/** Does this receipt test this release as a gate run (full profile with the stable window, no fault injection)? A candidate tag alone picks the run; judgeMatrixRun checks the rest. */
export const receiptNames = (r: MatrixReceipt | null, version: string) =>
  !!r && r.candidate?.tag === `v${version}` && r.profile === 'full' && coversStableWindow(r) && !(r.cells ?? []).some(c => c.fault);

/**
 * Whether a matrix run qualifies the release for stable. `excuse` is the break path: the open break issue's named
 * from-versions, given only for a security or data-loss candidate while that issue is open.
 */
export function judgeMatrixRun(run: MatrixRunRow, receipt: MatrixReceipt | null, release: { version: string; commit: string; tree: string }, excuse?: BreakIssue | null): MatrixJudgement {
  const url = run.html_url;
  if (run.path && normalise(run.path) !== MATRIX_WORKFLOW) return { ok: false, why: `run ${url} ran ${normalise(run.path)}, not the upgrade matrix ${MATRIX_WORKFLOW}` };
  if (!isGateRun(run)) return { ok: false, why: `upgrade matrix run ${url} is a ${run.event ?? 'unknown'} run on ${run.head_branch ?? 'an unknown branch'}; only a schedule or dispatch run of master's harness is gate evidence` };
  if (run.status !== 'completed') return { ok: false, why: `upgrade matrix run ${url} is ${run.status ?? 'in an unknown state'}, not completed` };
  if (!receipt) return { ok: false, why: `upgrade matrix run ${url} has no ${MATRIX_RECEIPT_ARTIFACT} artifact to read` };
  if (receipt.schema !== MATRIX_RECEIPT_SCHEMA) return { ok: false, why: `upgrade matrix run ${url}'s receipt is not a ${MATRIX_RECEIPT_SCHEMA} receipt` };
  if (receipt.harness?.sha !== run.head_sha) return { ok: false, why: `upgrade matrix run ${url}'s receipt names harness ${receipt.harness?.sha ?? 'none'}, not the run's commit ${run.head_sha}` };
  const c = receipt.candidate ?? {};
  if (c.tag !== `v${release.version}` || c.sha !== release.commit || c.tree !== release.tree) {
    return { ok: false, why: `upgrade matrix run ${url} tested ${c.tag ?? 'an untagged commit'} (commit ${c.sha ?? '?'}, tree ${c.tree ?? '?'}), not v${release.version} (commit ${release.commit}, tree ${release.tree})` };
  }
  if (receipt.profile !== 'full') return { ok: false, why: `upgrade matrix run ${url} ran the ${receipt.profile ?? 'unknown'} profile, not the full from-version set` };
  if (!coversStableWindow(receipt)) return { ok: false, why: `upgrade matrix run ${url} predates the stable-window from-versions, so it never tested upgrades from the stable releases users may still be on` };
  if ((receipt.cells ?? []).some(cell => cell.fault)) return { ok: false, why: `upgrade matrix run ${url} injected a fault (a proof run), so it qualifies nothing` };
  if (receipt.status === 'green' && run.conclusion === 'success') return { ok: true, why: `upgrade matrix run ${url} is green on v${release.version}`, excused: [] };
  const failing = failingFrom(receipt);
  const what = `upgrade matrix run ${url} is ${receipt.status ?? run.conclusion ?? 'not green'} on v${release.version}${failing.from.length ? ` (failing from ${failing.from.join(', ')})` : ''}${failing.door ? ' with a failing door' : ''}`;
  if (!excuse) return { ok: false, why: what };
  if (!excuse.from) return { ok: false, why: `${what}, and break issue #${excuse.number} names no from-versions, so nothing is excused` };
  if ((receipt.foreign_receipts ?? []).length || failing.door || failing.from.length === 0) return { ok: false, why: `${what}, which the break issue cannot excuse` };
  const outside = failing.from.filter(f => !excuse.from!.includes(f));
  if (outside.length) return { ok: false, why: `${what}; break issue #${excuse.number} names only ${excuse.from.join(', ')}, so ${outside.join(', ')} is a new break` };
  return { ok: true, why: `${what}, all named by break issue #${excuse.number}`, excused: failing.from };
}

/** The matrix's own open break issue (labelled and carrying ISSUE_MARKER), or null. A labelled issue without the marker holds nothing. */
export function findBreakIssue(issues: unknown): BreakIssue | null {
  const rows = Array.isArray(issues) ? issues as Array<{ number?: number; html_url?: string; body?: string | null; state?: string; pull_request?: unknown }> : [];
  const hit = rows.find(i => !i.pull_request && i.state !== 'closed' && typeof i.number === 'number' && String(i.body ?? '').includes(ISSUE_MARKER));
  return hit ? { number: hit.number!, url: hit.html_url ?? `#${hit.number}`, from: parseRedFrom(String(hit.body ?? '')) } : null;
}

export const breakIssueQuery = (repo: string) => `repos/${repo}/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`;

/** The `important:` class in a changelog.d fragment's front matter, or null. */
export function fragmentImportance(text: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? /^important:\s*([a-z-]+)\s*$/m.exec(m[1]!)?.[1] ?? null : null;
}
