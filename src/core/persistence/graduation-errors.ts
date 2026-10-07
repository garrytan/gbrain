/**
 * Engine graduation refusals (PGLite -> Postgres): one builder per
 * GRADUATION_ERROR_CODES entry. Every builder returns an `opError` with a
 * `why`, a filled `fix` (`argv` or deliberately none for `report`), a
 * read-only `fix.verify` and the guide anchor, and says when to ask the user.
 * Emitted commands echo the `--to` spelling the user typed and name the target
 * URL only through `--url-env <VAR>`; no builder ever receives a URL with a
 * password.
 *
 * The orchestrator, the CLI, serve and doctor all build refusals here so each
 * code renders one way on every surface (test/graduation-errors.test.ts).
 */
import type { Action } from '../agent-output.ts';
import { exclusiveFix } from '../exclusive-fix.ts';
import type { LockOwner } from '../readiness.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import type {
  GraduationBlocker, GraduationErrorCode, GraduationTargetSpelling, Tombstone, VerifyFailure,
} from './engine-graduation.types.ts';

export const GRADUATION_GUIDE = 'docs/guides/move-to-postgres.md';
export const DEFAULT_TARGET_URL_ENV = 'GBRAIN_TARGET_URL';

/** Doc anchor per code; test/graduation-errors.test.ts asserts each anchor exists. */
export const GRADUATION_DOCS: Readonly<Record<GraduationErrorCode, string>> = {
  graduation_source_writer_held: 'docs/ENGINES.md#graduation-writer-held',
  graduation_unclassified_table: `${GRADUATION_GUIDE}#inventory`,
  graduation_embedding_dimension_mismatch: `${GRADUATION_GUIDE}#embeddings`,
  graduation_drain_timeout: `${GRADUATION_GUIDE}#drain`,
  graduation_target_not_empty: `${GRADUATION_GUIDE}#target-not-empty`,
  graduation_foreign_host_binding: `${GRADUATION_GUIDE}#hosts`,
  graduation_verify_failed: `${GRADUATION_GUIDE}#verify`,
  graduation_interrupted: `${GRADUATION_GUIDE}#resume`,
  graduation_in_progress: `${GRADUATION_GUIDE}#in-progress`,
  graduation_split_brain: `${GRADUATION_GUIDE}#split-brain`,
  graduation_rollback_writes_lost: `${GRADUATION_GUIDE}#rollback`,
  graduation_target_auth_failed: `${GRADUATION_GUIDE}#credentials`,
  graduation_target_ddl_unreachable: `${GRADUATION_GUIDE}#ddl-connection`,
  graduation_target_unsupported: `${GRADUATION_GUIDE}#target-requirements`,
  graduation_unsupported_platform: `${GRADUATION_GUIDE}#platforms`,
  engine_graduated: `${GRADUATION_GUIDE}#graduated-datastore`,
};

/** How the user spelled the move; defaults match the guide. */
export interface GraduationCommandSpelling {
  to?: GraduationTargetSpelling;
  urlEnv?: string;
}

export function statusArgv(): string[] {
  return ['gbrain', 'migrate', '--status', '--json'];
}

export function planArgv(s: GraduationCommandSpelling = {}, extra: readonly string[] = []): string[] {
  return ['gbrain', 'migrate', '--to', s.to ?? 'postgres', '--url-env', s.urlEnv ?? DEFAULT_TARGET_URL_ENV, '--plan', ...extra, '--json'];
}

export function runArgv(s: GraduationCommandSpelling, planHash: string, extra: readonly string[] = []): string[] {
  return ['gbrain', 'migrate', '--to', s.to ?? 'postgres', '--url-env', s.urlEnv ?? DEFAULT_TARGET_URL_ENV, ...extra, '--yes', '--expect', planHash];
}

export function resumeArgv(extra: readonly string[] = []): string[] {
  return ['gbrain', 'migrate', '--resume', ...extra];
}

export function rollbackArgv(extra: readonly string[] = []): string[] {
  return ['gbrain', 'migrate', '--rollback-to-source', ...extra];
}

