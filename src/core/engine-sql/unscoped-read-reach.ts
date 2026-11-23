/**
 * The `sources_not_readable` probe (src/core/sources-not-readable.ts): after an unscoped remote read came back empty,
 * whether its readable sources hold no page the caller could read (nor, for recall and query, a world fact in force)
 * while another source that is not archived holds one. One implementation for both engines; the Rust store serves the
 * same member (rust/crates/gbrain-store/src/cli_reads/remote_reads.rs).
 *
 * A page counts when it is live and not quarantined and, when `floor` is set, passes the remote read floor
 * (`remoteReadFloorSql('p')`, rendered for the current caller) on both sides of the test.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { remoteReadFloorSql } from '../search/private-visibility.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

export interface UnscopedReachQuery {
  /** The sources the connection reads. */
  readable: readonly string[];
  /** recall and query: a world fact in force in a readable source counts as something to read. */
  withFacts: boolean;
  /** The caller reads under the remote read floor (resolveExcludePrivatePages). */
  floor: boolean;
}

/** True when the empty read is to be refused: nothing readable in `readable`, and a page elsewhere. */
export async function readUnscopedReadRefusal(raw: EngineRawRead, q: UnscopedReachQuery): Promise<boolean> {
  const ids = [...q.readable];
  const none = sqlFragment``;
  const readableFacts = q.withFacts
    ? sqlFragment` OR EXISTS (SELECT 1 FROM facts WHERE source_id = ANY(${ids}::text[]) AND visibility = 'world'
                       AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()))`
    : none;
  const floor = q.floor ? sqlFragment` AND ${trustedSql(remoteReadFloorSql('p'))}` : none;
  const visible = sqlFragment` AND ${trustedSql(quarantineFilterFragment('p'))}${floor}`;
  const { text, params } = renderFragment(sqlFragment`SELECT CASE WHEN EXISTS (SELECT 1 FROM pages p WHERE p.source_id = ANY(${ids}::text[]) AND p.deleted_at IS NULL${visible})${readableFacts} THEN false
                   ELSE EXISTS (SELECT 1 FROM pages p JOIN sources s ON s.id = p.source_id
                                 WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE AND NOT (p.source_id = ANY(${ids}::text[]))${visible})
              END AS refuse`);
  const [row] = await raw<{ refuse: boolean }>(text, params);
  return row?.refuse === true;
}
