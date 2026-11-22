# The brain store: access members and groups

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The member commands (`gbrain access member add|disable|enable|set|kind|rm` and `gbrain access group add|rm`,
`src/core/access/members.ts`) write members and groups through the members of `src/core/engine-sql/access-members.ts`.
The store keeps the three tables of schema migrations v282, v301, v305 and v308 (`access_members`, `access_groups`,
`access_group_members`). Timestamps leave as ISO strings; the TypeScript members turn them into `Date`s.

Keys (tag `x`, `keys::ACCESS_MEMBERS`):

| Key | Value | Mirrors |
| --- | --- | --- |
| `x 0x01 <member id>` | member record: `id`, `display_name`, `email`, `kind`, `labelled_only`, `disabled_at`, `tombstoned_at`, `created_at`, `updated_at` | `access_members` |
| `x 0x02 <group id>` | group record: `id`, `created_at` | `access_groups` |
| `x 0x03 <group id> 0x00 <member id>` | empty | `access_group_members`, primary key `(group_id, member_id)` |
| `x 0x04 <system> 0x00 <external id>` | link record: `member_id`, `created_at` | `access_member_links` (v286), primary key `(system, external_id)`; `access_member_links.rs` |

Ids never hold NUL (the id check), so the members of one group are one prefix. A brain holds few members, so the email
uniqueness check, the groups of one member and the enabled-member count scan the member and group-member prefixes;
there is no reverse index.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `insertAccessMember({ id, displayName, email, kind, groups, bindTokenId })` | `{ groupsCreated }`: the groups this call created, in the order named | the `addMember` transaction: the member `INSERT`, `INSERT INTO access_groups ... ON CONFLICT DO NOTHING RETURNING id` per group, `INSERT INTO access_group_members ... ON CONFLICT DO NOTHING` per group |
| `setAccessMemberDisabled(id, disabled)` | null | `UPDATE access_members SET disabled_at = COALESCE(disabled_at, now())` (or `NULL`), `updated_at = now()` |
| `setAccessMemberEmail(id, email)` | true when a member that is not removed changed | `UPDATE ... SET email = $2 ... WHERE id = $1 AND tombstoned_at IS NULL RETURNING id` |
| `setAccessMemberKind(id, kind)` | null | `UPDATE ... SET kind = $2 ... WHERE id = $1 AND tombstoned_at IS NULL` |
| `setAccessMemberLabelledOnly(id, labelledOnly)` | null | `UPDATE ... SET labelled_only = $2 ... WHERE id = $1 AND tombstoned_at IS NULL`; no serves key moves |
| `tombstoneAccessMember(id)` | null | the `removeMember` transaction: the tombstone `UPDATE` (email cleared, an earlier disable time kept) and `DELETE FROM access_group_members WHERE member_id = $1` |
| `addAccessGroupMembers(groupId, memberIds)` | true when the group was created | the `addGroup` transaction |
| `removeAccessGroupMembers(groupId, memberIds)` | null | `DELETE FROM access_group_members WHERE group_id = $1 AND member_id = $2` per member |
| `deleteAccessGroup(id)` | null | `DELETE FROM access_groups WHERE id = $1`; its group members go with it (`ON DELETE CASCADE`) |
| `readAccessGroups(id \| null)` | `AccessGroupRow[]`: every group, or the one with exactly that id, each with its member ids, in byte order | `engine-sql/access-control.ts` `ACCESS_GROUP_SQL` |
| `readAccessMembers({ id } \| { email } \| { includeRemoved })` | `AccessMemberRow[]` by id, each with its group ids sorted; by email, every member that declares exactly it, removed or not, by id (the caller refuses an email several members declare) | `engine-sql/access-control.ts` `ACCESS_MEMBER_SQL` |
| `readAccessGroupIds(ids)` | the ids that name an existing group, each once, in byte order | `engine-sql/access-control.ts` `AUDIENCE_GROUPS_SQL` (`SELECT id FROM access_groups WHERE id = ANY($1)`) |
| `listActiveAccessMembers()` | the member ids neither disabled nor removed, by id | `engine-sql/write-misc.ts` |
| `readAccessMemberLink(system, externalId)` | `{ system, external_id, member_id, created_at }`, matched exactly, or null | `SELECT ... FROM access_member_links WHERE system = $1 AND external_id = $2` (`gbrain access member link\|unlink`) |
| `readLinkedMember(system, externalId)` | `{ id, groups }` of the member the link names when it is neither disabled nor removed, groups in byte order; null otherwise | `SELECT m.id, array_agg(g.group_id ORDER BY g.group_id) ... FROM access_member_links l JOIN access_members m ... LEFT JOIN access_group_members g ... WHERE l.system = $1 AND l.external_id = $2 AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL GROUP BY m.id` |
| `insertAccessMemberLink(system, externalId, memberId)` | null | `INSERT INTO access_member_links (system, external_id, member_id) VALUES ($1, $2, $3)` |
| `deleteAccessMemberLink(system, externalId)` | null; nothing for no such link | `DELETE FROM access_member_links WHERE system = $1 AND external_id = $2` |
| `listAccessMemberLinks(memberId \| null)` | every link, or the links of exactly that member, by member id, system and external id, each in byte order | `SELECT ... ORDER BY member_id COLLATE "C", system COLLATE "C", external_id COLLATE "C"` (`gbrain access member links`) |
| `readSharedSourceRows()` | every source not archived, in byte order of its id, as `{ id, config, guest, owners, owner_member }`: `guest` is `config->>'guest' = 'true'` (the store has no `guest_sources` table), `owners` is empty (it keeps no `access_member_sources` bindings), `owner_member` is the `access.owner_member` config value trimmed of spaces, or null (`read_shared.rs`) | `engine-sql/read-shared-sources.ts` `READ_SHARED_SOURCE_ROWS_SQL`, the shared set of the read-shared switch (`grants/read-shared.ts`) |