const STATUS_VERIFY = { argv: statusArgv() };
const DOCTOR_VERIFY = { argv: ['gbrain', 'doctor', '--no-migrate', '--json'] };
const planVerify = (s: GraduationCommandSpelling) => ({ argv: planArgv(s) });
const NOTHING_CHANGED = 'Nothing has changed: the brain stays on PGLite and keeps working.';
const MCP_RESTART = 'Some desktop agent apps stop relaunching a server that exited; restart the MCP client (or its gbrain server entry) after the fix.';

/** `graduation_source_writer_held`: a serve or daemon holds the source and did not hand it over. */
export function sourceWriterHeldError(opts: { owner: LockOwner | null; pid?: number; subcommand?: string; rerun: string[] }): OperationError {
  const holder = opts.owner
    ? `a live \`gbrain serve\` (PID ${opts.owner.pid}, ${opts.owner.transport})`
    : `a gbrain process (PID ${opts.pid ?? 'unknown'}${opts.subcommand ? `, \`gbrain ${opts.subcommand}\`` : ''})`;
  const why = `${holder} holds this PGLite brain's single-writer lock and did not hand it over within 30 seconds, so the move cannot fence the source.`;
  const rerun: Action = { argv: opts.rerun, consent: [], actor: 'agent', requires_exclusive: true, verify: STATUS_VERIFY,
    why: 'Re-runs the move once nothing else holds the brain.' };
  const fix: Action = opts.owner ? { ...exclusiveFix(rerun, opts.owner), verify: STATUS_VERIFY } : {
    ...rerun, actor: 'user',
    why: `Stop ${holder} (let it finish, or end it), then run this command again.`,
    user_message: `Moving your brain to Postgres needs the brain to itself, and ${holder.replace(/`/g, '')} is using it. Can you stop it? Then I'll run the move again. ${NOTHING_CHANGED}`,
  };
  return opError('graduation_source_writer_held', `${holder.replace(/`/g, '')} holds the brain; the move did not start.`,
    'Ask the user to stop the named process (fix), then re-run the move (fix.then). Do not remove a live lock.',
    { why, docs: GRADUATION_DOCS.graduation_source_writer_held, fix: { ...fix, docs: GRADUATION_DOCS.graduation_source_writer_held } });
}

/** `graduation_unclassified_table`: a relation the built-in inventory does not list. */
export function unclassifiedTableError(opts: { relations: readonly string[]; side: 'source' | 'target'; cause: 'newer_schema' | 'missing_inventory_row'; spelling?: GraduationCommandSpelling }): OperationError {
  const list = opts.relations.join(', ');
  const docs = GRADUATION_DOCS.graduation_unclassified_table;
  if (opts.cause === 'newer_schema') {
    const why = `The ${opts.side} database has relations this gbrain does not know (${list}); it was created by a newer gbrain, and copying unknown tables could lose data.`;
    return opError('graduation_unclassified_table', `The ${opts.side} has relations this gbrain version does not classify: ${list}.`,
      'Ask the user to upgrade gbrain on this machine (fix), then preview the move again.',
      { why, reason: 'newer_schema', docs,
        fix: { argv: ['gbrain', 'upgrade'], consent: [], actor: 'user', requires_exclusive: false, docs, verify: planVerify(opts.spelling ?? {}),
          why: `${why} Upgrading this binary gives it the newer inventory.`,
          user_message: `The Postgres database was set up by a newer gbrain than this one. Can you upgrade gbrain here (gbrain upgrade)? Then I'll check the move again. ${NOTHING_CHANGED}` } });
  }
  const why = `This gbrain's own migrations created relations its graduation inventory does not list (${list}). Moving without a classification for every table could drop data, so the move refuses; this is a gbrain bug.`;
  return opError('graduation_unclassified_table', `The graduation inventory has no row for: ${list}.`,
    'Report this to the gbrain maintainers with `gbrain doctor --json` output; nothing changed and the brain keeps working on PGLite.',
    { why, reason: 'missing_inventory_row', docs,
      fix: { consent: [], actor: 'agent', requires_exclusive: false, docs, verify: planVerify(opts.spelling ?? {}),
        why, user_message: `gbrain found a table it does not know how to move (${list}), which is a gbrain bug. Your brain stays on PGLite and keeps working; I can report it to the maintainers.` } });
}

