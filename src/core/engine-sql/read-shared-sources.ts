/**
 * GST-2898: the source rows the read-shared switch's shared set is built from (grants/read-shared.ts sharedSetFromRows):
 * every live source with its config, whether it is a guest source, the members it is bound to and the brain owner's
 * member id. The statement is the text grants/read-shared.ts sharedRows sent through its SqlQuery tag (each `${}` became
 * the next `$n`), byte for byte, so PGLite and Postgres run what they ran; a store that is not SQL serves the same member
 * (rust/crates/gbrain-store/src/read_shared.rs). test/read-shared-sources-sql-pin.test.ts pins the text.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The config key that names the brain owner's member id (search/private-visibility.ts OWNER_MEMBER_KEY). */
export const READ_SHARED_OWNER_MEMBER_KEY = 'access.owner_member';

export const READ_SHARED_SOURCE_ROWS_SQL = `
    SELECT s.id, s.config,
      (COALESCE(s.config->>'guest' = 'true', false) OR EXISTS (SELECT 1 FROM guest_sources gs WHERE gs.source_id = s.id)) AS guest,
      ARRAY(SELECT ms.member_id FROM access_member_sources ms WHERE ms.source_id = s.id ORDER BY ms.member_id) AS owners,
      (SELECT btrim(c.value) FROM config c WHERE c.key = $1) AS owner_member
    FROM sources s WHERE s.archived IS NOT TRUE ORDER BY s.id COLLATE "C"`;

/** One live source as the shared set reads it; grants/read-shared.ts normalizes the values. */
export type ReadSharedSourceRow = {
  id: unknown;
  config: unknown;
  guest: unknown;
  owners: unknown;
  owner_member: unknown;
};

/** Every live (not archived) source in byte order of its id, with what the shared set needs. */
export async function readSharedSourceRows(tx: Raw): Promise<ReadSharedSourceRow[]> {
  return tx.executeRaw<ReadSharedSourceRow>(READ_SHARED_SOURCE_ROWS_SQL, [READ_SHARED_OWNER_MEMBER_KEY]);
}
