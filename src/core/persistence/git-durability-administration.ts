/**
 * `gbrain sources writer git-durability <source> --enable|--disable [--pat-file <p>] [--dry-run]`
 * (#5182, #5808): the trusted-local admin verb that records a managed worktree's
 * Git-durability opt-in on this host's binding, re-wires the repo-scoped push
 * credential, and catches up the Git effects skipped while durability was off.
 *
 * It is a `PERSISTENCE_ADMIN_OPERATIONS` verb (never a public operation) with
 * the same `--admin-intent`/`--expected-state` handshake as `writer_activate`:
 * the binding column is part of the admin-state hash, so a stale state is
 * refused. Nothing under the canonical root is written: the opt-in is a
 * database column, the credential is Git metadata in `.git/config` plus a
 * 0600 store under the gbrain home (the same keys `sources harden` uses, so
 * `sources unharden` removes it), and the push probe is `git push --dry-run`.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileBounded } from '../bounded-child-exec.ts';
import { classifyGitCheckout } from '../git-checkout.ts';
import { durableSsrfFlags, GIT_ENV, GIT_ENV_AUTH, GIT_SSRF_SUBCOMMAND_FLAGS } from '../git-remote.ts';
import { ensureGbrainHome, resolveGbrainHome } from '../gbrain-home.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import type { BrainEngine } from '../engine.ts';
import { existingLocalHostId } from './identity.ts';
import { getWorktreeBinding, type GitDurabilitySetting, type WorktreeBinding } from './ownership.ts';
import { requireWriterAdminIntent, assertWriterAdminState, writerAdminState } from './admin-intent.ts';
import { gitDurabilityPolicy, planGitDurabilityCatchUp, requeueGitDurabilityCatchUp } from './git-durability-policy.ts';
import { retryParkedEffects } from './effect-retry.ts';

export const GIT_DURABILITY_PARAMS = ['source_id', 'enable', 'disable', 'pat_file', 'dry_run', 'admin_intent', 'expected_state'] as const;

/** The same repo-local key `sources harden` writes, so `sources unharden` removes a credential this verb wired. */
const CRED_MANAGED_KEY = 'gbrain.durability.managedcredential';
const GIT_TIMEOUT_MS = 20_000;

