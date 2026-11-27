/**
 * Access member and group writes: one SQL implementation for both engines (rust/docs/store/access-members.md).
 *
 * The member commands (access/members.ts) write members, groups and credential bindings through these. The
 * statements are the text the callers sent through `executeRaw` before, in the same order and the same transactions.
 * The callers keep every input check and every refusal; these only write.
 */
import type { SqlExecutor } from './executor.ts';

export type AccessMemberKind = 'person' | 'audience';

/** One new member, the groups it joins and, optionally, the access token to bind to it in the same transaction. */
export interface AccessMemberInsert { id: string; displayName: string | null; email: string | null; kind: AccessMemberKind; groups: readonly string[]; bindTokenId: string | null }

/** A credential a binding names: an access token (by id text) or an OAuth client (by client_id). */
export interface CredentialTarget { kind: 'token' | 'client'; id: string }

/** The binding columns of a credential row, read under its row lock. */
export interface CredentialBindingRow {
  member_id: string | null; may_act_for: string[] | null; attest_actor: string | null; attest_ops: string[] | null; attest_sources: string[] | null;
  attest_read: 'person' | 'scope' | null; grant_types?: string[] | null; confidential?: boolean; reads_unscoped?: unknown;
}

/** The binding columns a binding write sets. */
export interface CredentialBinding { member: string | null; mayActFor: string[] | null; attestActor: string | null; attestOps: string[] | null; attestSources: string[] | null; attestRead: 'person' | 'scope' | null }

/** Creates each missing group; the groups this call created, in the order named. */
async function ensureGroups(exec: SqlExecutor, groups: readonly string[]): Promise<string[]> {
  const created: string[] = [];
  for (const g of groups) {
    const rows = await exec.executeRaw<{ id: string }>('INSERT INTO access_groups (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id', [g]);
    if (rows.length) created.push(g);
  }
  return created;
}

