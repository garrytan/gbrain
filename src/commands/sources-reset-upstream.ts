/**
 * `gbrain sources reset-upstream <id> --expect-local <sha> --expect-upstream <sha> [--dry-run] [--json]`
 * (GBRA-133 S-58/S-59): the fix for `upstream_rewritten` and `upstream_unknown`.
 * A classic source whose upstream was force-pushed cannot fast-forward, and
 * merging would bring back the commits the force-push removed, so the checkout
 * is moved to the new upstream instead, after the user agrees.
 *
 * Under the checkout's commit lock (the lock `gbrain git commit-push` and
 * scripts/brain-commit-push.sh take) it refuses a git operation in progress,
 * a HEAD or upstream that moved since the observation (`--expect-local` /
 * `--expect-upstream`), a dirty tracked tree, and local commits that were never
 * on the upstream (not reachable from the new upstream, the recorded upstream
 * baseline or the tracking ref's reflog), naming them and the backup ref it
 * would create. Otherwise it records the old HEAD under
 * `refs/gbrain/backup/<UTC stamp>-<sha>`, runs `git reset --keep <upstream>`,
 * verifies HEAD is the expected upstream, records it as the source's upstream
 * baseline and clears the upstream observation. It never fetches; the next
 * `gbrain sync --source <id>` imports the upstream commits. `--dry-run` runs
 * every check, takes no lock and changes nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Action } from '../core/agent-output.ts';
import type { BrainEngine } from '../core/engine.ts';
import { acquireCommitLock, assertNoOperationInProgress, checkoutRoot } from '../core/git/commit-push.ts';
import { gitChildEnv } from '../core/git-env.ts';
import { GIT_ENV } from '../core/git-transport.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { assertLegacyFilesystemWriter } from '../core/persistence/filesystem-guard.ts';
import { execFileSync } from '../core/spawn.ts';
import {
  clearUpstreamDivergence, gitRead, hasCommit, readCheckoutUpstream, readUpstreamBaseline, writeUpstreamBaseline, UPSTREAM_DOCS,
} from '../core/sync-upstream-rewrite.ts';

const USAGE = 'Usage: gbrain sources reset-upstream <id> --expect-local <sha> --expect-upstream <sha> [--dry-run] [--json]';
const LIST_CAP = 20;
const REFLOG_CAP = 500;

export interface ResetUpstreamReceipt {
  status: 'reset' | 'would_reset' | 'already_at_upstream';
  source_id: string;
  repo: string;
  branch: string | null;
  tracking_ref: string;
  dry_run: boolean;
  from: string;
  to: string;
  /** The ref holding the old HEAD (null when nothing moved). */
  backup_ref: string | null;
  /** Commits that leave the branch (all were on the upstream before it was rewritten), newest first, capped. */
  dropped: string[];
  dropped_count: number;
  next: Action;
}

interface Parsed { id?: string; expectLocal?: string; expectUpstream?: string; dryRun: boolean; json: boolean }

function parse(args: string[]): Parsed {
  const p: Parsed = { dryRun: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (name: string): string => {
      const eq = a.indexOf('=');
      const v = eq !== -1 ? a.slice(eq + 1) : args[++i];
      if (!v) throw new OperationError('invalid_params', `${name} needs a value.`, USAGE);
      return v;
    };
    if (a === '--dry-run') p.dryRun = true;
    else if (a === '--json') p.json = true;
    else if (a === '--expect-local' || a.startsWith('--expect-local=')) p.expectLocal = value('--expect-local');
    else if (a === '--expect-upstream' || a.startsWith('--expect-upstream=')) p.expectUpstream = value('--expect-upstream');
    else if (a.startsWith('-')) throw new OperationError('invalid_params', `Unknown option: ${a}.`, USAGE);
    else if (!p.id) p.id = a;
    else throw new OperationError('invalid_params', 'Name one source.', USAGE);
  }
  if (!p.id || !p.expectLocal || !p.expectUpstream) throw new OperationError('invalid_params', 'reset-upstream needs a source id, --expect-local and --expect-upstream.', USAGE);
  for (const sha of [p.expectLocal, p.expectUpstream]) {
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new OperationError('invalid_params', `${sha} is not a commit sha.`, USAGE);
  }
  return p;
}

const lines = (out: string | null) => (out ? out.split('\n').filter(Boolean) : []);