const statusFix = (sourceId: string): Action => readFix(`Shows source ${sourceId}'s owner binding, its git_durability setting and the admin_state the verb needs, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', sourceId, '--json'] });
const invalid = (message: string, suggestion: string, sourceId?: string) => opError('invalid_params', message, suggestion, sourceId ? { fix: statusFix(sourceId) } : {});

export interface GitDurabilityInput { sourceId: string; enable: boolean; disable: boolean; patFile?: string; dryRun: boolean }

export function parseGitDurabilityParams(params: Record<string, unknown>): GitDurabilityInput {
  for (const key of ['enable', 'disable', 'dry_run'] as const) {
    if (params[key] !== undefined && typeof params[key] !== 'boolean') throw invalid(`${key} must be a boolean.`, `Pass --${key.replace('_', '-')} as a bare flag; it takes no value.`);
  }
  if (params.enable === true && params.disable === true) throw invalid('Choose --enable or --disable, not both.',
    'Run gbrain sources writer git-durability <source> --enable to publish through the persistence owner, or --disable to keep Git effects off.');
  if (params.pat_file !== undefined && (typeof params.pat_file !== 'string' || !params.pat_file.trim() || params.pat_file.includes('\0'))) {
    throw invalid('pat_file must be a path to a file holding the token.', 'Pass --pat-file <path>; the token is read from that 0600 file and never from the command line.');
  }
  if (params.disable === true && params.pat_file !== undefined) throw invalid('--pat-file cannot be combined with --disable.',
    'Disable without a token, or re-wire the credential with --enable --pat-file <path> (or --pat-file alone to keep the current setting).');
  if (params.enable !== true && params.disable !== true && params.pat_file === undefined) throw invalid('Name the change: --enable, --disable, or --pat-file <path>.',
    'gbrain sources writer git-durability <source> --enable publishes page writes through the owner\'s Git effect; --disable turns that off; --pat-file <path> alone re-wires the push credential and retries parked pushes.');
  return { sourceId: String(params.source_id), enable: params.enable === true, disable: params.disable === true,
    patFile: typeof params.pat_file === 'string' ? params.pat_file : undefined, dryRun: params.dry_run === true };
}

async function git(root: string, args: string[], auth = false): Promise<{ code: number; stdout: string; stderr: string }> {
  const { error, stdout, stderr } = await execFileBounded('git', ['-C', root, ...(auth ? durableSsrfFlags() : []), ...args],
    { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, ...GIT_ENV, ...(auth ? GIT_ENV_AUTH : {}), LC_ALL: 'C' } });
  if (error && (error.killed || typeof error.code !== 'number')) throw opError('git_unavailable', 'Git did not finish within its bounded attempt.',
    `git ${args[0]} in ${root} did not finish within ${GIT_TIMEOUT_MS / 1000} seconds or could not start; nothing was changed. Check that git runs in that checkout on the brain host, then rerun.`);
  return { code: error ? error.code as number : 0, stdout, stderr };
}

/**
 * The checkout must be a Git checkout on a born branch before durability can
 * be enabled: a detached HEAD would push the wrong ref, and an unborn branch
 * (a fresh `init --git` root with no commit yet, #6332) has nothing to push
 * and is named as such, not as a detached HEAD.
 */
export async function inspectDurabilityCheckout(root: string): Promise<{ branch: string; remote: string | null; merge: string | null }> {
  const checkout = classifyGitCheckout(root);
  if (checkout !== 'git') {
    throw opError('git_checkout_required', `${root} is not inside a Git checkout, so its Git effects have nothing to commit to.`,
      'Initialize the canonical root as a Git repository (git init, a first commit, and a remote) on the brain host, then rerun; a database-only source needs no Git durability.');
  }
  const symbolic = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (symbolic.code !== 0) {
    throw opError('git_detached_head', `${root} is on a detached HEAD, so a push would target the wrong ref.`,
      'Check out the branch the remote should track (git switch <branch>) on the brain host, then rerun.');
  }
  const branch = symbolic.stdout.trim();
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code !== 0) {
    throw opError('git_branch_unborn', `Branch ${branch} in ${root} is unborn: it has no commit yet, so there is nothing for a Git effect to build on.`,
      `Make the first commit on ${branch} (for example commit the existing page files with git add -A && git commit -m "Initial brain") on the brain host, then rerun.`);
  }
  const remote = await git(root, ['config', '--get', `branch.${branch}.remote`]);
  const merge = await git(root, ['config', '--get', `branch.${branch}.merge`]);
  const tracked = remote.code === 0 && merge.code === 0 && remote.stdout.trim() && remote.stdout.trim() !== '.';
  return { branch, remote: tracked ? remote.stdout.trim() : null, merge: tracked ? merge.stdout.trim() : null };
}

export type PushProbe = { ok: true; skipped?: 'no_tracking_remote' } | { ok: false; reason: 'auth' | 'protected' | 'unreachable' | 'other'; detail: string };

/** `git push --dry-run` to the branch's tracking remote: proves push authority without a commit; the same refspec the Git effect pushes. */
export async function probeDurabilityPush(root: string, checkout: { remote: string | null; merge: string | null }, redact: (s: string) => string): Promise<PushProbe> {
  if (!checkout.remote || !checkout.merge) return { ok: true, skipped: 'no_tracking_remote' };
  const push = await git(root, ['push', ...GIT_SSRF_SUBCOMMAND_FLAGS, '--dry-run', '--', checkout.remote, `HEAD:${checkout.merge}`], true);
  if (push.code === 0) return { ok: true };
  const detail = redact(`${push.stderr}\n${push.stdout}`).replace(/\s+/g, ' ').trim().slice(0, 200);
  const low = detail.toLowerCase();
  const reason = low.includes('authentication') || low.includes('403') || low.includes('permission') || low.includes('could not read') ? 'auth'
    : low.includes('protected') || low.includes('pre-receive') || low.includes('hook declined') ? 'protected'
      : low.includes('could not resolve') || low.includes('unable to access') || low.includes('timed out') || low.includes('network') ? 'unreachable' : 'other';
  return { ok: false, reason, detail };
}

/** Read the token from a private file: refuses a group/other-readable or empty file before anything is written. */
export function readPatFile(path: string): string {
  if (!existsSync(path)) throw opError('pat_file_unreadable', `--pat-file ${path} does not exist.`, 'Write the token to a file only you can read (chmod 600), then pass its path with --pat-file.');
  const mode = statSync(path).mode;
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw opError('pat_file_unreadable', `--pat-file ${path} is group- or other-readable (mode ${(mode & 0o777).toString(8)}), so it was not read.`,
      `Run chmod 600 ${path} and rerun; a token file that other users can read is refused before any credential is written.`);
  }
  const token = readFileSync(path, 'utf8').trim();
  if (!token || /\s/.test(token)) throw opError('pat_file_unreadable', `--pat-file ${path} is empty or holds more than one token.`,
    'Put exactly one token on one line in the file, then rerun.');
  return token;
}

async function remoteHost(root: string, remote: string | null): Promise<string> {
  const url = remote ? await git(root, ['remote', 'get-url', remote]) : { code: 1, stdout: '' };
  try { return new URL(url.stdout.trim()).hostname || 'github.com'; } catch { return 'github.com'; }
}

/**
 * Wire a repo-scoped credential for the tracking remote's host: a repo-LOCAL
 * `credential.helper store --file <gbrain-home>/git-credentials` (0600) marked
 * with the key `sources harden` uses, so both verbs share one store and
 * `sources unharden` removes either's wiring. A repo-local helper gbrain did not
 * write is left alone. The token never appears in the result or a log line.
 */
export async function wireDurabilityCredential(root: string, remote: string | null, token: string, dryRun: boolean): Promise<{ status: 'ok' | 'fixed'; detail: string }> {
  const existing = (await git(root, ['config', '--local', '--get', 'credential.helper'])).stdout.trim();
  const ours = (await git(root, ['config', '--local', '--get', CRED_MANAGED_KEY])).stdout.trim() === 'true';
  if (existing && !ours) return { status: 'ok', detail: 'reusing the repo-local credential.helper another tool configured (no store written)' };
  const host = await remoteHost(root, remote);
  const store = join(resolveGbrainHome(), 'git-credentials');
  const line = `https://x-access-token:${token}@${host}`;
  const lines = existsSync(store) ? readFileSync(store, 'utf8').split('\n') : [];
  if (ours && existing && lines.includes(line)) return { status: 'ok', detail: `repo-scoped credential already wired for ${host}` };
  if (dryRun) return { status: 'fixed', detail: `would wire a repo-scoped credential for ${host} (dry-run)` };
  ensureGbrainHome();
  const prefix = 'https://x-access-token:';
  const kept = lines.filter(entry => entry && !(entry.startsWith(prefix) && entry.endsWith(`@${host}`)));
  writeFileSync(store, `${[...kept, line].join('\n')}\n`, { mode: 0o600 });
  try { chmodSync(store, 0o600); } catch { /* best effort on filesystems without modes */ }
  const set = await git(root, ['config', '--local', 'credential.helper', `store --file ${store}`]);
  const mark = await git(root, ['config', '--local', CRED_MANAGED_KEY, 'true']);
  if (set.code !== 0 || mark.code !== 0) throw opError('git_unavailable', 'The repo-local credential helper could not be configured.',
    `git config --local in ${root} failed, so the push credential was not wired; nothing else changed. Check that the checkout's .git/config is writable on the brain host, then rerun.`);
  return { status: 'fixed', detail: `wired a repo-scoped credential for ${host} (store 0600; replaces an earlier token for that host)` };
}

