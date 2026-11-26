/**
 * The engine graduation drain's blocker reads (src/core/engine-sql/graduation-drain.ts), served from the store's journal,
 * topology, worktree and client records (rust/crates/gbrain-store/src/persistence/graduation_blockers.rs), plus the
 * recovery-resolution replay read recovery-resolve.ts sent through executeRaw:
 *  - `hasOAuthBoundSourceColumn` is true with no store call: every client record the store keeps has the
 *    `bound_source_id` field (jobs/oauth_clients.rs), as a current SQL schema has the column.
 *  - `listPreviewHashCheckpoints` reads the op's checkpoint records (`listOpCheckpointRecords`, which lists them by
 *    fingerprint in byte order) and keeps those whose first record's `preview_hash`, as text, is `previewHash`.
 */
import type { BrainEngine } from '../../engine.ts';
import type { DanglingOAuthClient, ForeignHostBinding, GraduationEffectRecovery, GraduationPendingRequest, GraduationTopologyRecovery } from '../../engine-sql/graduation-drain.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listGraduationPendingRequests: Member<'listGraduationPendingRequests'> = async (brain) =>
  storeCall({ member: 'listGraduationPendingRequests' }, () => brain.listGraduationPendingRequests()) as Promise<GraduationPendingRequest[]>;

export const listGraduationTopologyRecoveries: Member<'listGraduationTopologyRecoveries'> = async (brain) =>
  storeCall({ member: 'listGraduationTopologyRecoveries' }, () => brain.listGraduationTopologyRecoveries()) as Promise<GraduationTopologyRecovery[]>;

export const listGraduationEffectRecoveries: Member<'listGraduationEffectRecoveries'> = async (brain) =>
  storeCall({ member: 'listGraduationEffectRecoveries' }, () => brain.listGraduationEffectRecoveries()) as Promise<GraduationEffectRecovery[]>;

export const listForeignHostBindings: Member<'listForeignHostBindings'> = async (brain, hostId) =>
  storeCall({ member: 'listForeignHostBindings' }, () => brain.listForeignHostBindings(hostId)) as Promise<ForeignHostBinding[]>;

export const hasOAuthBoundSourceColumn: Member<'hasOAuthBoundSourceColumn'> = async () => true;

export const listDanglingOAuthClients: Member<'listDanglingOAuthClients'> = async (brain) =>
  storeCall({ member: 'listDanglingOAuthClients' }, () => brain.listDanglingOauthClients()) as Promise<DanglingOAuthClient[]>;

/** `->>` of a JSON value: a string as itself, a number or boolean as its text, anything else (and null) as no match. */
function jsonText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export const listPreviewHashCheckpoints: Member<'listPreviewHashCheckpoints'> = async (brain, op, previewHash) => {
  const rows = (await storeCall({ member: 'listPreviewHashCheckpoints' }, () => brain.listOpCheckpointRecords(op))) as Array<{ completed_keys: unknown }>;
  return rows.flatMap(row => {
    const keys = Array.isArray(row.completed_keys) ? row.completed_keys : null;
    const first = keys?.[0];
    const hash = first && typeof first === 'object' && !Array.isArray(first) ? jsonText((first as Record<string, unknown>).preview_hash) : null;
    return keys && hash === previewHash ? [{ completed_keys: keys }] : [];
  });
};
