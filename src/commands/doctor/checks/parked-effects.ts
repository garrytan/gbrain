import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import type { ParkedTarget } from '../../../core/persistence/effect-model.ts';
import type { WriteRequest } from '../../../core/persistence/model.ts';
import { OperationError } from '../../../core/ops/contract.ts';
import { authorizeStoredRequest } from '../../../core/persistence/authority.ts';
import { indexLockReceiptPath, readIndexLockReclaims } from '../../../core/persistence/index-lock-reclaim.ts';

const RECLAIM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * #6932: index locks this host's writer reclaimed in the last 7 days. Each one was left by a git that was
 * killed before it could remove its lock, so a run of them points at git steps being killed (deadlines,
 * job group kills, the OOM killer). Null when there were none.
 */
function recentIndexLockReclaims(): { last_7_days: number; latest: { at: string; checkout: string; lock: string; size: number; age_ms: number }; receipts: string } | null {
  const recent = readIndexLockReclaims().filter(entry => Date.now() - Date.parse(entry.at) < RECLAIM_WINDOW_MS);
  const latest = recent.at(-1);
  if (!latest) return null;
  return { last_7_days: recent.length, latest: { at: latest.at, checkout: latest.checkout, lock: latest.lock, size: latest.size, age_ms: latest.age_ms },
    receipts: indexLockReceiptPath() };
}

const reclaimNote = (reclaims: NonNullable<ReturnType<typeof recentIndexLockReclaims>>) =>
  ` The canonical writer reclaimed ${reclaims.last_7_days} abandoned Git index lock(s) in the last 7 days (latest ${reclaims.latest.at} in ${reclaims.latest.checkout}); `
  + `each was left by a git process that was killed before it could remove its lock. Receipts: ${reclaims.receipts}.`;

/** #6697: the stored authority's refusal message, or null while the original writer may still act. */
async function revokedAuthority(engine: BrainEngine, request: WriteRequest): Promise<string | null> {
  try {
    await authorizeStoredRequest(engine, request);
    return null;
  } catch (error) {
    if (error instanceof OperationError) return error.code === 'permission_denied' ? error.message : null;
    throw error;
  }
}

const SAMPLE = 20;

/**
 * #5612: Git and withdrawal targets that failed five consecutive times are
 * parked instead of retried forever. Reads the partial `persistence_effects_parked`
 * index: an exact count plus a capped sample naming each page and its retry command.
 * Settled effects (#7423, #7378: `gbrain sources writer settle-effects`) are history and not counted.
 */