/** `graduation_embedding_dimension_mismatch`: a pre-existing, non-empty target has a different embedding layout. */
export function embeddingDimensionMismatchError(opts: { column: string; source: string; target: string; host: string; spelling?: GraduationCommandSpelling }): OperationError {
  const docs = GRADUATION_DOCS.graduation_embedding_dimension_mismatch;
  const why = `${opts.column} is ${opts.source} on this brain but ${opts.target} in the existing database at ${opts.host}; vectors cannot be copied into a column of another size, and gbrain never drops a vector silently.`;
  return opError('graduation_embedding_dimension_mismatch', `The target's ${opts.column} (${opts.target}) does not match this brain (${opts.source}).`,
    'Ask the user for an empty database, or whether to preview wiping this one (fix); nothing changed.',
    { why, docs,
      fix: { argv: planArgv(opts.spelling ?? {}, ['--force']), consent: ['destructive'], actor: 'agent', requires_exclusive: false, docs, verify: planVerify(opts.spelling ?? {}),
        why: `${why} An empty database always matches (gbrain sizes it from this brain). The --force preview lists exactly what a wipe of ${opts.host} deletes.`,
        user_message: `The Postgres database at ${opts.host} already holds embeddings of a different size than your brain's. Do you have an empty database I can use instead, or should I show you what wiping this one would delete? ${NOTHING_CHANGED}` } });
}

/** The structured next step for one drain blocker (DX amendment "Blocker actions"). */
export function blockerAction(b: GraduationBlocker, rerun: string[]): Action {
  if (b.argv?.length) {
    return { argv: [...b.argv], consent: [], actor: b.needsUser ? 'user' : 'agent', requires_exclusive: false, verify: STATUS_VERIFY,
      why: `${b.detail} Then run the move again: ${rerun.join(' ')}.` };
  }
  return { argv: rerun, consent: [], actor: 'agent', requires_exclusive: false, verify: STATUS_VERIFY, why: b.detail };
}

/** `graduation_drain_timeout` (exit 11 when every blocker still progresses). */
export function drainTimeoutError(opts: { blockers: readonly GraduationBlocker[]; timeoutSec: number }): OperationError {
  const docs = GRADUATION_DOCS.graduation_drain_timeout;
  const stuck = opts.blockers.find(b => b.needsUser) ?? opts.blockers.find(b => b.argv?.length);
  const longer = resumeArgv(['--drain-timeout', String(Math.max(opts.timeoutSec * 2, 1))]);
  const why = `${opts.blockers.length} queued or running write(s) did not finish within --drain-timeout ${opts.timeoutSec}s. The move copies only a drained brain, so it stopped before copying; the source is unchanged and writable.`;
  const fix: Action = stuck
    ? { ...blockerAction(stuck, longer), docs }
    : { argv: longer, consent: [], actor: 'agent', requires_exclusive: false, docs, verify: STATUS_VERIFY,
      why: `${why} Every blocker is still progressing, so a longer drain finishes them; queued work is drained, never cancelled.` };
  return opError('graduation_drain_timeout', `Writes still pending after ${opts.timeoutSec}s: ${opts.blockers.map(b => `${b.kind} ${b.id}`).join(', ')}.`,
    stuck ? 'One blocker needs a person (fix); clear it, then resume the move.' : 'Resume with a longer drain (fix); it is safe to re-run.',
    { why, reason: stuck ? 'blocked' : 'progressing', docs, fix });
}

/** `graduation_target_not_empty`: the target holds data that is not this run's. */
export function targetNotEmptyError(opts: { host: string; tables: readonly { relation: string; rows: number }[]; spelling?: GraduationCommandSpelling }): OperationError {
  const docs = GRADUATION_DOCS.graduation_target_not_empty;
  const listed = opts.tables.slice(0, 5).map(t => `${t.relation} (${t.rows})`).join(', ');
  const why = `The database at ${opts.host} already holds data (${listed}${opts.tables.length > 5 ? ', …' : ''}). Graduation copies only into an empty database, or one holding just this run's rows, so another brain is never overwritten.`;
  return opError('graduation_target_not_empty', `The target database at ${opts.host} is not empty.`,
    'Ask the user for an empty database, or whether to preview wiping this one (fix); nothing changed.',
    { why, docs,
      fix: { argv: planArgv(opts.spelling ?? {}, ['--force']), consent: ['destructive'], actor: 'agent', requires_exclusive: false, docs, verify: planVerify(opts.spelling ?? {}),
        why: `${why} The --force preview lists every table and row count a wipe deletes; the wipe itself then needs --yes --expect with that plan's hash.`,
        user_message: `The Postgres database at ${opts.host} already has data in it. Do you have an empty database I can use instead, or should I show you exactly what wiping this one would delete? ${NOTHING_CHANGED}` } });
}