/**
 * #5808(a): after a credential change, one more attempt for every effect of this
 * worktree that parked on `git_push_unavailable`. Other worktrees are untouched;
 * each request goes through `retryParkedEffects`, so the original write's
 * authority is re-checked and a claimed or settled effect is left alone.
 */
export async function retryParkedPushes(engine: BrainEngine, worktreeId: string, dryRun: boolean): Promise<{ requests: number; queued: number; unchanged: number }> {
  const rows = await engine.executeRaw<{ source_id: string; request_id: string }>(`
    SELECT DISTINCT e.source_id,e.request_id::text AS request_id FROM persistence_effects e
     WHERE e.worktree_id=$1::uuid AND e.kind='git' AND e.state='failed' AND e.error_code='targets_parked' AND e.recovery IS NULL
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) p WHERE p->>'error_code'='git_push_unavailable')
     ORDER BY e.source_id,request_id`, [worktreeId]);
  let queued = 0, unchanged = 0;
  for (const row of rows) {
    const result = await retryParkedEffects(engine, row.source_id, row.request_id, dryRun);
    const effects = (result?.effects ?? []) as Array<{ action: string }>;
    if (effects.some(effect => effect.action === 'retry_queued' || effect.action === 'would_retry')) queued++; else unchanged++;
  }
  return { requests: rows.length, queued, unchanged };
}

