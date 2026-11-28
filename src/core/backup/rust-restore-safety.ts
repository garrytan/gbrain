/**
 * What `gbrain backup restore` of a Rust brain needs before it publishes: the refusal table, the quarantine plan, and
 * the check that the archive's store identity is the restored store's (rust/crates/gbrain-store/src/restore.rs).
 *
 * PGLite repairs a restore in one SQL transaction (`restorePgliteBackup`). A Rust store takes no raw SQL, so the same
 * safety is `restoreCensus` (one read) and `restoreQuarantine` (one transaction). Work the Rust store cannot cancel with
 * a receipt (unfinished requests, recovery records) and purges that need replay are refused with a registered
 * `restore_step_unsupported` reason, never skipped.
 */
import { opError, type OperationError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';
import { AgentInstallError, confinedPath } from '../agent-install/state.ts';
import type { RestoreCensus, RestoreQuarantinePlan, RestoreStoreIdentity } from '../rust-engine/restore-types.ts';
import { rebaseRestorePath, type RestoredSource } from './quarantine.ts';

/** Every reason a Rust restore refuses to publish: the `reason` of `restore_step_unsupported`. */
export const RESTORE_REFUSAL_REASONS = [
  'purge_replay', 'purge_mirror_unreadable', 'pending_requests', 'recovery_required', 'archived_authority', 'shared_skill_state', 'unclassified_state', 'recovery_mode', 'restore_addon_too_old',
] as const;
export type RestoreRefusalReason = (typeof RESTORE_REFUSAL_REASONS)[number];

export const RESTORE_REFUSAL_DOCS = 'docs/guides/troubleshooting.md#restore-step-unsupported';

const NOT_PUBLISHED = 'Nothing was published: the archive and the original brain are untouched, and the private failed receipt and staging folder stay under the restore target. Running the same command again fails with restore_target_exists.';
const NEW_BACKUP = ['gbrain', 'backup', 'create', '--output', '<NEW_ARCHIVE>'];
const NEW_RESTORE = ['gbrain', 'backup', 'restore', '<ARCHIVE>', '--into', '<NEW_ABSENT_ROOT>'];
const RESTORE_WITH_MIRROR = [...NEW_RESTORE, '--purge-mirror', '<MIRROR_COPY>'];

interface RefusalText { what: (count: number, detail?: string) => string; why: string; remedy: string; argv: string[] }

const TEXT: Record<RestoreRefusalReason, RefusalText> = {
  pending_requests: {
    what: n => `The archive holds ${n} unfinished write request(s) or effect(s). A Rust brain cannot cancel them with receipts, and restoring them would let them run again.`,
    why: 'A backup of a busy brain can hold queued or running writes; restoring them unchanged would publish old work under a new brain.',
    remedy: 'If the original brain is still readable, pause its writers and take a new backup, then restore that into a new absent --into. Otherwise restore with a newer release that cancels unfinished requests on Rust.',
    argv: NEW_BACKUP,
  },
  recovery_required: {
    what: n => `The archive holds ${n} unresolved recovery record(s).`,
    why: 'A recovery record means a file or topology change was interrupted; only the brain that owned it can finish it.',
    remedy: 'Finish the recovery on the original brain, take a new backup, then restore that into a new absent --into.',
    argv: NEW_BACKUP,
  },
  purge_replay: {
    what: n => `${n} purge(s) that were committed after the archive's snapshot are missing from it, and this runtime cannot replay purges on a Rust brain.`,
    why: 'Publishing the archive would bring purged content back.',
    remedy: 'Take a newer backup of the original brain (it then holds the purge) and restore that into a new absent --into, or restore with a newer release that replays purges on Rust. Do not skip the check.',
    argv: NEW_BACKUP,
  },
  purge_mirror_unreadable: {
    what: () => 'The purge mirror (.gbrain/purge-events.jsonl) is unreadable, so the purges made after the archive cannot be checked.',
    why: 'Treating an unreadable mirror as empty would hide purges that must not come back.',
    remedy: 'Restore a good copy of the mirror and name it with --purge-mirror <absolute path>, into a new absent --into.',
    argv: RESTORE_WITH_MIRROR,
  },
  archived_authority: {
    what: (n, detail) => `The archive holds ${n} OAuth client(s) or local writer registration(s) that are still live${detail ? ` (${detail})` : ''}. This restore does not revoke them yet.`,
    why: 'A restored brain must not keep access that the archive handed out: a live OAuth client or local writer in the archive would work again on the restored brain.',
    remedy: 'Re-issue tokens on the live brain, then restore from an archive taken without them: remove its OAuth clients and local writer registrations, take a new backup, restore that into a new absent --into, and register the clients and create tokens again afterwards. Or wait for the follow-up release that adds revocation to the Rust restore.',
    argv: NEW_BACKUP,
  },
  shared_skill_state: {
    what: (n, detail) => `The archive holds ${n} kind(s) of shared-skill state that is still switched on${detail ? ` (${detail})` : ''}. This restore does not switch it off or rotate its secret yet.`,
    why: 'A restored brain must not keep shared-skill publication, memberships or policies the archive had: they would stay active under the new brain id with the old catalog secret.',
    remedy: 'Turn shared-skill publication off on the live brain (set mcp.publish_skills to false, remove the shared-skill members and policies), take a new backup, and restore that into a new absent --into. Or wait for the follow-up release that quarantines shared-skill state in the Rust restore.',
    argv: NEW_BACKUP,
  },
  unclassified_state: {
    what: (n, detail) => `The archive holds ${n} kind(s) of record this build's restore does not know how to make safe${detail ? `: ${detail}` : ''} (access tokens and OAuth tokens are not revoked by this restore; shared-skill members and policies are not kept).`,
    why: 'Restore changes only state it knows; anything else could keep archived authority or work alive.',
    remedy: 'Restore with a newer release that supports those records, into a new absent --into.',
    argv: NEW_RESTORE,
  },
  recovery_mode: {
    what: () => 'Restore mode recovery is not supported for a Rust brain; only new-brain is.',
    why: 'Recovery keeps the old brain identity, which needs shared-skill authority records a Rust store does not keep.',
    remedy: 'Run the restore again without --mode recovery (the default new-brain), into a new absent --into.',
    argv: NEW_RESTORE,
  },
  restore_addon_too_old: {
    what: () => "This gbrain's Rust addon is older than the restore step, so it cannot make a restored brain safe.",
    why: 'Restore runs in a fresh process and checks the addon before it reserves a target; an older addon would have to skip the safety steps.',
    remedy: 'Install the current release and its Rust addon, then run the restore again into a new absent --into.',
    argv: ['gbrain', 'upgrade'],
  },
};

function action(reason: RestoreRefusalReason): Action {
  return { ask_user: true, argv: TEXT[reason].argv, consent: [], actor: 'user', requires_exclusive: false, docs: RESTORE_REFUSAL_DOCS,
    why: TEXT[reason].why, user_message: `${TEXT[reason].remedy} Replace the <PLACEHOLDERS> with real paths.` };
}

/** The refusal for `reason`, or what to say about it: stable code, one reason, what was not published, the fix. */
export function restoreRefusal(reason: RestoreRefusalReason, count = 1, context: { store?: RestoreStoreIdentity; mode?: string; detail?: string } = {}): OperationError {
  const text = TEXT[reason];
  const store = context.store ? ` store_format=${context.store.engine_format_version} generation=${context.store.generation}` : '';
  return opError('restore_step_unsupported', `${text.what(count, context.detail)} ${NOT_PUBLISHED}`, text.remedy,
    { reason, why: text.why, fix: action(reason), docs: RESTORE_REFUSAL_DOCS, detail: `reason=${reason} count=${count}${context.detail ? ` kinds=${context.detail}` : ''}${store}` });
}

/** The addon has the restore step (an addon built before it lacks both members). */
export function restoreAddonSupportsSafety(addon: object): boolean {
  const proto = (addon as { Brain?: { prototype?: Record<string, unknown> } }).Brain?.prototype;
  return typeof proto?.restoreCensus === 'function' && typeof proto?.restoreQuarantine === 'function';
}

export interface RestoreRefusalInput {
  census: RestoreCensus;
  mode: 'new_brain' | 'recovery';
  /** What reading the original brain's purge mirror found; `unavailable` publishes with a warning, as PGLite does. */
  mirror: 'ok' | 'unavailable' | 'corrupt';
}

/** The first reason this restore cannot publish, or null. A mode or mirror the Rust restore cannot serve is refused before the census. */
export function restoreRefusalFor(input: RestoreRefusalInput): OperationError | null {
  const { census, mode, mirror } = input;
  const context = { store: census.store, mode };
  if (mode === 'recovery') return restoreRefusal('recovery_mode', 1, context);
  if (mirror === 'corrupt') return restoreRefusal('purge_mirror_unreadable', 1, context);
  const first = census.blockers[0];
  return first ? restoreRefusal(first.reason, first.count, { ...context, detail: first.detail }) : null;
}

/**
 * The archive metadata's `store` object against the restored store. The container's `format_version` (1) is a different
 * number and is never compared: a format-5 store archived in a version-1 container is the normal case.
 */
export function checkStoreIdentity(metadata: unknown, store: RestoreStoreIdentity): void {
  const archived = (metadata as { store?: Partial<RestoreStoreIdentity> } | null)?.store;
  const mismatch = (what: string): never => {
    throw new AgentInstallError('invalid_backup', `The archived store ${what} does not match the restored store. Preserve the archive and use a verified backup.`);
  };
  if (!archived || typeof archived !== 'object') return mismatch('identity is missing');
  if (archived.engine_format_version !== store.engine_format_version) mismatch('format');
  if (archived.schema_version !== store.schema_version) mismatch('schema version');
  if (archived.brain_id !== store.brain_id) mismatch('brain id');
  if (archived.generation !== store.generation) mismatch('generation');
}

const DISABLE = /^(?:connectors\.[^.]+\.auto_sync|autopilot\..+\.enabled)$/;

/**
 * The plan `restoreQuarantine` takes, from the census and the archive's source inventory: the same decisions
 * `quarantineRestoredExecution` makes on PGLite (a managed source moves under the new root, automation is switched off,
 * a path setting is rebased or deleted when it is not under a managed path, `storage` is deleted).
 */
export function buildQuarantinePlan(options: {
  restoreId: string; census: Pick<RestoreCensus, 'settings'>; sources: readonly RestoredSource[];
  originalRoot: string; root: string; managedPaths: readonly string[];
}): RestoreQuarantinePlan {
  return {
    restore_id: options.restoreId,
    sources: options.sources.map(s => ({ id: s.id, local_path: s.local_path,
      rebased_path: s.managed_relative_path ? confinedPath(options.root, s.managed_relative_path) : null })),
    settings: options.census.settings.map(({ key, value }) => ({ key, value: key === 'storage' ? null
      : DISABLE.test(key) ? 'false' : rebaseRestorePath(value, options.originalRoot, options.root, options.managedPaths) })),
  };
}