/** `graduation_foreign_host_binding`: a source's worktree is owned by another host. */
export function foreignHostBindingError(opts: { sourceId: string; ownerHost: string; spelling?: GraduationCommandSpelling }): OperationError {
  const docs = GRADUATION_DOCS.graduation_foreign_host_binding;
  const why = `Source ${opts.sourceId}'s worktree is owned by host ${opts.ownerHost}, not this one. Graduation moves only rows this host owns, so ownership moves here first (prepare on the owner, accept here).`;
  const accept: Action = {
    argv: ['gbrain', 'sources', 'writer', 'transfer', 'accept', opts.sourceId, '--path', '<worktree_root>', '--expected-epoch', '<epoch>', '--manifest', '<manifest_sha256>', '--admin-intent', 'writer_transfer_accept', '--expected-state', '<admin_state>'],
    inputs: [
      { name: 'worktree_root', how: `The checkout of ${opts.sourceId} on this host.` },
      { name: 'epoch', how: 'The epoch the prepare step printed on the owner host.' },
      { name: 'manifest_sha256', how: 'The manifest sha256 the prepare step printed on the owner host.' },
      { name: 'admin_state', how: `admin_state from \`gbrain sources writer status ${opts.sourceId} --json\` on this host.` },
    ],
    consent: [], actor: 'user', requires_exclusive: false, verify: planVerify(opts.spelling ?? {}),
    why: 'Accepts the prepared transfer on this host; then preview the move again.',
  };
  return opError('graduation_foreign_host_binding', `Source ${opts.sourceId} is owned by another host (${opts.ownerHost}).`,
    'Ask the user to run the two-host transfer (fix on the owner host, fix.then here), then preview the move again.',
    { why, docs,
      fix: { argv: ['gbrain', 'sources', 'writer', 'transfer', 'prepare', opts.sourceId, '--admin-intent', 'writer_transfer_prepare', '--expected-state', '<admin_state>'],
        inputs: [{ name: 'admin_state', how: `admin_state from \`gbrain sources writer status ${opts.sourceId} --json\` on host ${opts.ownerHost}.` }],
        consent: [], actor: 'user', requires_exclusive: false, docs, verify: { argv: ['gbrain', 'sources', 'status', opts.sourceId, '--json'] },
        why: `${why} Run this on host ${opts.ownerHost}.`,
        user_message: `Your source ${opts.sourceId} is owned by another computer (${opts.ownerHost}). Its ownership has to move to this computer before the brain can move to Postgres; that takes one command there and one here. ${NOTHING_CHANGED}`,
        then: accept } });
}

const VERIFY_WHY: Readonly<Record<VerifyFailure['kind'], string>> = {
  count: 'a table has a different number of rows on the target',
  digest: 'a table\'s content digest differs between source and target',
  sequence: 'a target sequence is behind the source position or column maximum',
  fk: 'a foreign key has rows without a parent on the target',
  trigger: 'a schema trigger is not in its expected state on the target',
  relation_set: 'the target relation set differs from the inventory',
  replay: 'replaying a stored request on the target did not return the stored outcome',
  doctor: 'a doctor check fails on the target that passed on the source',
};

