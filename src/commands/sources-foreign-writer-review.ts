/** `gbrain sources review-foreign-writers`: explicit local containment of reviewed historical commits. */
import type { BrainEngine } from '../core/engine.ts';
import { opError } from '../core/ops/contract.ts';
import { shellQuote } from '../core/agent-output.ts';
import { foreignWritersEntry, type ForeignCommit } from './doctor/checks/foreign-writers.ts';
import type { Check } from './doctor.ts';
import type { DoctorContext } from './doctor/context.ts';
import { ledgerLocation } from '../core/git/commit-ledger.ts';
import { appendForeignWriterReviews, foreignWriterReviewHash, readForeignWriterReviews, type ForeignWriterReview } from './foreign-writer-review.ts';
import { listRegisteredLocalPathSources } from '../core/source-resolver.ts';
import { ownerGuardStatus } from '../core/git/commit-guard.ts';

const USAGE = 'gbrain sources review-foreign-writers <source> --sha <full-sha> [--sha <full-sha> ...] --reason <text> [--apply --expect <plan_hash>] [--json]';
export interface ForeignWriterReviewRequest { sourceId: string; shas: string[]; reason: string; expect?: string }
export interface ForeignWriterReviewPlan { source_id: string; shas: string[]; reason: string; guard: { installed: boolean; mode: string | null; hook: string }; plan_hash: string; apply_command: string }

async function sourcePath(engine: BrainEngine, sourceId: string): Promise<string> {
  const source = (await listRegisteredLocalPathSources(engine)).find(row => row.id === sourceId);
  if (!source?.local_path) throw opError('invalid_params', `Source ${sourceId} has no local checkout to review.`, 'Choose a registered source with a local Git checkout.');
  return source.local_path;
}

async function currentForeign(engine: BrainEngine, sourceId: string): Promise<{ path: string; common: string; foreign: ForeignCommit[] }> {
  const path = await sourcePath(engine, sourceId);
  const location = ledgerLocation(path);
  if (!location) throw opError('git_unavailable', `Source ${sourceId}'s local path is not a readable Git checkout.`, 'Fix the checkout first; no acknowledgement was written.');
  const guard = ownerGuardStatus(path);
  if (!guard.installed || guard.mode !== 'enforce') throw opError('permission_denied', `Source ${sourceId} does not have an active enforce owner guard.`, `Install it first on the owner host: gbrain sources guard ${sourceId} --install --mode enforce. Nothing was written.`);
  const checks = await foreignWritersEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[];
  const check = checks[0];
  const foreign = ((check?.details?.foreign ?? []) as ForeignCommit[]).filter(commit => commit.checkout === guard.worktree);
  return { path, common: location.common, foreign };
}

export async function foreignWriterReviewPlan(engine: BrainEngine, request: ForeignWriterReviewRequest): Promise<ForeignWriterReviewPlan> {
  if (!request.reason.trim()) throw opError('invalid_params', '--reason must say why these historical commits were reviewed.', `Usage: ${USAGE}`);
  const shas = [...new Set(request.shas)];
  if (!shas.length || shas.some(sha => !/^[0-9a-f]{40}$/.test(sha))) throw opError('invalid_params', '--sha takes one or more full 40-character lowercase commit SHAs.', `Usage: ${USAGE}`);
  const { path, common, foreign } = await currentForeign(engine, request.sourceId);
  const known = new Set(foreign.map(commit => commit.sha));
  const unknown = shas.filter(sha => !known.has(sha));
  if (unknown.length) throw opError('invalid_params', `Only currently detected exact foreign commit SHAs can be reviewed; not detected: ${unknown.join(', ')}.`, 'Run gbrain doctor --only foreign_writers --json and copy only the full historical SHAs it reports.');
  const guard = ownerGuardStatus(path);
  const basis = { v: 1, source_id: request.sourceId, shas: [...shas].sort(), reason: request.reason.trim(), common, guard: { hook: guard.hook, mode: guard.mode }, foreign: [...known].sort() };
  const plan_hash = foreignWriterReviewHash(basis);
  return { source_id: request.sourceId, shas: [...shas].sort(), reason: request.reason.trim(), guard: { installed: guard.installed, mode: guard.mode, hook: guard.hook }, plan_hash,
    apply_command: shellQuote(['gbrain', 'sources', 'review-foreign-writers', request.sourceId, ...shas.flatMap(sha => ['--sha', sha]), '--reason', request.reason.trim(), '--apply', '--expect', plan_hash]) };
}

export async function applyForeignWriterReview(engine: BrainEngine, request: ForeignWriterReviewRequest): Promise<ForeignWriterReviewPlan> {
  if (!request.expect) throw opError('invalid_params', '--apply needs --expect <plan_hash> from the preview.', `Preview first: ${USAGE}`);
  const plan = await foreignWriterReviewPlan(engine, request);
  if (plan.plan_hash !== request.expect) throw opError('preview_changed', `The reviewed foreign-commit set, guard, or reason changed since preview (${request.expect} -> ${plan.plan_hash}); nothing was written.`, 'Preview again and use its exact --expect value.');
  const location = ledgerLocation(await sourcePath(engine, request.sourceId))!;
  const existing = new Set(readonlyReviews(location.common, request.sourceId));
  const now = new Date().toISOString();
  const rows: ForeignWriterReview[] = plan.shas.filter(sha => !existing.has(sha)).map(sha => ({ v: 1, e: 'contained', t: now, source_id: request.sourceId, sha, reason: plan.reason }));
  if (rows.length) appendForeignWriterReviews(location.common, rows);
  return plan;
}

function readonlyReviews(common: string, sourceId: string): string[] {
  return readForeignWriterReviews(common).filter(row => row.source_id === sourceId).map(row => row.sha);
}

export async function runForeignWriterReview(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json'); const positional: string[] = []; const shas: string[] = []; let reason = ''; let apply = false; let expect: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--sha') { shas.push(args[++i] ?? ''); continue; }
    if (arg === '--reason') { reason = args[++i] ?? ''; continue; }
    if (arg === '--apply') { apply = true; continue; }
    if (arg === '--expect') { expect = args[++i]; continue; }
    if (arg.startsWith('-')) throw opError('invalid_params', `Unknown flag ${arg}.`, `Usage: ${USAGE}`);
    positional.push(arg);
  }
  if (positional.length !== 1 || (expect && !apply)) throw opError('invalid_params', `Usage: ${USAGE}`, 'Preview first; only --apply writes a separate local review record.');
  const request = { sourceId: positional[0]!, shas, reason, expect };
  const result = apply ? await applyForeignWriterReview(engine, request) : await foreignWriterReviewPlan(engine, request);
  console.log(json ? JSON.stringify({ ...result, applied: apply }) : apply ? `Recorded ${result.shas.length} reviewed historical foreign commit(s) in a separate local audit record. Doctor will keep them visible as warnings while the enforce guard remains active.` : `Preview only. ${result.shas.length} exact historical commit(s); plan_hash ${result.plan_hash}\nApply only after review: ${result.apply_command}`);
}
