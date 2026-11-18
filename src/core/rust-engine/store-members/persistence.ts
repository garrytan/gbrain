/**
 * The write-journal reads the Rust store can answer today (BrainEngine readManagedModeRows, readLocalWriterRow,
 * insertLocalWriterRow, readJournalLimitRows, readHeldPageRows, readHeldCoverageRows). The other journal members
 * (the request reads, the counter lock, admission, the claim stamp, the request lock and completion) still refuse with
 * `engine_capability_missing`: they run inside `transaction`, which this engine does not serve yet.
 *
 * What each member answers and why: rust/docs/store/journal.md ("TypeScript journal members").
 */
import type { LocalWriterInsert, LocalWriterRow } from '../../engine-sql/persistence-state.ts';
import type { HeldCoverageRow } from '../../engine-sql/persistence-journal.ts';
import { PAGE_BODY_CONFIG_KEYS } from '../../page-body/limits.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The store keeps no managed brains: a brain on this engine is always unmanaged, one singleton row. */
export const readManagedModeRows: StoreMember<[], Array<{ enabled: unknown }>> = async () => [{ enabled: false }];

/**
 * The registration row of a local writer, or undefined. `lock` asks PGLite for FOR SHARE so a revocation waits; the
 * store runs one write transaction at a time, so a read never overlaps a revocation and the option changes nothing.
 * `revoked_at` comes back as a Date, as PGLite returns a timestamptz.
 */
export const readLocalWriterRow: StoreMember<[id: string, opts?: { lock?: boolean }], LocalWriterRow | undefined> =
  async (brain, id) => {
    const row = await storeCall({ member: 'readLocalWriterRow' }, () => brain.readLocalWriter(id)) as
      { lane: string; credential_hash: string; grant_ceiling: LocalWriterRow['grant_ceiling']; revoked_at: string | null } | null;
    if (!row) return undefined;
    return { lane: row.lane, credential_hash: row.credential_hash, grant_ceiling: row.grant_ceiling, revoked_at: row.revoked_at === null ? null : new Date(row.revoked_at) };
  };

/** Stores a local writer unless its id or credential hash is registered already; true when this call stored it. */
export const insertLocalWriterRow: StoreMember<[row: LocalWriterInsert], boolean> = (brain, row) =>
  storeCall({ member: 'insertLocalWriterRow' }, () => brain.insertLocalWriterRow({
    id: row.id, lane: row.lane, credentialHash: row.credentialHash, grantCeiling: row.grant,
  }));

/** `config` keys `LIKE 'persistence.limits.%'`: the prefix, then anything (no `_` in it, so no single-character wildcard). */
const LIMITS_PREFIX = 'persistence.limits.';

/**
 * The journal's config rows, then the largest page stored in segments (key null). The store keeps no segmented pages
 * (createSegmentedPageShell refuses on this engine), so that value is null, as PGLite's `max(body_bytes)` over no rows.
 * Rows are in key order; the caller reads them into a map.
 */
export const readJournalLimitRows: StoreMember<[], Array<{ key: string | null; value: string | null }>> = async (brain) => {
  const all = await storeCall({ member: 'readJournalLimitRows' }, () => brain.getAllConfig()) as Record<string, string>;
  const exact = new Set<string>([PAGE_BODY_CONFIG_KEYS.segmentedStorage, PAGE_BODY_CONFIG_KEYS.maxBytes]);
  const rows: Array<{ key: string | null; value: string | null }> = Object.keys(all)
    .filter(key => key.startsWith(LIMITS_PREFIX) || exact.has(key))
    .sort()
    .map(key => ({ key, value: all[key] }));
  rows.push({ key: null, value: null });
  return rows;
};

/** Sync holds are written only by the git sync path, which this engine refuses: no page is ever held. */
export const readHeldPageRows: StoreMember<[pageIds: string[]], Array<{ record: never; revision: string | null }>> = async () => [];

/** No hold rows exist on this engine (see readHeldPageRows), so no source has held coverage. */
export const readHeldCoverageRows: StoreMember<[sourceIds: string[] | null], HeldCoverageRow[]> = async () => [];
