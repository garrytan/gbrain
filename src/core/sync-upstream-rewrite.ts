/**
 * Classic sync's upstream watch (GBRA-133 S-58/S-59). A classic source that
 * syncs with pull fast-forwards to its upstream; after an upstream force-push
 * (or local commits beside a moving upstream) that fast-forward fails on every
 * run. This module tells the cases apart and keeps the answer where doctor and
 * the sync result can read it, without ever blocking the sync (sync-upstream.ts
 * keeps the separate freshness observation in the sources.upstream_* columns):
 *
 *   - `upstream_baseline` (sources.config): the last upstream commit the local
 *     checkout contained, recorded before every fetch and after every pull
 *     that fast-forwarded or was already up to date. Only an upstream commit
 *     that is an ancestor of HEAD is recorded, so a rewritten upstream fetched
 *     by an earlier run never replaces the commit it rewrote.
 *   - `upstream_divergence` (sources.config): set when the pull cannot
 *     fast-forward because HEAD and upstream diverged, cleared by the next pull
 *     that fast-forwards or finds nothing to do. Never a sync-failure ledger
 *     row, so it never gates the bookmark; local HEAD keeps syncing.
 *
 * Codes: `upstream_rewritten` (the baseline is not an ancestor of the new
 * upstream: a force-push removed commits) and `upstream_unknown` (no usable
 * baseline, so a force-push cannot be told from local commits) are fixed by
 * `gbrain sources reset-upstream` after the user agrees (a merge would bring
 * back the commits a force-push removed); `upstream_diverged` (local commits
 * beside an upstream that moved forward normally) is fixed by
 * `gbrain git commit-push --pull`. Nothing is classified while a rebase,
 * merge, cherry-pick or revert is in progress in the checkout.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { cliRenderContext, renderAction, type Action, type RenderedAction } from './agent-output.ts';
import type { BrainEngine } from './engine.ts';
import { GIT_OPERATION_MARKERS } from './git/commit-push.ts';
import { gitChildEnv } from './git-env.ts';
import { GIT_ENV } from './git-transport.ts';
import { execFileSync } from './spawn.ts';

export const UPSTREAM_BASELINE_KEY = 'upstream_baseline';
export const UPSTREAM_DIVERGENCE_KEY = 'upstream_divergence';
export const UPSTREAM_DOCS = 'docs/guides/troubleshooting.md#upstream-rewritten';

export type UpstreamCode = 'upstream_rewritten' | 'upstream_unknown' | 'upstream_diverged';

export interface UpstreamBaseline { sha: string; tracking_ref: string; recorded_at: string }

/** What the checkout looked like when the pull could not fast-forward. */
export interface UpstreamDivergence {
  code: UpstreamCode;
  source_id: string;
  repo: string;
  branch: string | null;
  tracking_ref: string;
  local: string;
  upstream: string;
  /** The recorded baseline (null for upstream_unknown). */
  previous_upstream: string | null;
  first_seen: string;
  observed_at: string;
}

/** An observation as doctor, sync and sources status report it. */
export interface UpstreamDivergenceReport extends UpstreamDivergence { message: string; fix: Action }

/** The classic sync result with the source's standing upstream report. */
export interface UpstreamResultField { upstream?: UpstreamDivergenceReport }

export interface CheckoutUpstream { head: string; upstream: string; tracking_ref: string; branch: string | null }

const READ_ENV: NodeJS.ProcessEnv = { ...GIT_ENV, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

/** Runs git read-only (no optional locks); null when git exits non-zero. */
export function gitRead(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, env: gitChildEnv(READ_ENV) }).toString().trim();
  } catch {
    return null;
  }
}

/** `a` is an ancestor of (or equal to) `b`; null when git cannot tell (a missing object). */
export function isAncestor(root: string, a: string, b: string): boolean | null {
  try {
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', a, b], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, env: gitChildEnv(READ_ENV) });
    return true;
  } catch (e) {
    return (e as { status?: unknown }).status === 1 ? false : null;
  }
}