Each write is one `Store::write`, so a refused statement leaves nothing of the call behind, as the Postgres transaction
does.

## Trigger effects in the same write

| Postgres trigger | Store |
| --- | --- |
| `access_members_mark_restricted` (v282, after insert) | a member insert sets config `access.restrictions_present` to `'1'` unless it already is ([access-flag.md](access-flag.md)) |
| `access_members_refresh_serves` (v309, per statement, after insert, delete or an update of `disabled_at` / `tombstoned_at`) | a member insert, a disable or enable and a tombstone run `gbrain_access_refresh_serves()` at read committed: `access.serves_derived` is `several` while two or more members are enabled, else `one` (written as `one` only when the key exists and differs); `access.serves_since` is set once, to the write's `now()` in UTC to the microsecond (`YYYY-MM-DDTHH:MM:SS.UUUUUUZ`, v329), when the explicit `access.serves` (`one` or `several`, trimmed and lower-cased) or else the derived value is `several` |
| `ON DELETE CASCADE` on `access_group_members.group_id` | `deleteAccessGroup` deletes the group's member keys |

The statement trigger also fires on an update that changes no row (an absent id), so the store refreshes on every
disable, enable and tombstone call. The config triggers on `access.serves` and `access.serves_derived` themselves
(`gbrain_access_serves_*`) have no store half: a config write on this engine does not run them.

## Refusals

Each refusal is `constraint_violation` and its message ends with `(constraint <name>)`. The TypeScript members turn it
into the error Postgres throws: `code` `23505` (unique), `23514` (check) or `23503` (foreign key), with
`constraint_name`, which `refuseEmailRace` reads.

| Constraint | When |
| --- | --- |
| `access_members_id_check`, `access_groups_id_check` | an id that does not match `^[a-z0-9][a-z0-9._-]{0,63}$` |
| `access_members_kind_check` | a kind other than `person` or `audience` |
| `access_members_pkey` | a member id that exists, removed or not |
| `access_members_email_key` | an email another member declares |
| `access_group_members_member_id_fkey` | a group member for a member id that does not exist |
| `access_member_links_pkey` | a link for a `(system, external_id)` that is linked |
| `access_member_links_system_check` | a system that does not match `^[a-z][a-z0-9_-]{0,31}$` |
| `access_member_links_external_id_check` | an external id that is not 1-256 visible ASCII characters (`^[!-~]+$`) |
| `access_member_links_member_id_fkey` | a link to a member id that does not exist |

## What the store does not do

- Credential binding lives on the token and client records, not here: `insertAccessMember` with a `bindTokenId`
  (`gbrain access member add --bind-token`) writes the token's `member_id` in the member's write, and the binding
  members (`readCredentialBindingForUpdate`, `writeCredentialBinding`, `writeCredentialReadsUnscoped`, so
  `bindCredential` and `gbrain auth rescope --member`) and `readLiveMember` through a token or client are served there
  ([access-tokens.md](access-tokens.md) "Member binding", [oauth-clients.md](oauth-clients.md)).
- Link cascade: members are never deleted (a removal is a tombstone), so the `ON DELETE CASCADE` of
  `access_member_links.member_id` has nothing to do; a removed member keeps its links, as on Postgres. The attested
  read of a link (`linkedMember` in `src/core/access/actor.ts`) is `readLinkedMember`, which reads the link, the member
  and its groups in one read.
- Order: ids sort in byte order. The SQL sorts member ids, group ids and each member's groups with `COLLATE "C"`,
  so an `en_US` Postgres gives the same order (`test/engine-parity/access-sort-order.test.ts`).

## Tests

- `crates/gbrain-store/tests/access_members.rs`: the flag and groups of an insert, every refusal with nothing left
  behind, the serves keys over two members and a disable, email and kind writes on a removed member, the tombstone,
  and group add, remove and cascade.
- `crates/gbrain-store/tests/access_member_links.rs`: a link read exactly, listed by member and removed once; every link
  refusal with nothing written; a removed member keeps its links.
- `test/engine-parity/access-members.test.ts`: the same writes on every arm, read through the engine.
