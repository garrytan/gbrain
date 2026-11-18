/**
 * GST-2898 (company brains, decisions A to D): the read-shared switch on a token or OAuth client, "also read every
 * shared source, now and later". A switched key reads its stored list plus the shared set, resolved on each request,
 * so a source federated later is read on the next call with no re-grant.
 *
 * The shared set is what a key with no source list reads today, `default` plus every federated source
 * (noGrantFloorReads, source-resolver.ts), with two exclusions (D2-B, D6-A):
 *   - guest sources, which keep the owner's preview-then-confirm grant (gbrain guests grant);
 *   - for a key bound to a member other than the brain owner, every source bound in access_member_sources to someone
 *     else (another member's personal source), even when an admin federated it.
 * Archived sources are never shared. With `default` explicitly unfederated, the shared set is `default` alone.
 *
 * Everything here reads database rows (sources, guest_sources, access_member_sources, config), so a brain with no git
 * repository gets the switch unchanged.
 */
import { isSourceFederated, parseSourceConfig } from '../sources-load.ts';
import type { SqlQuery } from '../sql-query.ts';
import { OWNER_MEMBER_KEY } from '../search/private-visibility.ts';
import { GrantError, authSourcesFromGrant, readSharedFromColumns, type PrincipalGrant } from './model.ts';

export interface SharedRow { id: string; config: unknown; guest: boolean; owners: string[]; owner_member: string | null }

/** Reads every live source with what the shared set needs, in one statement. Throws when the rows cannot be read. */
async function sharedRows(sql: SqlQuery): Promise<SharedRow[]> {
  const rows = await sql`
    SELECT s.id, s.config,
      (COALESCE(s.config->>'guest' = 'true', false) OR EXISTS (SELECT 1 FROM guest_sources gs WHERE gs.source_id = s.id)) AS guest,
      ARRAY(SELECT ms.member_id FROM access_member_sources ms WHERE ms.source_id = s.id ORDER BY ms.member_id) AS owners,
      (SELECT btrim(c.value) FROM config c WHERE c.key = ${OWNER_MEMBER_KEY}) AS owner_member
    FROM sources s WHERE s.archived IS NOT TRUE ORDER BY s.id`;
  return rows.map(r => ({
    id: String(r.id), config: r.config, guest: r.guest === true,
    owners: Array.isArray(r.owners) ? (r.owners as unknown[]).map(String) : [],
    owner_member: typeof r.owner_member === 'string' && r.owner_member ? r.owner_member : null,
  }));
}

/** The shared set for a key bound to `member` (null: bound to no member). Pure over the rows sharedRows reads. */
export function sharedSetFromRows(rows: readonly SharedRow[], member: string | null): string[] {
  const byId = new Map(rows.map(r => [r.id, r]));
  const anchor = byId.get('default');
  const federated = anchor && parseSourceConfig(anchor.config).federated === false
    ? [] : rows.filter(r => r.id !== 'default' && isSourceFederated(r.config)).map(r => r.id);
  const owner = rows[0]?.owner_member ?? null;
  const othersExcluded = member !== null && member !== owner;
  return ['default', ...federated].filter(id => {
    const row = byId.get(id);
    if (!row) return id === 'default';
    if (row.guest) return false;
    return !(othersExcluded && row.owners.length > 0 && !row.owners.includes(member));
  });
}

/** The shared set a switched key bound to `member` reads now. Throws when the source rows cannot be read. */
export async function sharedReadSources(sql: SqlQuery, member: string | null): Promise<string[]> {
  return sharedSetFromRows(await sharedRows(sql), member);
}

/**
 * The read set of a switched key: its stored list first (write source first for tokens), then the shared set,
 * de-duplicated. When the shared set cannot be read the key reads its stored list only and `unresolved` is set, so
 * the response carries the `read_shared_unresolved` notice instead of narrowing silently.
 */
export async function expandReadShared(sql: SqlQuery, stored: readonly string[], member: string | null): Promise<{ sources: string[]; unresolved: boolean }> {
  try {
    return { sources: [...new Set([...stored, ...await sharedReadSources(sql, member)])], unresolved: false };
  } catch {
    return { sources: [...stored], unresolved: true };
  }
}

/**
 * The AuthInfo source fields of a token: authSourcesFromGrant, widened by the shared set when the switch applies. It
 * does not apply when off, on the deny-all `none` (also every drifted or malformed grant), or on a token with no
 * source list, which already reads the floor. The write source never changes; `member` is read only for a switched key.
 */
export async function tokenReadSources(sql: SqlQuery, grant: PrincipalGrant, member: () => Promise<string | null>):
  Promise<{ sourceId: string; allowedSources?: string[]; hasSourceGrant: boolean; readShared?: true; readSharedUnresolved?: true }> {
  const base = authSourcesFromGrant(grant);
  if (grant.readShared !== true || grant.sources.kind === 'none' || grant.sources.kind === 'default') return base;
  const expanded = await expandReadShared(sql, base.allowedSources ?? [base.sourceId], await member());
  return { sourceId: base.sourceId, allowedSources: expanded.sources, hasSourceGrant: true, readShared: true, ...(expanded.unresolved ? { readSharedUnresolved: true as const } : {}) };
}

/**
 * An OAuth client's read set with the switch on, after the active-source filter and only while scopes survived it,
 * or null when the switch does not apply. Private pages stay with the stored list; `member` is read only when it applies.
 */
export async function clientReadShared(sql: SqlQuery, row: { source_grant?: unknown; read_shared_revision?: unknown; grant_revision?: unknown },
  stored: readonly string[], scopesAlive: boolean, member: () => Promise<string | null>): Promise<{ allowedSources: string[]; flags: { readShared: true; readSharedUnresolved?: true } } | null> {
  if (row.source_grant === 'none' || !scopesAlive || !readSharedFromColumns(row.read_shared_revision, row.grant_revision)) return null;
  const expanded = await expandReadShared(sql, stored, await member());
  return { allowedSources: expanded.sources, flags: { readShared: true, ...(expanded.unresolved ? { readSharedUnresolved: true as const } : {}) } };
}

/**
 * GBRA-108: the refusal when a key that reads every shared source is narrowed to no source. The two states cannot
 * coexist, so the fix names the narrowing routes first (switch off and no sources in one command, then revoking the
 * key) and widening last.
 */
export function readSharedNoSourceRefusal(kind: 'token' | 'client', ref: string): GrantError {
  const flag = kind === 'token' ? '--token' : '--client';
  const revoke = kind === 'token' ? 'gbrain auth revoke' : 'gbrain auth revoke-client';
  return new GrantError('invalid_grant', `${kind === 'token' ? 'Token' : 'OAuth client'} "${ref}" reads every shared source (--read-shared on), so it cannot also have no source (--sources none). `
    + `To narrow it to no source, turn the switch off in the same command: gbrain auth rescope ${flag} ${ref} --sources none --read-shared off. `
    + `To stop it reading anything: ${revoke} "${ref}". `
    + `Only if it should keep reading shared sources, give it a write source instead: gbrain auth rescope ${flag} ${ref} --sources <write-source>.`, ['read_shared_needs_source']);
}