export async function checkParkedEffects(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const scoped = `${sourceIds ? ' AND e.source_id=ANY($1::text[])' : ''} AND NOT (e.data ? 'settled')`;
    const params = sourceIds ? [sourceIds] : [];
    const [{ count }] = await engine.executeRaw<{ count: number }>(`SELECT COUNT(*)::int AS count FROM persistence_effects e WHERE e.data ? 'parked'${scoped}`, params);
    const rows = await engine.executeRaw<{ request: WriteRequest; source_id: string; kind: string; state: string; parked: ParkedTarget[] }>(
      `SELECT to_jsonb(r) AS request,e.source_id,e.kind,e.state,e.data->'parked' AS parked FROM persistence_effects e
       JOIN persistence_requests r ON r.id=e.request_id WHERE e.data ? 'parked'${scoped} ORDER BY e.id LIMIT ${SAMPLE}`, params);
    const effects = [];
    for (const { request, ...row } of rows) {
      const preview = `gbrain sources writer retry-effects ${row.source_id} --request-id ${request.request_id} --dry-run`;
      const revoked = await revokedAuthority(engine, request);
      // GBRA-133: a target a .gitignore rule excludes parks again on any retry while the rule stands; its group says what to change first.
      const ignored = row.parked.every(target => target.error_code === 'git_target_ignored');
      effects.push({ request_id: request.request_id, ...row, ...(ignored ? {} : { command: preview }), ...(revoked === null ? {} : {
        owner_revoked: revoked,
        exit: row.kind === 'git'
          ? `the original writer is revoked; ask the user, then retry once under the brain owner's authority: gbrain sources writer retry-effects ${row.source_id} --request-id ${request.request_id} --admin-intent writer_retry_effects --expected-state <admin_state from gbrain sources writer status>`
          : 'the original writer is revoked and a withdrawal is never retried under another authority; ask the user how to withdraw the page' }) });
    }
    const reclaims = recentIndexLockReclaims();
    // #7010: per source, Git effects whose commit did not reach the remote, with the one command that moves them.
    const pushHolds = await (await import('../../../core/persistence/git-push-holds.ts')).readGitPushHolds(engine, sourceIds);
    // GBRA-133: per source, effects that have waited on a busy worktree for over 10 minutes (a catch-up that does not move).
    const stalled = await (await import('../../../core/persistence/effect-catchup.ts')).readStalledCatchups(engine, sourceIds);
    // GBRA-133: parked Git targets grouped per source and code, each with one bulk command instead of one per request.
    const groups = await (await import('../../../core/persistence/parked-groups.ts')).readParkedGroups(engine, sourceIds);
    const details = { parked_effects: count, exact: true, inspected: rows.length, truncated: count > rows.length, effects, parked_groups: groups, git_push_holds: pushHolds,
      ...(stalled.length ? { stalled_catchups: stalled } : {}), ...(reclaims ? { index_lock_reclaims: reclaims } : {}) };
    const conflicts = pushHolds.filter(hold => hold.conflict);
    const pushNote = pushHolds.length ? ' Git backups not pushed: ' + pushHolds.map(hold => `${hold.source_id} ${hold.retrying} retrying, ${hold.parked} parked (${hold.codes.join(', ')})${hold.conflict
      ? `, CONFLICT in ${hold.conflict.paths.join(', ')}: ask the user which version wins (${hold.fix.argv?.join(' ')})` : hold.parked ? `: ${hold.fix.argv?.join(' ')}` : ''}`).join(' | ') + '.' : '';
    const stalledNote = stalled.length ? ' Catch-up not progressing: ' + stalled.map(item => `${item.source_id} ${item.stalled_effects} effect(s) have waited on a busy canonical worktree since ${item.busy_since} `
      + `(${item.busy_effects} waiting now, up to ${item.busy_retries} busy retries); see who holds it: ${item.fix.argv?.join(' ')}`).join(' | ') + '.' : '';
    if (!count && (conflicts.length || stalled.length)) return { name: 'parked_effects', status: 'warn', details,
      message: `No effect is parked yet, but ${conflicts.length ? 'Git backups are held by a conflict between this machine and the remote' : 'a backlog of effects is not moving'}.${pushNote}${stalledNote}` };
    if (!count) return { name: 'parked_effects', status: 'ok', message: `No Git or withdrawal effect is parked.${pushNote}${reclaims ? reclaimNote(reclaims) : ''}`, details };
    const grouped = groups.map(group => `${group.source_id} ${group.code}: ${group.targets} target(s) in ${group.effects} Git effect(s). ${group.next}`);
    const listed = effects.map(effect => `${effect.kind} ${effect.source_id}: ${effect.parked.map(target =>
      `${target.slug ?? '(whole effect)'} (${target.error_code})`).join(', ')}; ${'exit' in effect ? effect.exit : effect.command ?? 'change the .gitignore rule first (see its group)'}`);
    return { name: 'parked_effects', status: 'warn', details,
      message: `${count} Git, withdrawal or embedding effect(s) have parked targets after repeated failures; their withdrawal, Git backup or vectors are incomplete. ` +
        `Inspect \`gbrain sources writer status <source>\`. ${grouped.length ? `Per source and code: ${grouped.join(' | ')}. ` : ''}Per effect, fix the cause, preview with the command shown, then rerun it without --dry-run to authorize one more attempt: ${listed.join(' | ')}` +
        (count > rows.length ? ` (first ${rows.length} of ${count} shown)` : '') +
        (effects.some(effect => effect.parked.some(target => target.error_code === 'git_target_pending'))
          ? '. git_target_pending: Git still lists a removed page file in the index; on Windows close the program holding it open (a sync watcher, indexer or antivirus), check with `git -c core.fscache=false status` on the brain host, then run the retry command.' : '') +
        pushNote + stalledNote + (reclaims ? reclaimNote(reclaims) : '') };
  } catch (error) {
    return { name: 'parked_effects', status: 'warn',
      message: `Parked effects could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { exact: false, inspected: 0, truncated: true, health: 'unknown' } };
  }
}