function refused(reason: 'expect_mismatch' | 'dirty_tree' | 'local_commits' | 'no_upstream', message: string, suggestion: string, fix: Action, detail?: unknown): OperationError {
  return opError('reset_upstream_refused', message, suggestion, { reason, fix, docs: UPSTREAM_DOCS, ...(detail === undefined ? {} : { detail: JSON.stringify(detail) }) });
}

/** Every commit the tracking ref ever pointed at, old and new values of its reflog (a forced fetch logs the rewritten tip as the old value). */
function trackingRefHistory(root: string, trackingRef: string): string[] {
  const path = gitRead(root, ['rev-parse', '--path-format=absolute', '--git-path', `logs/${trackingRef}`]);
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').slice(-REFLOG_CAP).flatMap(line => line.split(' ', 2)).filter(sha => /^[0-9a-f]{40,64}$/.test(sha) && !/^0+$/.test(sha));
}

/** Run the checks and, unless dry-run, the reset; returns the receipt. */
export async function resetUpstream(engine: BrainEngine, opts: { sourceId: string; expectLocal: string; expectUpstream: string; dryRun?: boolean }): Promise<ResetUpstreamReceipt> {
  const { sourceId } = opts;
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1 AND archived IS NOT TRUE', [sourceId]);
  if (!source) throw opError('unknown_source', `Source ${sourceId} is not registered (or is archived).`, 'List the sources with gbrain sources list --json.');
  if (!source.local_path) throw opError('unknown_source', `Source ${sourceId} has no local checkout.`, 'reset-upstream applies to a Git source with a local_path.');
  const root = checkoutRoot(source.local_path);
  await assertLegacyFilesystemWriter(engine, root);
  const preview = ['gbrain', 'sources', 'reset-upstream', sourceId, '--expect-local', opts.expectLocal, '--expect-upstream', opts.expectUpstream, '--dry-run'];
  const sync: Action = { argv: ['gbrain', 'sync', '--source', sourceId], consent: [], actor: 'agent', requires_exclusive: false,
    verify: { argv: ['gbrain', 'doctor', '--only', 'sync_failures', '--json'] },
    why: 'Pulls the upstream (now a fast-forward or up to date) and imports its commits; the upstream report clears.' };
  const lock = opts.dryRun ? null : acquireCommitLock(root);
  try {
    assertNoOperationInProgress(root);
    const state = readCheckoutUpstream(root);
    if (!state) {
      throw refused('no_upstream', `The checkout ${root} has no commit or no upstream branch, so there is nothing to reset to.`,
        'Set the branch upstream (git branch --set-upstream-to <remote>/<branch>), run gbrain sync --source <id>, then follow the doctor fix.', sync);
    }
    const resolved = (sha: string) => gitRead(root, ['rev-parse', '--verify', '-q', `${sha}^{commit}`]);
    if (resolved(opts.expectLocal) !== state.head || resolved(opts.expectUpstream) !== state.upstream) {
      throw refused('expect_mismatch', `The checkout moved since the reset was proposed: HEAD is ${state.head} and ${state.tracking_ref} is ${state.upstream} (expected ${opts.expectLocal} and ${opts.expectUpstream}). Nothing was changed.`,
        'Run gbrain sync --source <id> to observe the checkout again; gbrain doctor --only sync_failures then names the current reset command.', sync,
        { local: state.head, upstream: state.upstream });
    }
    const dirty = lines(gitRead(root, ['diff', '--name-only', 'HEAD', '--']));
    const askAgain: Action = { ask_user: true, consent: [], actor: 'user', requires_exclusive: false, docs: UPSTREAM_DOCS, verify: { argv: preview },
      why: 'Only the user can decide what happens to work that is not on the upstream.' };
    if (dirty.length) {
      const paths = dirty.slice(0, LIST_CAP);
      throw refused('dirty_tree', `The checkout ${root} has uncommitted changes to tracked files (${paths.join(', ')}${dirty.length > LIST_CAP ? `, and ${dirty.length - LIST_CAP} more` : ''}); nothing was changed.`,
        'Commit the edits (gbrain git commit-push -m <msg> -- <paths>) or discard them, then run the same reset-upstream command again.',
        { ...askAgain, user_message: `The checkout of source ${sourceId} has uncommitted edits to ${paths.join(', ')}. Commit or discard them before resetting to the upstream?` }, { paths });
    }
    const baseline = (await readUpstreamBaseline(engine, sourceId))?.sha;
    const published = [...new Set([...(baseline ? [baseline] : []), ...trackingRefHistory(root, state.tracking_ref)])].filter(sha => hasCommit(root, sha));
    const localOnly = lines(gitRead(root, ['rev-list', state.head, '--not', state.upstream, ...published]));
    const backupRef = `refs/gbrain/backup/${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${state.head.slice(0, 12)}`;
    if (localOnly.length) {
      const named = localOnly.slice(0, LIST_CAP).map(sha => gitRead(root, ['log', '-1', '--format=%h %s', sha]) ?? sha.slice(0, 12));
      throw refused('local_commits', `${localOnly.length} local commit(s) were never on the upstream and a reset would drop them: ${named.join('; ')}. Nothing was changed; a reset would keep them under ${backupRef}.`,
        `Push or re-apply them after the reset (git cherry-pick from the backup ref), or, if they should go, back them up and reset by hand: git update-ref ${backupRef} ${state.head} && git reset --keep ${state.upstream}.`,
        { ...askAgain, user_message: `Source ${sourceId}'s checkout has ${localOnly.length} commit(s) that were never pushed (${named.join('; ')}). Keep them (push or re-apply after the reset) or drop them?` },
        { local_commits: localOnly.slice(0, LIST_CAP), backup_ref: backupRef });
    }
    const base = { source_id: sourceId, repo: root, branch: state.branch, tracking_ref: state.tracking_ref, dry_run: !!opts.dryRun, from: state.head, to: state.upstream, next: sync };
    if (state.head === state.upstream) {
      if (!opts.dryRun) await clearUpstreamDivergence(engine, sourceId);
      return { ...base, status: 'already_at_upstream', backup_ref: null, dropped: [], dropped_count: 0 };
    }
    const dropped = lines(gitRead(root, ['rev-list', state.head, '--not', state.upstream]));
    const receipt = { ...base, backup_ref: backupRef, dropped: dropped.slice(0, LIST_CAP), dropped_count: dropped.length };
    if (opts.dryRun) return { ...receipt, status: 'would_reset' };
    const write = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env: gitChildEnv({ ...GIT_ENV, LC_ALL: 'C' }) });
    write(['update-ref', '-m', 'gbrain sources reset-upstream backup', backupRef, state.head, '']);
    try { write(['reset', '--keep', state.upstream]); } catch (e) {
      throw opError('git_unavailable', `git reset --keep ${state.upstream} failed in ${root}: ${String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim().slice(0, 300)}`,
        `The old HEAD is kept under ${backupRef}. Run git status in ${root}, fix what git reports, then rerun the same reset-upstream command.`);
    }
    const after = gitRead(root, ['rev-parse', 'HEAD']);
    if (after !== state.upstream) {
      throw opError('git_unavailable', `After the reset HEAD is ${after ?? 'unreadable'}, not ${state.upstream}.`, `The old HEAD is kept under ${backupRef}. Inspect git status and git log in ${root}.`);
    }
    await writeUpstreamBaseline(engine, sourceId, root, { ...state, head: after });
    await clearUpstreamDivergence(engine, sourceId);
    return { ...receipt, status: 'reset' };
  } finally {
    lock?.release();
  }
}

