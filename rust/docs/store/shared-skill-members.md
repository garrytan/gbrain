# The brain store: shared-skill members and delivery batches

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The membership operations (`join_brain`, `sync_brain_skills`, `leave_brain`, `src/core/shared-skills/membership.ts`)
and the catalog identity read (`src/core/shared-skills/catalog.ts`) run through the members of
`src/core/engine-sql/shared-skill-members.ts`. The store keeps the catalog token secret of `shared_skill_state`, the
`shared_skill_members` table and the `shared_skill_delivery_batches` table. It keeps no shared-skill heads, revisions
or policies: `listSharedSkillCatalogHeads` reads `[]` and `readSharedSkillPolicyRow` reads no row, so every source has
the legacy policy (`allow_follow` false) and a join on a Rust brain binds no source. Timestamps leave as ISO strings; the
TypeScript members turn them into `Date`s.

Keys (tag `x`, `keys::ACCESS_MEMBERS`; `0x01`-`0x03` are the access members, [access-members.md](access-members.md)):

| Key | Value | Mirrors |
| --- | --- | --- |
| `x 0x04` | state record: `token_secret` | `shared_skill_state.token_secret` |
| `x 0x05 <installation id>` | member record: `installation_id`, `principal_kind`, `principal_id`, `adapter`, `brain_id`, `epoch`, `active`, `follow_policy`, `issued_sequence`, `acknowledged_sequence`, `desired_view`, `acknowledged_view`, `joined_at`, `last_seen_at`, `join_window`, `join_count` | `shared_skill_members` |
| `x 0x06 <installation id> 0x00 <token>` | batch record: `token`, `installation_id`, `epoch`, `sequence`, `view_token`, `authority_digest`, `revisions`, `issued_at`, `acknowledged_at`, `evidence` | `shared_skill_delivery_batches` |

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
| `listSharedSkillFollowSources(allowed, sourceIds)` | `[{ id, incarnation }]`: sources not archived, in both lists (null matches every source), by id in byte order, at most 65 | `listSharedSkillFollowSources` |

Each write is one `Store::write`. An issue that refuses leaves nothing behind, the prune of old batches included. On
Postgres outside a transaction the prune is its own statement and stays.

## Refusals

| Refusal | Constraint in the message | The shell throws |
| --- | --- | --- |
| a second installation for one principal and adapter | `shared_skill_members_principal_kind_principal_id_adapter_key` | code `23505` |
| a batch for an installation with no member | `shared_skill_delivery_batches_installation_id_fkey` | code `23503` |
| a batch sequence or token already present | `shared_skill_delivery_batches_installation_id_epoch_sequence_key`, `shared_skill_delivery_batches_pkey` | code `23505` |
| a batch that names a revision (the store retains none) | `shared_skill_delivery_lease`, message `revision_unavailable: delivery revision is no longer retained` | code `23503`, as the Postgres delivery-lease trigger |

Tests: `rust/crates/gbrain-store/tests/shared_skill_members.rs` (including
`delivery_batch_outside_the_replay_window_is_unread_and_pruned`, the Rust proof of the parity case that needs raw SQL to
age a batch) and `test/engine-parity/shared-skill-members.test.ts`.