/** `graduation_verify_failed`: the target is still fenced; the source stays authoritative. */
export function verifyFailedError(opts: { failures: readonly VerifyFailure[]; repeated: boolean }): OperationError {
  const docs = GRADUATION_DOCS.graduation_verify_failed;
  const first = opts.failures[0];
  const kind = first?.kind ?? 'digest';
  const where = first ? `${first.relation}${first.firstKey ? ` (first differing key ${first.firstKey}${first.column ? `, column ${first.column}` : ''})` : ''}` : 'the target';
  const why = `Verification compares every carried table before the target may take over: ${VERIFY_WHY[kind]} (${where}). The target stays fenced and the PGLite brain stays authoritative and writable.`;
  if (opts.repeated) {
    return opError('graduation_verify_failed', `Verification failed again after a re-copy: ${first?.detail ?? kind}.`,
      'Report this to the gbrain maintainers with the redacted bug bundle; the safe exit is a rollback to the source.',
      { why: `${why} A re-copy did not fix it, so it is a gbrain bug, not a transient fault. \`gbrain migrate --rollback-to-source\` discards the target and keeps the PGLite brain.`,
        reason: kind, docs, detail: first?.detail,
        fix: { consent: [], actor: 'agent', requires_exclusive: false, docs, verify: STATUS_VERIFY,
          why: `${why} Report the table, first key and column (no row content) to the maintainers.`,
          user_message: 'Moving your brain to Postgres stopped at the final check, twice. Your brain is still on PGLite and works normally. I can report this to the gbrain maintainers, and discard the half-built Postgres copy if you want.' } });
  }
  return opError('graduation_verify_failed', `Verification failed: ${first?.detail ?? kind}.`,
    'Resume the move (fix): it re-copies the mismatched tables once and verifies again.',
    { why, reason: kind, docs, detail: first?.detail,
      fix: { argv: resumeArgv(), consent: [], actor: 'agent', requires_exclusive: true, docs, verify: STATUS_VERIFY,
        why: `${why} Resume re-copies the mismatched tables with their dependants and verifies again.` } });
}

/** `graduation_interrupted`: a run stopped (crash, SIGINT, lock gap) before it finished. */
export function interruptedError(opts: { runId: string; state: string; dataDir?: string }): OperationError {
  const docs = GRADUATION_DOCS.graduation_interrupted;
  const why = `Graduation run ${opts.runId} stopped in state ${opts.state} and no process owns it now${opts.dataDir ? ` (brain ${opts.dataDir})` : ''}. Resume continues from the first incomplete step; \`gbrain migrate --rollback-to-source\` discards the target instead.`;
  return opError('graduation_interrupted', `An engine graduation (run ${opts.runId}) was interrupted in state ${opts.state}.`,
    'Resume it (fix); `gbrain migrate --status --json` shows where it stopped.',
    { why, docs,
      fix: { argv: resumeArgv(), consent: [], actor: 'agent', requires_exclusive: true, docs, verify: STATUS_VERIFY, why } });
}

/** `graduation_in_progress` (exit 75): another process is running the move; wait for it. */
export function inProgressError(opts: { runId?: string; state?: string; pid?: number; dataDir?: string }): OperationError {
  const docs = GRADUATION_DOCS.graduation_in_progress;
  const who = opts.pid !== undefined ? ` (PID ${opts.pid})` : '';
  const why = `This brain${opts.dataDir ? ` (${opts.dataDir})` : ''} is being moved to Postgres by another process${who}${opts.state ? `, now ${opts.state}` : ''}. While it runs, neither engine may be opened by anything else.`;
  return opError('graduation_in_progress', `An engine graduation${opts.runId ? ` (run ${opts.runId})` : ''} is in progress${who}.`,
    'Wait for the move to finish, then retry; `gbrain migrate --status --json` shows its progress.',
    { why, docs,
      fix: { argv: statusArgv(), consent: [], actor: 'provider', requires_exclusive: false, docs, verify: STATUS_VERIFY,
        why: `${why} Poll the status until the run ends, then retry the same request. ${MCP_RESTART}`,
        user_message: 'gbrain is moving your brain to Postgres right now; memory is back as soon as the move finishes.' } });
}