async function ownedBinding(engine: BrainEngine, sourceId: string): Promise<WorktreeBinding & { local_path: string }> {
  const hostId = existingLocalHostId();
  const binding = await getWorktreeBinding(engine, sourceId, hostId);
  if (!binding) {
    throw opError('writer_registration_required', `Source ${sourceId} has no canonical owner on this brain.`,
      `Claim its checkout first (gbrain sources writer claim ${sourceId} --path <directory>, with the admin-intent handshake), then enable Git durability; a database-only source needs neither.`,
      { fix: statusFix(sourceId) });
  }
  if (!hostId || binding.owner_host_id !== hostId || !binding.local_path) {
    throw opError('permission_denied', `Only source ${sourceId}'s owner host can change its Git durability.`,
      `This host is not the registered owner of source ${sourceId}'s checkout (or has no local binding for it), so nothing was changed. Run the verb on the owner host that writer status names.`,
      { fix: statusFix(sourceId) });
  }
  if (binding.state !== 'active') throw opError('recovery_required', `Source ${sourceId}'s worktree is ${binding.state}, not active.`,
    'Finish the pending recovery or transfer that writer status shows before changing Git durability; the setting is recorded on the active binding.', { fix: statusFix(sourceId) });
  return binding as WorktreeBinding & { local_path: string };
}