/** Inserts the member, creates its missing groups, adds it to each and binds the token, in one transaction. */
export async function insertAccessMember(exec: SqlExecutor, spec: AccessMemberInsert): Promise<{ groupsCreated: string[] }> {
  return exec.transaction(async tx => {
    await tx.executeRaw('INSERT INTO access_members (id, display_name, email, kind) VALUES ($1, $2, $3, $4)', [spec.id, spec.displayName, spec.email, spec.kind]);
    const groupsCreated = await ensureGroups(tx, spec.groups);
    for (const g of spec.groups) await tx.executeRaw('INSERT INTO access_group_members (group_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [g, spec.id]);
    if (spec.bindTokenId !== null) await tx.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id::text = $1', [spec.bindTokenId, spec.id]);
    return { groupsCreated };
  });
}

/** Disables a member (an earlier disable time is kept) or enables it. */
export async function setAccessMemberDisabled(exec: SqlExecutor, id: string, disabled: boolean): Promise<void> {
  await exec.executeRaw(disabled
    ? 'UPDATE access_members SET disabled_at = COALESCE(disabled_at, now()), updated_at = now() WHERE id = $1'
    : 'UPDATE access_members SET disabled_at = NULL, updated_at = now() WHERE id = $1', [id]);
}

/** Sets (or, with null, clears) the email of a member that is not removed; true when a row changed. */
export async function setAccessMemberEmail(exec: SqlExecutor, id: string, email: string | null): Promise<boolean> {
  const updated = await exec.executeRaw<{ id: string }>('UPDATE access_members SET email = $2, updated_at = now() WHERE id = $1 AND tombstoned_at IS NULL RETURNING id', [id, email]);
  return updated.length > 0;
}

/** Sets the kind of a member that is not removed. */
export async function setAccessMemberKind(exec: SqlExecutor, id: string, kind: AccessMemberKind): Promise<void> {
  await exec.executeRaw('UPDATE access_members SET kind = $2, updated_at = now() WHERE id = $1 AND tombstoned_at IS NULL', [id, kind]);
}

/** Sets or clears the labelled-only grant of a member that is not removed. */
export async function setAccessMemberLabelledOnly(exec: SqlExecutor, id: string, labelledOnly: boolean): Promise<void> {
  await exec.executeRaw('UPDATE access_members SET labelled_only = $2, updated_at = now() WHERE id = $1 AND tombstoned_at IS NULL', [id, labelledOnly]);
}

/** Marks the member removed (and disabled), clears its email and drops its group memberships, in one transaction. */
export async function tombstoneAccessMember(exec: SqlExecutor, id: string): Promise<void> {
  await exec.transaction(async tx => {
    await tx.executeRaw('UPDATE access_members SET tombstoned_at = now(), disabled_at = COALESCE(disabled_at, now()), email = NULL, updated_at = now() WHERE id = $1', [id]);
    await tx.executeRaw('DELETE FROM access_group_members WHERE member_id = $1', [id]);
  });
}

/** Creates the group when missing and adds each member (already there is kept), in one transaction; true when created. */
export async function addAccessGroupMembers(exec: SqlExecutor, groupId: string, memberIds: readonly string[]): Promise<boolean> {
  return exec.transaction(async tx => {
    const created = (await ensureGroups(tx, [groupId])).length > 0;
    for (const m of memberIds) await tx.executeRaw('INSERT INTO access_group_members (group_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [groupId, m]);
    return created;
  });
}

/** Drops each named member from the group, one statement per member. */
export async function removeAccessGroupMembers(exec: SqlExecutor, groupId: string, memberIds: readonly string[]): Promise<void> {
  for (const m of memberIds) await exec.executeRaw('DELETE FROM access_group_members WHERE group_id = $1 AND member_id = $2', [groupId, m]);
}

/** Deletes the group; its memberships go with it (ON DELETE CASCADE). */
export async function deleteAccessGroup(exec: SqlExecutor, id: string): Promise<void> {
  await exec.executeRaw('DELETE FROM access_groups WHERE id = $1', [id]);
}

/** One `access_member_links` row (v286): a trusted system's person id, linked to one access member. */
export interface AccessMemberLinkRow { system: string; external_id: string; member_id: string; created_at: Date }

/** The link of (system, externalId), matched exactly, or null. */
export async function readAccessMemberLink(exec: SqlExecutor, system: string, externalId: string): Promise<AccessMemberLinkRow | null> {
  const [row] = await exec.executeRaw<AccessMemberLinkRow>('SELECT system, external_id, member_id, created_at FROM access_member_links WHERE system = $1 AND external_id = $2', [system, externalId]);
  return row ?? null;
}

/** Links (system, externalId) to the member; the table's key, checks and member reference refuse a bad row. */
export async function insertAccessMemberLink(exec: SqlExecutor, system: string, externalId: string, memberId: string): Promise<void> {
  await exec.executeRaw('INSERT INTO access_member_links (system, external_id, member_id) VALUES ($1, $2, $3)', [system, externalId, memberId]);
}

/** Removes the link of (system, externalId); nothing for no such link. */
export async function deleteAccessMemberLink(exec: SqlExecutor, system: string, externalId: string): Promise<void> {
  await exec.executeRaw('DELETE FROM access_member_links WHERE system = $1 AND external_id = $2', [system, externalId]);
}

/** Every link, or one member's links, by member, system and external id, each in byte order (COLLATE "C"), as PGLite and the Rust store sort them. */
export async function listAccessMemberLinks(exec: SqlExecutor, memberId: string | null): Promise<AccessMemberLinkRow[]> {
  return memberId === null
    ? exec.executeRaw<AccessMemberLinkRow>('SELECT system, external_id, member_id, created_at FROM access_member_links ORDER BY member_id COLLATE "C", system COLLATE "C", external_id COLLATE "C"')
    : exec.executeRaw<AccessMemberLinkRow>('SELECT system, external_id, member_id, created_at FROM access_member_links WHERE member_id = $1 ORDER BY member_id COLLATE "C", system COLLATE "C", external_id COLLATE "C"', [memberId]);
}

// Each credential statement is spelled once per table (access_tokens keyed by id::text, oauth_clients by client_id):
// the check-engine-sql-dynamic guard accepts only whole literal statements here, so nothing is spliced.

/**
 * A credential's binding columns, locked FOR UPDATE (run it inside the binding's transaction), or undefined. A client
 * row also carries grant_types and whether it is confidential; `readsUnscoped` adds reads_unscoped.
 */
export async function readCredentialBindingForUpdate(exec: SqlExecutor, target: CredentialTarget, opts: { readsUnscoped: boolean }): Promise<CredentialBindingRow | undefined> {
  const sql = target.kind === 'token'
    ? (opts.readsUnscoped
      ? 'SELECT member_id, may_act_for, attest_actor, attest_ops, attest_sources, attest_read, reads_unscoped FROM access_tokens WHERE id::text = $1 FOR UPDATE'
      : 'SELECT member_id, may_act_for, attest_actor, attest_ops, attest_sources, attest_read FROM access_tokens WHERE id::text = $1 FOR UPDATE')
    : (opts.readsUnscoped
      ? 'SELECT member_id, may_act_for, attest_actor, attest_ops, attest_sources, attest_read, grant_types, client_secret_hash IS NOT NULL AS confidential, reads_unscoped FROM oauth_clients WHERE client_id = $1 FOR UPDATE'
      : 'SELECT member_id, may_act_for, attest_actor, attest_ops, attest_sources, attest_read, grant_types, client_secret_hash IS NOT NULL AS confidential FROM oauth_clients WHERE client_id = $1 FOR UPDATE');
  const [row] = await exec.executeRaw<CredentialBindingRow>(sql, [target.id]);
  return row;
}

/** A legacy token's attest columns and revoked_at (access/actor.ts attestRightOf). */
export interface AccessTokenAttestRow {
  revoked_at: Date | null; attest_actor: string | null; attest_ops: string[] | null; attest_sources: unknown; attest_read: string | null;
  member_id: string | null;
}

/** An OAuth client's attest columns, deleted_at, grant types and whether it is confidential (a secret hash is stored). */
export interface OauthClientAttestRow {
  client_id: string; deleted_at: Date | null; attest_actor: string | null; attest_ops: string[] | null; attest_sources: unknown;
  attest_read: string | null; member_id: string | null; grant_types: string[] | null; confidential: boolean;
}

// attest_sources and attest_read came after attest_actor, attest_ops and member_id, so they are read through
// to_jsonb(row) and read as absent on a schema from before them. A schema before attest_actor, attest_ops or member_id
// fails, and the caller (access/actor.ts attestRightOf) reads that as no right.

/** A legacy token's attest row by its id text, revoked or not, or null. */
export async function readAccessTokenAttest(exec: Pick<SqlExecutor, 'executeRaw'>, id: string): Promise<AccessTokenAttestRow | null> {
  const [row] = await exec.executeRaw<AccessTokenAttestRow>(
    `SELECT revoked_at, attest_actor, attest_ops, to_jsonb(access_tokens)->'attest_sources' AS attest_sources, to_jsonb(access_tokens)->>'attest_read' AS attest_read, member_id FROM access_tokens WHERE id::text = $1`, [id]);
  return row ?? null;
}

/**
 * An OAuth client's attest row by client_id, deleted or not, or null; `lock` reads it FOR UPDATE (run it inside the
 * caller's transaction).
 */
export async function readOauthClientAttest(exec: Pick<SqlExecutor, 'executeRaw'>, clientId: string, opts?: { lock?: boolean }): Promise<OauthClientAttestRow | null> {
  const [row] = await exec.executeRaw<OauthClientAttestRow>(opts?.lock
    ? `SELECT client_id, deleted_at, attest_actor, attest_ops, to_jsonb(oauth_clients)->'attest_sources' AS attest_sources, to_jsonb(oauth_clients)->>'attest_read' AS attest_read, member_id, grant_types, client_secret_hash IS NOT NULL AS confidential FROM oauth_clients WHERE client_id = $1 FOR UPDATE`
    : `SELECT client_id, deleted_at, attest_actor, attest_ops, to_jsonb(oauth_clients)->'attest_sources' AS attest_sources, to_jsonb(oauth_clients)->>'attest_read' AS attest_read, member_id, grant_types, client_secret_hash IS NOT NULL AS confidential FROM oauth_clients WHERE client_id = $1`,
    [clientId]);
  return row ?? null;
}

/**
 * The member a credential is bound to, or null when it is unbound or absent. A revoked token or deleted client is read
 * too, and nothing is locked: page-visibility.ts defaultSourceMemberWriter decides a remote write's reader with it.
 */
export async function readCredentialMemberId(exec: Pick<SqlExecutor, 'executeRaw'>, target: CredentialTarget): Promise<string | null> {
  const [row] = await exec.executeRaw<{ member_id: string | null }>(target.kind === 'token'
    ? 'SELECT member_id FROM access_tokens WHERE id::text = $1'
    : 'SELECT member_id FROM oauth_clients WHERE client_id = $1', [target.id]);
  return row?.member_id ?? null;
}

/** One live credential named in a usage log row and the member it is bound to (null: bound to nobody). */
export interface CredentialMemberBinding { name: string; member_id: string | null }

/**
 * The brain-audience heuristic's binding read (facts/writeback-audience.ts classifyBrainAudience): for each name, the
 * tokens not revoked with that name and the OAuth clients not deleted with that client id, each with its member. A
 * name can match several credentials; an empty list reads nothing. The rows come in no set order.
 */
export async function listCredentialMemberBindings(exec: Pick<SqlExecutor, 'executeRaw'>, names: readonly string[]): Promise<CredentialMemberBinding[]> {
  if (!names.length) return [];
  const rows = await exec.executeRaw<{ name: string; member_id: string | null }>(
    `SELECT name, member_id FROM access_tokens WHERE name = ANY($1::text[]) AND revoked_at IS NULL
       UNION ALL SELECT client_id AS name, member_id FROM oauth_clients WHERE client_id = ANY($1::text[]) AND deleted_at IS NULL`, [[...names]]);
  return rows.map(r => ({ name: r.name, member_id: r.member_id ?? null }));
}

/** An enabled member linked to a person of a trusted system, with its groups in `group_id` order. */
export interface LinkedMemberRow { id: string; groups: string[] | null }

/**
 * The enabled member (not disabled, not tombstoned) the link (system, externalId) names, with its groups, or null. The
 * attested-actor check (access/actor.ts linkedMember) reads it; a schema before the link tables fails, and the caller
 * reads that as unlinked.
 */
export async function readLinkedMember(exec: Pick<SqlExecutor, 'executeRaw'>, system: string, externalId: string): Promise<LinkedMemberRow | null> {
  const [row] = await exec.executeRaw<LinkedMemberRow>(
      `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
       FROM access_member_links l JOIN access_members m ON m.id = l.member_id LEFT JOIN access_group_members g ON g.member_id = m.id
       WHERE l.system = $1 AND l.external_id = $2 AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL GROUP BY m.id`, [system, externalId]);
  return row ?? null;
}

/** Writes a credential's member, may_act_for and attest columns. */
export async function writeCredentialBinding(exec: SqlExecutor, target: CredentialTarget, binding: CredentialBinding): Promise<void> {
  await exec.executeRaw(target.kind === 'token'
    ? 'UPDATE access_tokens SET member_id = $2, may_act_for = $3::text[], attest_actor = $4, attest_ops = $5::text[], attest_sources = $6::text[], attest_read = $7 WHERE id::text = $1'
    : 'UPDATE oauth_clients SET member_id = $2, may_act_for = $3::text[], attest_actor = $4, attest_ops = $5::text[], attest_sources = $6::text[], attest_read = $7 WHERE client_id = $1',
    [target.id, binding.member, binding.mayActFor, binding.attestActor, binding.attestOps, binding.attestSources, binding.attestRead]);
}

/** Sets reads_unscoped to now() (true) or clears it (false). */
export async function writeCredentialReadsUnscoped(exec: SqlExecutor, target: CredentialTarget, readsUnscoped: boolean): Promise<void> {
  await exec.executeRaw(target.kind === 'token'
    ? 'UPDATE access_tokens SET reads_unscoped = CASE WHEN $2::boolean THEN now() ELSE NULL END WHERE id::text = $1'
    : 'UPDATE oauth_clients SET reads_unscoped = CASE WHEN $2::boolean THEN now() ELSE NULL END WHERE client_id = $1', [target.id, readsUnscoped]);
}