/** `graduation_split_brain`: a stray brain appeared at the old path. */
export function splitBrainError(opts: { sourcePath: string; strayPath: string; strayRows?: number; retainedPath?: string }): OperationError {
  const docs = GRADUATION_DOCS.graduation_split_brain;
  const why = `A different brain appeared at ${opts.strayPath} (where the graduated brain used to be${opts.strayRows !== undefined ? `; ${opts.strayRows} rows` : ''}), probably created by an older gbrain after a crash. The target is withheld from authority until the user decides what happens to it.`;
  return opError('graduation_split_brain', `A stray brain exists at ${opts.strayPath} next to graduation's retained copy${opts.retainedPath ? ` ${opts.retainedPath}` : ''}.`,
    'Ask the user which copy to keep (fix); `gbrain migrate --status --json` lists both paths with row counts and newest writes.',
    { why, docs,
      fix: { argv: resumeArgv(['--yes']), consent: ['destructive'], actor: 'agent', requires_exclusive: true, docs, verify: STATUS_VERIFY,
        why: `${why} After the user agrees, \`--resume --yes\` moves the stray brain to \`<path>.stray-<run_id>\` (nothing is deleted) and finishes the move to Postgres; the alternative is to move the stray brain aside yourself and run \`gbrain migrate --rollback-to-source\`.`,
        user_message: `While moving your brain to Postgres, a second brain showed up at ${opts.strayPath}. Should I finish the move to Postgres (the stray brain is moved aside, not deleted, for you to inspect), or go back to the original PGLite brain? Nothing is deleted either way.` } });
}

/** `graduation_rollback_writes_lost`: rollback would drop target-side changes. */
export function rollbackWritesLostError(opts: { losses: readonly { relation: string; rows: number }[]; final: boolean; planHash?: string }): OperationError {
  const docs = GRADUATION_DOCS.graduation_rollback_writes_lost;
  const listed = opts.losses.map(l => `${l.relation} (${l.rows})`).join(', ');
  if (opts.final) {
    const why = `The Postgres brain has security or withdrawal changes since the move (${listed}). Rolling back would resurrect withdrawn facts or revoked credentials, and nothing is written back to the source, so rollback refuses; the Postgres brain stays authoritative.`;
    return opError('graduation_rollback_writes_lost', `Rollback refused: the target has withdrawals or credential changes since cutover (${listed}).`,
      'Keep the Postgres brain and recover forward on it; report if rollback is still needed.',
      { why, reason: 'security_changes', docs,
        fix: { consent: [], actor: 'agent', requires_exclusive: false, docs, verify: STATUS_VERIFY,
          why: `${why} Recover forward on Postgres (re-create what was revoked, re-withdraw what was withdrawn).`,
          user_message: 'Your brain cannot go back to PGLite: since the move, facts were withdrawn or access was revoked on Postgres, and going back would undo that. Your brain keeps working on Postgres.' } });
  }
  const why = `Rolling back makes the PGLite brain authoritative again and drops what changed on Postgres since the move: ${listed}. Nothing is written back to PGLite.`;
  return opError('graduation_rollback_writes_lost', `Rollback would drop target-side writes: ${listed}.`,
    'Ask the user whether those changes may be dropped (fix); the Postgres brain stays authoritative until they agree.',
    { why, reason: 'user_data', docs,
      fix: { argv: rollbackArgv(['--yes', '--expect', opts.planHash ?? '<plan_hash>']), ...(opts.planHash ? {} : { inputs: [{ name: 'plan_hash', how: 'plan_hash from `gbrain migrate --status --json`.' }] }),
        consent: ['destructive'], actor: 'agent', requires_exclusive: true, docs, verify: STATUS_VERIFY, ...(opts.planHash ? { plan_hash: opts.planHash } : {}), why,
        user_message: `Going back to PGLite would lose what changed on Postgres since the move: ${listed}. Should I go back anyway? If not, nothing changes and Postgres stays in use.` } });
}

/** `not_found`: a post-cutover rollback has no retained PGLite datastore left to restore. */
export function retainedCopyMissingError(opts: { runId: string; retainedPath: string }): OperationError {
  const docs = `${GRADUATION_GUIDE}#check-resume-or-roll-back`;
  const why = `Rolling back means restoring the local PGLite datastore that graduation run ${opts.runId} set aside at ${opts.retainedPath}, and no datastore is there any more. The rollback stopped before changing anything: Postgres is still the authoritative brain and this machine still routes to it.`;
  return opError('not_found', `Cannot roll back graduation run ${opts.runId}: its retained PGLite datastore (${opts.retainedPath}) no longer exists.`,
    'Nothing changed; carry on with the Postgres brain.',
    { why, docs,
      fix: { consent: [], actor: 'agent', requires_exclusive: false, docs, verify: STATUS_VERIFY, why,
        user_message: 'Going back to the local PGLite brain is no longer possible because its saved copy was deleted. Your brain stays on Postgres and keeps working.' } });
}

