# The brain store: access members and groups

The rules in [rust/README.md](../../README.md) ("The brain store") apply. The SQL for the PGLite and PostgreSQL engines
is in `src/core/engine-sql/access-members.ts` (the writes) and `src/core/engine-sql/access-control.ts` (the reads); the
store (`gbrain-store` `access_members.rs`) serves the same members, and `src/core/rust-engine/store-members/access-members.ts`
filters its rows for the member reads that have no store method.

| Member | Returns |
| --- | --- |
| `brain.insertAccessMember(spec)` | `{ groupsCreated }`: the groups this call created, in the order named. Inserts the member (`kind` `person` when unset), creates its missing groups, adds it to each and binds the token `bindTokenId` names, in one write |
| `brain.setAccessMemberDisabled(id, disabled)` | null. A disable keeps an earlier disable time; an enable clears it |
| `brain.setAccessMemberEmail(id, email)` | whether a member that is not removed changed |
| `brain.setAccessMemberKind(id, kind)`, `brain.setAccessMemberLabelledOnly(id, on)` | null. A removed member is skipped |
| `brain.tombstoneAccessMember(id)` | null. Marks the member removed and disabled (an earlier disable time is kept), clears its email and drops its group members |
| `brain.addAccessGroupMembers(groupId, memberIds)` | whether the group was created. A member already in the group is kept |
| `brain.removeAccessGroupMembers(groupId, memberIds)`, `brain.deleteAccessGroup(id)` | null. A group delete drops its group members |
| `brain.readAccessMembers(lookup)` | `AccessMemberRow[]` by id bytes, each with its group ids in byte order and the times as ISO text: one member by exact id (any status), every member declaring exactly `email`, or every member (removed ones only with `includeRemoved`) |
| `brain.readAccessGroups(id)` | `[{ id, members }]`: every group, or the one group with exactly that id; groups and members in byte order |
| `brain.listPagesNamingReader(principal, live)` | `[{ slug, source_id }]`: the pages of every source whose readers (`gbrain_access_readers`, normalized) name exactly `principal`, by source id then slug bytes, at most 51; with `live` soft-deleted pages are left out and at most 201 return |

The TypeScript member answers these from `readAccessMembers` and `readAccessGroups`, as the SQL filters them:
`listActiveAccessMembers` (enabled, not removed), `hasLabelledOnlyMember` (any status), `listAudienceAccessMembers`
(enabled audience members), `readAudiencePrincipals` (enabled members and existing groups among the ids) and
`readLiveMember` by member id, by the stdio member config (its value trimmed of edge whitespace, as `edgeTrimSql`) or by
the binding a live token or client carries (`readLiveCredential` below).

## Credential binding

The binding columns live on the token records of [access-tokens.md](access-tokens.md) and the client records of
[oauth-clients.md](oauth-clients.md); `gbrain-store` `jobs/credential_binding.rs` reads and writes them.

| Member | Returns |
| --- | --- |
| `brain.readCredentialBinding(kind, id, readsUnscoped)` | `readCredentialBindingForUpdate`: `{ member_id, may_act_for, attest_actor, attest_ops, attest_sources, attest_read }` of the token (id text, exactly) or client, with `grant_types` and `confidential` for a client and `reads_unscoped` (ISO text or null) when asked; null when no row has the id. The `FOR UPDATE` lock has nothing to wait for: the store runs one write transaction at a time |
| `brain.writeCredentialBinding(kind, id, binding)` | null. Sets the six binding columns; nothing changes when no row has the id. A client write is held to the client table's constraints |
| `brain.writeCredentialReadsUnscoped(kind, id, on)` | null. Sets `reads_unscoped` to the transaction's time, or clears it |
| `brain.readLiveCredential(via, key)` | `{ member_id, may_act_for }` of the token not revoked (`legacy_token`, id text) or the client not deleted (`oauth_client`), or null: the token and client halves of `readLiveMember` and `readMayActFor` |
| `brain.readAccessCredentials(by)` | `[{ kind, id, name }]`: the tokens not revoked with exactly `tokenName`, oldest first; or the tokens not revoked bound to exactly `memberId`, by name bytes, then the clients not deleted bound to it, by client id bytes |

A member insert with `bindTokenId` binds the token whose id text is exactly that, in the same write; no token with the
id binds nothing. `gbrain access member rm` still refuses on Rust before it writes (row 32f): its Wakeshift forget is
raw SQL that swallows its own errors.

## Trigger halves

Each runs in the same `Store::write` as the row it follows, as the Postgres trigger runs in the same statement.

| Trigger | Store |
| --- | --- |
| `access_members_mark_restricted` (v282) | a member insert sets config `access.restrictions_present` to `'1'` |
| `access_members_refresh_serves` (v309, v329) | a member insert, a disable or enable and a tombstone refresh the serves keys |
| `config_serves_refresh`, `config_serves_refresh_delete` (v309) | a config write or delete of `access.serves` or `access.serves_derived` refreshes them too |

The refresh is `gbrain_access_refresh_serves()` at read committed: `access.serves_derived` is `several` while two or
more members are enabled, else `one` (written as `one` only when the key exists); `access.serves_since` is set once,
to the microsecond, when the explicit `access.serves` (`one` or `several`, trimmed of spaces, lower-cased) or else the
derived value is `several`. Nothing clears it. A `queueWakeForget` with a member id queues only when no member with
that id is left that is not removed (the SQL's `access_members` check).

## Constraints

A write that breaks one is `constraint_violation` with the Postgres message; the TypeScript member gives it the
SQLSTATE and constraint name (`constraint-errors.ts`). A refused write changes nothing.

| Refusal | SQLSTATE | Constraint |
| --- | --- | --- |
| an id already taken | 23505 | `access_members_pkey` |
| an email another member declares | 23505 | `access_members_email_key` |
| an ill-formed member or group id | 23514 | `access_members_id_check`, `access_groups_id_check` |
| a kind other than `person` or `audience` | 23514 | `access_members_kind_check` |
| a group member that names no member | 23503 | `access_group_members_member_id_fkey` |

Keys (family `x`, `keys::ACCESS_MEMBERS`): `x 0x01 <member id>` -> the member (JSON, times in microseconds);
`x 0x02 <group id>` -> the group; `x 0x03 <group id> 0x00 <member id>` -> empty. A brain holds few members, so the email
check, a member's groups and the enabled count scan these prefixes.
