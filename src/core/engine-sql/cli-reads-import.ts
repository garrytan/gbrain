/**
 * The reads the CLI import and extract paths ran through `executeRaw` before they had typed members
 * (docs/research/rust-cli-executeraw-map.md, "Source lists and source rows", "Guest-source checks", "Extract reads").
 * Each function keeps the statement text its call site ran, so PGLite and Postgres answer exactly as before; a Rust
 * brain answers from its store (rust/crates/gbrain-store/src/cli_reads/import.rs).
 */
import type { PageTrustLookup, PageTrustRow } from '../engine.ts';
import { guestSourceSql } from '../guests/note.ts';
import { activationSuppressedSql } from '../eligibility/sql.ts';
import { isMissingSchemaObject } from '../utils.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** The guest sources among `sourceIds` (guestSourceSql), in no particular order. */
export async function listGuestSourceIds(exec: LegacyUnscopedRead, sourceIds: readonly string[]): Promise<string[]> {
  if (sourceIds.length === 0) return [];
  const { text, params } = renderFragment(sqlFragment`SELECT s.id FROM sources s WHERE s.id = ANY(${[...new Set(sourceIds)]}::text[])
    AND ${trustedSql(guestSourceSql('s.config', 's.id'))}`);
  const rows = await exec.executeRaw<{ id: string }>(text, params);
  return rows.map(row => row.id);
}

/** The guest flag of a brain whose schema is behind the guest-notes migration: the config record alone (guests/marker.ts withGuestSourceSql). */
const CONFIG_GUEST_SQL = "COALESCE(s.config->>'guest' = 'true', false)";

const trustColumns = (tableGuest: boolean) => sqlFragment`pages.id, pages.source_id, pages.slug, trust_tier, write_origin, ${trustedSql(activationSuppressedSql('pages', 'pages'))} AS flagged,
  ${trustedSql(tableGuest ? guestSourceSql('s.config', 'pages.source_id') : CONFIG_GUEST_SQL)} AS guest FROM pages LEFT JOIN sources s ON s.id = pages.source_id`;

/**
 * The trust rows of pages by id and by (source_id, slug): `byId` marks the rows found by id. A brain whose schema is
 * behind the guest-notes migration reads the guest flag from the config alone, as withGuestSourceSql does.
 */
export async function readPageTrustRows(exec: LegacyUnscopedRead, lookup: PageTrustLookup): Promise<PageTrustRow[]> {
  const ids = lookup.ids ?? [];
  const keys = lookup.keys ?? [];
  const read = async (tableGuest: boolean): Promise<PageTrustRow[]> => {
    const found: PageTrustRow[] = [];
    if (ids.length) {
      const { text, params } = renderFragment(sqlFragment`SELECT ${trustColumns(tableGuest)} WHERE pages.id = ANY(${[...ids]}::int[])`);
      for (const row of await exec.executeRaw<Omit<PageTrustRow, 'byId'>>(text, params)) found.push({ ...row, byId: true });
    }
    if (keys.length) {
      const { text, params } = renderFragment(sqlFragment`SELECT ${trustColumns(tableGuest)}
          WHERE ${trustedSql(lookup.includeDeleted ? '' : 'pages.deleted_at IS NULL AND ')}(pages.source_id, pages.slug) IN (SELECT * FROM unnest(${keys.map(k => k.source_id)}::text[], ${keys.map(k => k.slug)}::text[]))`);
      for (const row of await exec.executeRaw<Omit<PageTrustRow, 'byId'>>(text, params)) found.push({ ...row, byId: false });
    }
    return found;
  };
  try { return await read(true); } catch (e) {
    if (!isMissingSchemaObject(e, 'table', 'guest_sources')) throw e;
    return read(false);
  }
}