/** `graduation_target_auth_failed`: the recorded target URL no longer authenticates. */
export function targetAuthFailedError(opts: { host: string; urlEnv?: string }): OperationError {
  const docs = GRADUATION_DOCS.graduation_target_auth_failed;
  const env = opts.urlEnv ?? DEFAULT_TARGET_URL_ENV;
  const why = `${opts.host} rejected the credentials recorded for this move (the password probably changed). The new URL must name the same host, port, database and user.`;
  return opError('graduation_target_auth_failed', `The target database at ${opts.host} rejected the recorded credentials.`,
    `Ask the user for the new connection string, put it in ${env}, then resume (fix).`,
    { why, docs,
      fix: { argv: resumeArgv(['--url-env', env]), consent: ['credentials'], actor: 'agent', requires_exclusive: true, docs, verify: STATUS_VERIFY,
        why: `${why} Export the new URL as ${env} first; the command never carries the password.`,
        user_message: `The Postgres database at ${opts.host} no longer accepts the saved password. Can you give me its current connection string? I'll keep it out of the command line.` } });
}

/** `graduation_target_ddl_unreachable`: the direct/DDL route does not reach the same database. */
export function targetDdlUnreachableError(opts: { host: string; ddlHost: string; spelling?: GraduationCommandSpelling }): OperationError {
  const docs = GRADUATION_DOCS.graduation_target_ddl_unreachable;
  const why = `gbrain reaches ${opts.host} but not its direct (schema) connection ${opts.ddlHost}, or the two do not name the same database. Supabase's derived direct host is IPv6-only; its session pooler works from IPv4 networks.`;
  return opError('graduation_target_ddl_unreachable', `The direct database connection ${opts.ddlHost} for ${opts.host} is unreachable or names another database.`,
    'Ask the user for the session pooler URL, set GBRAIN_DIRECT_DATABASE_URL to it, then preview again (fix).',
    { why, docs,
      fix: { argv: planArgv(opts.spelling ?? {}), consent: ['credentials'], actor: 'agent', requires_exclusive: false, docs, verify: planVerify(opts.spelling ?? {}),
        why: `${why} Set GBRAIN_DIRECT_DATABASE_URL to the session pooler URL (port 5432) before re-running the plan.`,
        user_message: `gbrain can reach your Postgres database but not the direct connection it needs to set up tables (common on Supabase over IPv4). Can you copy the "session pooler" connection string from the database's connect settings? ${NOTHING_CHANGED}` } });
}

const REQUIREMENT_FIX: Readonly<Record<string, string>> = {
  server_version: 'a Postgres 15, 16 or 17 server',
  vector: 'the `vector` extension (`CREATE EXTENSION vector;`)',
  halfvec: 'a `vector` extension version with halfvec support (0.7 or newer)',
  create_privilege: 'the CREATE privilege on the database for this user',
  column: 'a target schema whose columns match this brain',
  env_override: 'GBRAIN_DATABASE_URL / DATABASE_URL unset or equal to the target (otherwise the routing flip has no effect)',
};

/** `graduation_target_unsupported`: a named prerequisite is missing on the target. */
export function targetUnsupportedError(opts: { requirement: keyof typeof REQUIREMENT_FIX | string; detail: string; host: string; spelling?: GraduationCommandSpelling }): OperationError {
  const docs = GRADUATION_DOCS.graduation_target_unsupported;
  const need = REQUIREMENT_FIX[opts.requirement] ?? opts.requirement;
  const why = `The move needs ${need}; ${opts.detail}.`;
  return opError('graduation_target_unsupported', `The target at ${opts.host} is missing a prerequisite: ${opts.detail}.`,
    'Ask the user to provide the prerequisite or another database, then preview again (fix).',
    { why, reason: opts.requirement, docs,
      fix: { argv: planArgv(opts.spelling ?? {}), consent: ['egress'], actor: 'agent', requires_exclusive: false, docs, verify: planVerify(opts.spelling ?? {}), why,
        user_message: `The Postgres database at ${opts.host} is missing something gbrain needs: ${need}. Can you set that up, or give me a different database? ${NOTHING_CHANGED}` } });
}