export function hasCommit(root: string, sha: string): boolean {
  return gitRead(root, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
}

/** HEAD, the branch's upstream commit and tracking ref; null when HEAD is unborn or the branch has no upstream. */
export function readCheckoutUpstream(root: string): CheckoutUpstream | null {
  const head = gitRead(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const trackingRef = gitRead(root, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
  const upstream = trackingRef ? gitRead(root, ['rev-parse', '--verify', '-q', `${trackingRef}^{commit}`]) : null;
  if (!head || !trackingRef || !upstream) return null;
  return { head, upstream, tracking_ref: trackingRef, branch: gitRead(root, ['symbolic-ref', '--short', '-q', 'HEAD']) || null };
}

/** The in-progress git operation marker (rebase-merge, MERGE_HEAD, ...), or null. */
export function gitOperationInProgress(root: string): string | null {
  const paths = gitRead(root, ['rev-parse', ...GIT_OPERATION_MARKERS.flatMap(marker => ['--git-path', marker])])?.split('\n');
  if (!paths) return null;
  return GIT_OPERATION_MARKERS.find((_, i) => paths[i] && existsSync(isAbsolute(paths[i]!) ? paths[i]! : resolve(root, paths[i]!))) ?? null;
}

function parseConfig(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof raw === 'string') try { value = JSON.parse(raw); } catch { value = null; }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readSourceConfig(engine: BrainEngine, sourceId: string): Promise<Record<string, unknown>> {
  const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [sourceId]);
  return parseConfig(row?.config);
}

const asDivergence = (value: unknown): UpstreamDivergence | null =>
  value && typeof value === 'object' && typeof (value as UpstreamDivergence).code === 'string' && typeof (value as UpstreamDivergence).local === 'string'
    ? value as UpstreamDivergence : null;

export async function readUpstreamBaseline(engine: BrainEngine, sourceId: string): Promise<UpstreamBaseline | null> {
  const value = (await readSourceConfig(engine, sourceId))[UPSTREAM_BASELINE_KEY] as UpstreamBaseline | null | undefined;
  return value && typeof value.sha === 'string' ? value : null;
}

/** Record the checkout's upstream commit as the baseline, only when HEAD contains it. */
export async function writeUpstreamBaseline(engine: BrainEngine, sourceId: string, root: string, state: CheckoutUpstream): Promise<void> {
  if (state.upstream !== state.head && isAncestor(root, state.upstream, state.head) !== true) return;
  if ((await readUpstreamBaseline(engine, sourceId))?.sha === state.upstream) return;
  await engine.updateSourceConfig(sourceId, { [UPSTREAM_BASELINE_KEY]: { sha: state.upstream, tracking_ref: state.tracking_ref, recorded_at: new Date().toISOString() } });
}

export async function clearUpstreamDivergence(engine: BrainEngine, sourceId: string): Promise<void> {
  if ((await readSourceConfig(engine, sourceId))[UPSTREAM_DIVERGENCE_KEY]) await engine.updateSourceConfig(sourceId, { [UPSTREAM_DIVERGENCE_KEY]: null });
}

/** Before a classic sync's fetch: remember the upstream commit the checkout already contains. Best effort; never throws. */
export async function recordUpstreamBeforeFetch(engine: BrainEngine, sourceId: string, root: string): Promise<void> {
  try {
    const state = readCheckoutUpstream(root);
    if (state) await writeUpstreamBaseline(engine, sourceId, root, state);
  } catch { /* the watch never blocks a sync */ }
}

/**
 * After a classic sync's pull. A pull that fast-forwarded or was up to date
 * records the new baseline and clears the observation; a failed pull whose
 * HEAD and upstream diverged is classified and stored. Best effort; never throws.
 */
export async function settleUpstreamAfterPull(engine: BrainEngine, sourceId: string, root: string, pulled: boolean): Promise<UpstreamDivergenceReport | null> {
  try {
    if (pulled) {
      const state = readCheckoutUpstream(root);
      if (state) await writeUpstreamBaseline(engine, sourceId, root, state);
      await clearUpstreamDivergence(engine, sourceId);
      return null;
    }
    if (gitOperationInProgress(root)) return null;
    const state = readCheckoutUpstream(root);
    if (!state || isAncestor(root, state.upstream, state.head) !== false || isAncestor(root, state.head, state.upstream) !== false) return null;
    const config = await readSourceConfig(engine, sourceId);
    const baseline = (config[UPSTREAM_BASELINE_KEY] as UpstreamBaseline | null | undefined)?.sha;
    const known = baseline && hasCommit(root, baseline) ? baseline : null;
    const contained = known ? isAncestor(root, known, state.upstream) : null;
    const code: UpstreamCode = contained === true ? 'upstream_diverged' : contained === false ? 'upstream_rewritten' : 'upstream_unknown';
    const prior = asDivergence(config[UPSTREAM_DIVERGENCE_KEY]);
    const now = new Date().toISOString();
    const same = prior && prior.code === code && prior.local === state.head && prior.upstream === state.upstream;
    const observation: UpstreamDivergence = { code, source_id: sourceId, repo: root, branch: state.branch, tracking_ref: state.tracking_ref,
      local: state.head, upstream: state.upstream, previous_upstream: code === 'upstream_unknown' ? null : known, first_seen: same ? prior.first_seen : now, observed_at: now };
    await engine.updateSourceConfig(sourceId, { [UPSTREAM_DIVERGENCE_KEY]: observation });
    return divergenceReport(observation);
  } catch {
    return null;
  }
}

/** The standing upstream reports of the given (or every) non-archived source. */
export async function readUpstreamDivergences(engine: BrainEngine, sourceIds?: string[]): Promise<UpstreamDivergenceReport[]> {
  const rows = await engine.executeRaw<{ id: string; config: unknown }>('SELECT id, config FROM sources WHERE archived IS NOT TRUE ORDER BY id');
  return rows.filter(row => !sourceIds || sourceIds.includes(row.id))
    .map(row => asDivergence(parseConfig(row.config)[UPSTREAM_DIVERGENCE_KEY]))
    .filter((o): o is UpstreamDivergence => o !== null)
    .map(divergenceReport);
}

export async function readUpstreamDivergence(engine: BrainEngine, sourceId: string): Promise<UpstreamDivergenceReport | null> {
  const observation = asDivergence((await readSourceConfig(engine, sourceId))[UPSTREAM_DIVERGENCE_KEY]);
  return observation ? divergenceReport(observation) : null;
}

const short = (sha: string | null) => (sha ?? '').slice(0, 12);

export function divergenceReport(o: UpstreamDivergence): UpstreamDivergenceReport {
  const where = `Source ${o.source_id} (${o.tracking_ref})`;
  const keeps = `Local HEAD ${short(o.local)} keeps syncing; upstream commits are not imported until this is resolved.`;
  const message = o.code === 'upstream_rewritten'
    ? `${where}: the upstream was rewritten (force-pushed): ${short(o.previous_upstream)}, the upstream commit this checkout last contained, is not in the new upstream ${short(o.upstream)}, so the pull cannot fast-forward. ${keeps}`
    : o.code === 'upstream_unknown'
      ? `${where}: local HEAD ${short(o.local)} and upstream ${short(o.upstream)} have diverged and gbrain has no record of the upstream before this fetch, so it cannot tell a force-push from local commits. ${keeps}`
      : `${where}: this checkout has commits that are not on the upstream, and the upstream moved forward to ${short(o.upstream)}, so the pull cannot fast-forward. ${keeps}`;
  return { ...o, message, fix: upstreamFix(o) };
}

const doctorVerify = { argv: ['gbrain', 'doctor', '--only', 'sync_failures', '--json'] };

function followUpSync(o: UpstreamDivergence): Action {
  return { argv: ['gbrain', 'sync', '--source', o.source_id], consent: [], actor: 'agent', requires_exclusive: false, verify: doctorVerify,
    why: 'The next sync pulls the upstream (now a fast-forward or already up to date), imports its commits and clears the upstream report.' };
}

/** The typed next step: a reset bound to the observed commits (ask the user first), or the shared-checkout pull for plain divergence. */
export function upstreamFix(o: UpstreamDivergence): Action {
  if (o.code === 'upstream_diverged') {
    return { argv: ['gbrain', 'git', 'commit-push', '--pull', '--path', o.repo], consent: [], actor: 'agent', requires_exclusive: false, verify: doctorVerify,
      why: 'Brings the upstream commits in beside the local ones (fast-forward or an in-memory merge under the commit lock); nothing is pushed and no commit is dropped.',
      docs: UPSTREAM_DOCS, then: followUpSync(o) };
  }
  const reset = ['gbrain', 'sources', 'reset-upstream', o.source_id, '--expect-local', o.local, '--expect-upstream', o.upstream];
  return {
    ask_user: true, argv: reset, preview_argv: [...reset, '--dry-run'], consent: ['destructive'], actor: 'agent', requires_exclusive: true, verify: doctorVerify, docs: UPSTREAM_DOCS,
    why: o.code === 'upstream_rewritten'
      ? 'A merge would bring back the commits the force-push removed, so the checkout is reset to the new upstream instead; the reset keeps the old history under a backup ref and refuses local commits that were never on the upstream.'
      : 'Without a record of the old upstream gbrain cannot tell whether the local-only commits were removed by a force-push or never pushed; the reset preview names any commit that was never on the upstream before anything moves.',
    user_message: o.code === 'upstream_rewritten'
      ? `The upstream of source ${o.source_id} was force-pushed. Reset the local checkout to the new upstream ${short(o.upstream)}? The current history (${short(o.local)}) is kept under a backup ref.`
      : `Source ${o.source_id}'s checkout and its upstream have diverged and gbrain cannot tell why. Preview resetting it to the upstream ${short(o.upstream)}? The current history is kept under a backup ref.`,
    then: followUpSync(o),
  };
}

/** The wire form for local CLI JSON (sync --json, sources status --json): the fix rendered with its next step and command. */
export function renderUpstreamDivergence(report: UpstreamDivergenceReport): Omit<UpstreamDivergenceReport, 'fix'> & { fix: RenderedAction } {
  return { ...report, fix: renderAction(report.fix, cliRenderContext()) };
}

/** The stderr line a classic sync prints when it records an observation. */
export function formatUpstreamNotice(report: UpstreamDivergenceReport): string {
  return `Warning [${report.code}]: ${report.message} Next${report.fix.ask_user ? ' (ask the user first)' : ''}: ${report.fix.argv!.join(' ')}. See ${UPSTREAM_DOCS}.`;
}
