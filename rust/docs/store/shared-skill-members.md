# The brain store: shared-skill members and delivery batches

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The membership operations (`join_brain`, `sync_brain_skills`, `leave_brain`, `src/core/shared-skills/membership.ts`)
and the catalog identity read (`src/core/shared-skills/catalog.ts`) run through the members of
`src/core/engine-sql/shared-skill-members.ts`. The store keeps the catalog token secret of `shared_skill_state`, the
`shared_skill_members` table and the `shared_skill_delivery_batches` table, and (`shared_skill_catalog.rs`) the
publication policies with their audit rows, the heads, the revisions and the delivery leases. `set_skill_policy`
writes a policy, so a join on a Rust brain binds a source whose policy allows following, as on PGLite. `put_skill` and
`delete_skill` publish revisions after shared publication is activated ([Publication](#publication)). Timestamps leave
as ISO strings; the TypeScript members turn them into `Date`s.

Keys (tag `x`, `keys::ACCESS_MEMBERS`; `0x01`-`0x03` are the access members, [access-members.md](access-members.md)):

| Key | Value | Mirrors |
| --- | --- | --- |
| `x 0x04` | state record: `token_secret` | `shared_skill_state.token_secret` |
| `x 0x05 <installation id>` | member record: `installation_id`, `principal_kind`, `principal_id`, `adapter`, `brain_id`, `epoch`, `active`, `follow_policy`, `issued_sequence`, `acknowledged_sequence`, `desired_view`, `acknowledged_view`, `joined_at`, `last_seen_at`, `join_window`, `join_count` | `shared_skill_members` |
| `x 0x06 <installation id> 0x00 <token>` | batch record: `token`, `installation_id`, `epoch`, `sequence`, `view_token`, `authority_digest`, `revisions`, `issued_at`, `acknowledged_at`, `evidence` | `shared_skill_delivery_batches` |
| `x 0x07 <source> 0x00 <incarnation>` | policy record: `epoch`, `policy`, `updated_at` | `shared_skill_policies` |
| `x 0x08 <audit id>` | audit record: `source_id`, `source_incarnation`, `principal_kind`, `principal_id`, `previous_epoch`, `epoch`, `policy`, `created_at` | `shared_skill_policy_audit` |
| `x 0x09 <source> 0x00 <incarnation> 0x00 <pack> 0x00 <name>` | head record: `revision`, `metadata`, `deleted`, `policy_epoch`, `updated_at` | `shared_skill_heads` |
| `x 0x0a <source> 0x00 <incarnation> 0x00 <pack> 0x00 <name> 0x00 <revision>` | revision record: `metadata`, `files`, `deleted`, `policy_epoch`, `request_id`, `created_at` | `shared_skill_revisions` |
| `x 0x0b <kind> 0x00 <lease id> 0x00 <source> 0x00 <incarnation> 0x00 <pack> 0x00 <name> 0x00 <revision>` | lease record: `principal_kind`, `principal_id`, `expires_at` | `shared_skill_revision_leases` |

Installation ids and tokens are stored as Postgres prints a `uuid` (lowercase, 8-4-4-4-12). Input follows Postgres
`uuid_in`; anything else refuses `invalid_argument` with Postgres' `invalid input syntax for type uuid` message, which
the shell throws as code `22P02`. A brain holds at most 4096 members (join_brain's quota), so the principal-and-adapter
lookup and the member count scan the member prefix. A member keeps at most `retainedBatches` batches.

The token secret is 64 hex digits from two random UUIDs, as the Postgres column default builds it. A fresh brain gets it
when the store seeds the brain; a brain created before this family mints it on the first read, in one write.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `sharedSkillTokenSecret()` | the token secret | `SELECT token_secret FROM shared_skill_state` in `readSharedSkillCatalogIdentity` |
| `readSharedSkillMember({ installationId, principalKind, principalId } \| { principalKind, principalId, adapter })` | the member row or null; by installation id only under the principal that owns it | `readSharedSkillMember` |
| `countSharedSkillMembers()` | every member, active or not | `SELECT COUNT(*) FROM shared_skill_members` |
| `enrollSharedSkillMember({ installationId, principalKind, principalId, adapter, brainId, followPolicy })` | null | the `INSERT ... ON CONFLICT (installation_id) DO UPDATE`: an existing member re-activates at the next epoch with the new policy, sequences and views reset, `joined_at` now, and the join count advanced (a window older than an hour restarts at 1). A new installation for a principal and adapter that already has one refuses on `shared_skill_members_principal_kind_principal_id_adapter_key` |
| `rebindSharedSkillMember(installationId, followPolicy, epoch)` | null | the narrowing `UPDATE` |
| `leaveSharedSkillMember(installationId)` | null | `UPDATE ... SET active=false` |
| `issueSharedSkillDeliveryBatch({ installationId, epoch, issuedSequence, viewToken, authorityDigest, revisions, token, retainedBatches })` | `{ batch, created, issuedSequence }` | the six statements of `issueSharedSkillDeliveryBatch`, in their order |
| `readSharedSkillDeliveryBatch(token, installationId, epoch)` | the batch or null: this member's, this epoch's, issued within 24 hours | the `SELECT ... FOR UPDATE` |
| `acknowledgeSharedSkillDeliveryBatch({ token, evidence, installationId, advance })` | null | the batch evidence `UPDATE` and, with `advance`, `acknowledged_sequence=GREATEST(...)`, `acknowledged_view` |
| `writeSharedSkillPolicy({ sourceId, incarnation, epoch, policy, principalKind, principalId, previousEpoch })` | null | the policy upsert and the audit insert of `set_skill_policy`, in one write |
| `readSharedSkillPolicyRow(sourceId, incarnation)` | `{ epoch, policy }` or null | `readSharedSkillPolicyRow` (one write at a time, so no row lock) |
| `writeSharedSkillRevision({ sourceId, incarnation, packId, name, revision, metadata, files, deleted, policyEpoch, requestId })` | null; before activation the engine member refuses as the SQL publication guard (code `42501`, `writer_not_quiesced: shared publication is disabled`) | the revision insert and the head upsert of a publication |
| `readSharedSkillRevision({ sourceId, incarnation, packId, name, revision })` | the revision (not deleted) or null | `readSharedSkillRevision` |
| `listSharedSkillCatalogHeads({ sourceIds, limit, sourceId, sourceIncarnation, packId, name, hidePrivate })` | heads not deleted of live sources at their incarnation, each with `current_policy` and `current_epoch` (null without a policy), in key byte order, at most `limit` | `listSharedSkillCatalogHeads`; Postgres orders by collation, which agrees for lowercase ids |
| `listSharedSkillFollowSources(allowed, sourceIds)` | `[{ id, incarnation }]`: sources not archived, in both lists (null matches every source), by id in byte order, at most 65 | `listSharedSkillFollowSources` |

Each write is one `Store::write`. A new batch leases each revision it names for 24 hours, as the Postgres
delivery-lease trigger does (`expires_at` keeps the later of the old and the new expiry). An issue that refuses leaves
nothing behind, the prune of old batches included. On Postgres outside a transaction the prune is its own statement
and stays.

## Publication

`shared_skill_publication.rs` holds the activation flag and the pack rows. The SQL engines keep the flag on
`persistence_brain` (`skill_bundles_enabled`, `writer_protocol_floor`); a Rust brain has no managed persistence epoch and
no worktree bindings, so the flag has its own record and activation checks what `skill-activation.ts` and
`activation.ts` check, in the same order: a registered canonical root (a live source with a local path), no legacy cycle
lock, no blocking write request, no effect with a recovery record, no queued or running effect. The TypeScript caller
(`src/core/persistence/skill-activation.ts`) turns each blocker into the same `writer_not_quiesced` refusal and hint.

| Key | Value | Mirrors |
| --- | --- | --- |
| `M shared_skill_publication` (`keys::meta`) | flag record: `skill_bundles_enabled`, `writer_protocol_floor`; absent means disabled at floor 1 | `persistence_brain.skill_bundles_enabled`, `writer_protocol_floor` |
| `x 0x0c <source> 0x00 <incarnation>` | pack record: `source_id`, `source_incarnation`, `pack_id`, `revision`, `manifest`, `manifest_hash` | `shared_skill_packs` |

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `readSharedSkillPublication()` | `{ skill_bundles_enabled, writer_protocol_floor }` | the `persistence_brain` read of `assertSharedSkillPersistence` |
| `activateSharedSkillPublication(dryRun)` | `{ registration_required }`, `{ legacy_lock }`, `{ blocked }` (the first blocker with its `phase`), or `{ activated, protocol_version: 2, filesystem_sources }`; a dry run writes nothing | `activateSharedSkillPersistence` |
| `readSharedSkillSource(sourceId)` | `{ id, incarnation, archived, local_path, aliases }` or null | the source read of `sourceRoot` |
| `readSharedSkillPack({ sourceId, incarnation })` | the pack row or null | `SELECT ... FROM shared_skill_packs` |
| `listSharedSkillHeadKeys({ sourceId, incarnation, packId, limit, names })` | `[{ name, revision, deleted }]` | the head-key read of a publication |
| `readSharedSkillHeadRevisions({ sourceId, incarnation, packId, limit, names })` | the heads with their revisions | the head read of a publication |
| `checkSharedSkillPublication({ sourceId, incarnation, packId, expectedPackRevision, heads, revisions })` | `{ conflict: 'pack' \| 'head' }`, or `{ pruned, capacity, incoming_bytes }` after the prune of eligible revisions | the pack and head locks, the prune and the capacity read of `validate` |
| `writeSharedSkillPack({ sourceId, incarnation, packId, revision, manifest, manifestHash })` | null; refuses `42501` while publication is disabled | the `shared_skill_packs` upsert |
| `readSharedSkillRetention({ sourceId, incarnation })` | the retained, protected and eligible counts and bytes of the source and the brain | `sharedSkillRetentionStatus` without the limits |

A publication runs in one bound store transaction (`engine.transaction`), and each statement goes through the
`FlaggingWriter` wrap: the write admission, the check, the revisions and heads, the pack and the committed receipt. A
refusal rolls the admission back too, so a Rust brain keeps no conflict receipt. Inside the transaction each canonical
file (`skills/<name>/SKILL.md`, its dependencies and `skillpack.json`) is checked against the hash it was prepared with
and staged under the source root (a temporary sibling, written and fsynced); after the commit each staged file is
renamed over its path and its directory is fsynced, and a deleted file is unlinked. A refusal removes the staging. The
receipt says `persistence.mode: 'filesystem'` and `write_through.written: true`, as on the SQL engines, so a second
`put_skill` of the same skill publishes against the files the first wrote. A file edited between the commit and the
rename is left in place and the rename refuses `source_changed`; the next publication of that skill refuses
`local_conflict` until the operator restores the published bytes.
`adoptSharedSkillpack` refuses `engine_capability_missing`.

## Refusals

| Refusal | Constraint in the message | The shell throws |
| --- | --- | --- |
| a second installation for one principal and adapter | `shared_skill_members_principal_kind_principal_id_adapter_key` | code `23505` |
| a batch for an installation with no member | `shared_skill_delivery_batches_installation_id_fkey` | code `23503` |
| a batch sequence or token already present | `shared_skill_delivery_batches_installation_id_epoch_sequence_key`, `shared_skill_delivery_batches_pkey` | code `23505` |
| a duplicate revision | `shared_skill_revisions_pkey` | code `23505` |
| a batch that names a revision the store does not retain | `shared_skill_delivery_lease`, message `revision_unavailable: delivery revision is no longer retained` | code `23503`, as the Postgres delivery-lease trigger |

Tests: `rust/crates/gbrain-store/tests/shared_skill_publication.rs`, `rust/crates/gbrain-store/tests/shared_skill_members.rs` (including
`delivery_batch_outside_the_replay_window_is_unread_and_pruned`, the Rust proof of the parity case that needs raw SQL to
age a batch) and `test/engine-parity/shared-skill-members.test.ts`. That parity case is the one stopped case in the
file's `rust-tally.tsv` row (10 equal, 1 stopped). It stops by design: the engines have no clock seam, so ageing a batch
is a test-setup limit, not a user-facing output.