export async function runResetUpstream(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${USAGE}\n\nAfter an upstream force-push (doctor sync_failures: upstream_rewritten or upstream_unknown): keep the\n`
      + 'current history under refs/gbrain/backup/<stamp>-<sha> and move the checkout to its upstream, under the commit lock.\n'
      + 'Refuses a moved HEAD or upstream, a dirty tree and local commits that were never on the upstream (it names them).\n'
      + `  --dry-run   run every check and print what would happen; change nothing\n  --json      print the receipt as JSON\nGuide: ${UPSTREAM_DOCS}`);
    return;
  }
  const p = parse(args);
  const receipt = await resetUpstream(engine, { sourceId: p.id!, expectLocal: p.expectLocal!, expectUpstream: p.expectUpstream!, dryRun: p.dryRun });
  if (p.json) { console.log(JSON.stringify(receipt, null, 2)); return; }
  const to = receipt.to.slice(0, 12);
  if (receipt.status === 'already_at_upstream') console.log(`${receipt.source_id}: HEAD is already the upstream ${to}; nothing to reset.`);
  else console.log(`${receipt.source_id}: ${receipt.dry_run ? 'would reset' : 'reset'} ${receipt.repo} from ${receipt.from.slice(0, 12)} to ${receipt.tracking_ref} ${to}; `
    + `${receipt.dropped_count} commit(s) leave the branch, kept under ${receipt.backup_ref}.`);
  console.log(`Next: ${receipt.next.argv!.join(' ')}`);
}