/** `graduation_unsupported_platform`: Windows, brain with history. */
export function unsupportedPlatformError(opts: { platform: string }): OperationError {
  const docs = GRADUATION_DOCS.graduation_unsupported_platform;
  const why = `Graduating a brain with write history is not available on ${opts.platform} yet: its tombstone and crash protections are tested on macOS and Linux only. The brain stays on PGLite; \`gbrain mcp expose\` shares it with agents on other machines without moving it.`;
  return opError('graduation_unsupported_platform', `Moving a brain with write history to Postgres is not available on ${opts.platform}.`,
    'Ask the user whether to share the PGLite brain over MCP instead (fix); nothing changed.',
    { why, docs,
      fix: { argv: ['gbrain', 'mcp', 'expose'], consent: ['persistent_install', 'egress'], actor: 'agent', requires_exclusive: false, docs, verify: DOCTOR_VERIFY, why,
        user_message: 'Moving this brain to Postgres is not available on Windows yet. Should I share it with your other machines over MCP instead (gbrain mcp expose)? It stays on this computer.' } });
}

/**
 * `engine_graduated`: a client opened the old PGLite path (tombstone) or a
 * fenced source. On the graduating host the manifest finishes the flip; any
 * other client points its config at the target in one step.
 */
export function engineGraduatedError(opts: { tombstone: Pick<Tombstone, 'targetDisplayUrl' | 'movedTo' | 'runId'> | null; dataDir: string; graduatingHost: boolean; transport?: 'cli' | 'stdio' | 'http' }): OperationError {
  const docs = GRADUATION_DOCS.engine_graduated;
  const where = opts.tombstone?.targetDisplayUrl ?? 'Postgres';
  const mcp = opts.transport === 'stdio' || opts.transport === 'http';
  const why = `This brain moved to ${where}; ${opts.dataDir} is a tombstone${opts.tombstone ? ` and the retained PGLite copy is ${opts.tombstone.movedTo}` : ''}. gbrain never opens or recreates a brain there.`;
  if (opts.graduatingHost) {
    return opError('engine_graduated', `This brain moved to ${where}; ${opts.dataDir} is no longer a brain.`,
      'Finish the move on this host (fix): it completes the routing flip and the registry rewrites.',
      { why, docs,
        fix: { argv: resumeArgv(), consent: [], actor: 'agent', requires_exclusive: false, docs, verify: DOCTOR_VERIFY,
          why: `${why} The graduation manifest on this host is past cutover; resuming finishes pointing the config and mounts at Postgres.${mcp ? ` ${MCP_RESTART}` : ''}` } });
  }
  const restart = mcp ? ` Then restart this MCP server in your agent app (or rewire it with \`gbrain bootstrap harness --harness all\`). ${MCP_RESTART}` : '';
  return opError('engine_graduated', `This brain moved to ${where}; ${opts.dataDir} is no longer a brain.`,
    'Ask the user to point this config at the Postgres brain (fix); one command, then retry.',
    { why, docs,
      fix: { argv: ['gbrain', 'config', 'set', 'database_url', '<target_url>'],
        inputs: [{ name: 'target_url', how: `The connection string of ${where}; the graduating host's config.json holds it. Pass it from the environment (e.g. "$GBRAIN_TARGET_URL"), never typed into a shared log.` }],
        consent: [], actor: 'user', requires_exclusive: false, docs, verify: DOCTOR_VERIFY,
        why: `${why} Pointing this config's database_url at the target is the whole fix; existing tokens and OAuth clients stay valid.${restart}`,
        user_message: `Your gbrain brain moved to Postgres (${where}), but this ${mcp ? 'agent app' : 'machine'} still points at the old local copy. Can you run \`gbrain config set database_url "$GBRAIN_TARGET_URL"\` with the Postgres connection string${mcp ? ', then restart the app\'s gbrain server' : ''}?` } });
}