/** The verb. `params` are the raw admin params; the caller has already checked the key set. */
export async function runGitDurabilityAdministration(engine: BrainEngine, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = parseGitDurabilityParams(params);
  const binding = await ownedBinding(engine, input.sourceId);
  const root = binding.local_path;
  const token = input.patFile === undefined ? undefined : readPatFile(input.patFile);
  const redact = token ? (text: string) => text.split(token).join('[redacted]') : (text: string) => text;
  const before: GitDurabilitySetting = binding.git_durability;
  const target: GitDurabilitySetting = input.enable ? 'enabled' : input.disable ? 'disabled' : before;
  const report: Record<string, unknown> = { source_id: input.sourceId, worktree_id: binding.worktree_id, path: root, dry_run: input.dryRun,
    git_durability: { before, after: target }, action: 'writer_git_durability' };
  // Policy under the current binding, so the operator sees what the hook probe says when nothing is recorded yet.
  report.current_policy = await gitDurabilityPolicy(binding, root).then(policy => ({ ...policy }), error => ({ error: error instanceof Error ? error.message : String(error) }));
  let checkout: Awaited<ReturnType<typeof inspectDurabilityCheckout>> | undefined;
  if (target === 'enabled' || token) {
    checkout = await inspectDurabilityCheckout(root);
    report.branch = checkout.branch;
    report.tracking_remote = checkout.remote;
  }
  if (token && checkout) {
    report.credential = await wireDurabilityCredential(root, checkout.remote, token, input.dryRun);
    // Only after the credential write succeeded: one more attempt per parked push of this worktree.
    report.parked_pushes = await retryParkedPushes(engine, binding.worktree_id, input.dryRun);
  }
  if (target === 'enabled' && checkout) {
    const probe = await probeDurabilityPush(root, checkout, redact);
    report.push_probe = probe;
    if (!probe.ok) {
      throw opError('git_push_unavailable', `The read-only push probe for ${input.sourceId} failed (${probe.reason}), so Git durability was not enabled.`,
        `git push --dry-run to ${checkout.remote} from ${root} failed: ${probe.detail || probe.reason}. Enabling now would park every Git effect on its push. ${probe.reason === 'auth' ? 'Pass a token file with --pat-file <path> (chmod 600) to wire a repo-scoped credential, or ' : ''}Fix the remote or its credentials on the brain host, check with git push --dry-run there, then rerun. Nothing was changed.`,
        { fix: statusFix(input.sourceId) });
    }
  }
  const plan = target === 'enabled' ? await planGitDurabilityCatchUp(engine, binding) : [];
  report.catch_up = { planned: plan.length, paths: plan.slice(0, 50).map(effect => effect.relative_path) };
  if (input.dryRun) {
    const state = await writerAdminState(engine);
    return { ...report, queued_catch_up: 0, next_action: before === target && !token ? 'The setting is already as requested; nothing to apply.'
      : `Review this preview, then apply with: gbrain sources writer git-durability ${input.sourceId}${input.enable ? ' --enable' : input.disable ? ' --disable' : ''}${input.patFile ? ` --pat-file ${input.patFile}` : ''} --admin-intent writer_git_durability --expected-state ${state}` };
  }
  const expectedState = await requireWriterAdminIntent(engine, 'writer_git_durability', params);
  const queued = await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('lock_timeout','2000ms',true),set_config('synchronous_commit','on',true)");
    await assertWriterAdminState(tx, expectedState);
    const [updated] = await tx.executeRaw<{ git_durability: GitDurabilitySetting }>(`UPDATE persistence_host_bindings SET git_durability=$3
      WHERE worktree_id=$1::uuid AND host_id=$2::uuid RETURNING git_durability`, [binding.worktree_id, binding.owner_host_id, target]);
    if (!updated) throw opError('source_changed', 'The host binding disappeared while the setting was being recorded.',
      `Source ${input.sourceId}'s host binding was removed by another topology change, so nothing was recorded. Inspect writer status before trying again.`, { fix: statusFix(input.sourceId) });
    return target === 'enabled' ? await requeueGitDurabilityCatchUp(tx, binding, plan.map(effect => effect.id)) : [];
  });
  return { ...report, applied: true, queued_catch_up: queued.length,
    next_action: target === 'enabled' ? `Page writes to ${input.sourceId} now commit (and push to ${checkout?.remote ?? 'no tracking remote: commits stay local'}) through the persistence owner's Git effect; ${queued.length} earlier skipped effect(s) were re-queued. Check with gbrain sources writer status ${input.sourceId} --json.`
      : target === 'disabled' ? `Git effects for ${input.sourceId} now complete as skipped (durability_not_enabled) even where a legacy hook exists; database writes are unaffected. Re-enable with --enable; the skipped effects are caught up then.`
        : `The push credential was re-wired; ${report.parked_pushes ? (report.parked_pushes as { queued: number }).queued : 0} parked push(es) got one more attempt.` };
}
