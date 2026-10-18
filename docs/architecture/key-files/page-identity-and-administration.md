# Page identity and writer administration

[Back to the index](../KEY_FILES.md). Read this contract alongside the
[page-operation entries](core-services-2.md) when changing source identity,
snapshot selection, or deliberate ownership administration.

Binding owner epochs and topology generations are cast to exact decimal strings
before resident IPC serialization, preserving values above JavaScript's safe
integer range. Reviewed admin-state fingerprints include legacy-lock identity.
Self-transfer preparation records physical before-state and intended repair in
a durable manifest; acceptance checks root, epoch, manifest and coordination
path under the native lock from the database binding. A private token-bound
temporary stamp is byte-verified before rename; changed tokens and malformed
records refuse without deleting uncertain state. Regression coverage:
`test/persistence-admin-recovery.test.ts`, `test/persistence-onboarding.test.ts`,
`test/persistence-container-preflight.test.ts`.

- `src/core/deep-research-id.ts` — canonical `gbrain-page:v1:` handles encode a An id may carry a read anchor as a third payload element (`{c: chunk_id}` for a search hit past the first chunk, `{w: cursor}` for a fetch continuation); `decodeDeepResearchId` returns the same page key with or without it and `decodeDeepResearchAnchor` returns the anchor.
  JSON pair of source ID and slug in unpadded base64url. The decoder rejects
  malformed or noncanonical encodings rather than treating them as legacy
  slugs. IDs are logical addresses, not credentials, revisions or encrypted
  metadata. Citation URLs escape each path segment. See the
  [wire protocol](../../protocol/DEEP_RESEARCH_IDS_v1.md).
- `src/core/persistence/admin-intent.ts` — whole-brain topology fingerprints
  bind a deliberate writer action to inspected state. Administration requires
  an exact action name and a fresh fingerprint; the mutation transaction
  rechecks it under metadata locks. Generic confirmation and terminal presence
  are not substitutes. This protects routine repair from accidental topology
  changes, not against a malicious trusted local administrator. Read the
  [operator procedure](../topologies.md) before changing its preconditions.
- `src/core/persistence/onboarding.ts` + `legacy-locks.ts` + `physical-root-recovery.ts` — read-only source onboarding states; exact same-host dead-lock cleanup under explicit activation opt-in; and state-bound same-owner root repair using a durable manifest and token-verified temporary stamp. #5914: `inspectPhysicalRootRecovery(root, identity, { relocated })` (`--confirm-relocated-root`) waives only the inode/birth comparison, requires the outside-root reservation and every other field to agree, returns the reservation with the live directory identity and marks the recovery `relocated: true`; `repairPhysicalRoot` then rewrites the reservation through `physical-root-record.ts` `replacePhysicalRootReservation` (compare-and-swap: already-equal is a no-op, anything else refuses with detail `stale_record`) before adopting the stamp. `physical-root-record.ts` also holds `assertPhysicalRootReservation` (native-lock callers that publish nothing: reservation worktree id plus stamp token, no inode), `readRecordedPhysicalRootReservation`, `inspectRelocatedPhysicalRoot` and `relocatePhysicalRoot` (P1.3c: a recorded path that now resolves through a symlink keeps its worktree; the reservation moves under the new `sha256(root)` name and the stamp names the new root). `physical-root.ts` `restampPhysicalRoot` handles a filesystem device id that changed while the owner token, brain, worktree, root, inode and a non-zero birth time still match (macOS can renumber `st_dev` across reboots): under the caller's outside-root native lock, one transaction verifies owner host, brain and host binding and rewrites the recorded self-transfer copies and retained topology staging identities (each only while it still names the old device); after commit the stamp and the reservation's initial device are rewritten and the event is logged, so an interruption between the two leaves a device-only change the next locked acquisition finishes. Ownership markers inside a retained topology clone stage are not re-stamped; an interrupted clone recovery that spans a device renumbering still needs source recovery. `assertPhysicalRoot` stays read-only; zero birth time or any other difference keeps the refusal. `--self-transfer` prepare/accept requires separate fresh reviewed state, preserves original reservation owner evidence and refuses uncertain records. Tests: `test/persistence-onboarding.test.ts`, `test/persistence-admin-recovery.test.ts`, `test/persistence-container-preflight.test.ts`.
- `src/core/persistence/coordination-lock.ts` — the one resolver of a worktree's native coordination lock path, used by `claimWorktree`, `reservePhysicalRoot` (managed claim and clone), `runManagedSourceClone` and `acceptWriterTransfer`. `resolveCoordinationLock(root, worktreeId, { reservation, binding }, hostId)` returns `{ path, rule }`: the recorded reservation path (always wins over env), then a transfer's recorded binding path when absolute, canonical and outside the root, then `coordinationLockDirectory`: `persistenceHome()/locks` when outside the canonical root (`persistence_home`), else `$GBRAIN_COORDINATION_HOME/locks/<sha256(root\0host)[:32]>` (`coordination_home`, absolute and no `..`, else `invalid_params`) or `~/.gbrain/persistence/locks/<namespace>` (`home_default`); a result still inside the root refuses `storage_error` before any reservation is written. `GBRAIN_COORDINATION_HOME` is on the cwd `.env` quarantine list. `repairWedgedReservation(engine, root, hostId)` (called before `claimWorktree`'s transaction and at the top of `reservePhysicalRoot`) returns at once for a missing or healthy reservation; for one whose recorded lock is inside the root (`physical-root-record.ts` `readWedgedPhysicalRootReservation`) it takes the env-independent guard `reservationRepairGuardPath` (beside the reservation, 2 s wait, else `writer_lock_unavailable`), re-checks, requires the brain id, the claiming host id and no `persistence_worktrees` row, and `repairReservationCoordinationPath` rewrites only `coordinationPath` (digest re-read before the atomic rename, `stale_record` otherwise). `onboarding.ts` reports each source's `coordination_lock` (`path`, `rule`, `old_path_wedge`, or the `directory` an unclaimed root would use; never mints a host id) and uses it for the storage preflight's `coordination_directory`. Tests: `test/coordination-lock.serial.test.ts`. `coordinationHomeIgnored(root, recorded)` reports a set `GBRAIN_COORDINATION_HOME` that applies to the root (rule 4) but names another directory than the recorded lock (`configured_directory`, `recorded_path`, `move_step`); writer status adds it as `coordination_lock.coordination_home_ignored`.
- `src/commands/doctor/checks/coordination-lock.ts` — doctor `coordination_lock_location` (read-only): warns, per source checkout or host binding of this host, when `coordinationHomeIgnored` reports the recorded lock wins over `GBRAIN_COORDINATION_HOME`, naming the recorded path and the move step. Test: `test/coordination-lock.serial.test.ts`.

`stampDeepResearchIds` uses each result's own source, including query fallback
and image paths. `fetch` independently applies the current source grant and
visibility policy. Legacy slugs resolve only when one readable live page
matches; snapshot content, identity and ambiguity count come from one SQL
statement. An encoded ID never falls back to another source. Source aliases
remain source-bound.

`writer_status` reads an existing host identity without creating one. Claim,
activate and transfer are explicit local administration paths; ordinary page
errors, startup and `doctor --fix` lead with inspection, not ownership changes.
The CLI uses the shared BigInt replacer when rendering PostgreSQL epochs.

Behavioral coverage lives in `test/helpers/deep-research-contract.ts`, its
PGLite/Postgres callers, `test/e2e/deep-research-http.test.ts` (live OAuth
rescoping/revocation), `test/deep-research-cli.test.ts`,
`test/persistence-admin-intent.test.ts`, and
`test/e2e/persistence-admin-intent.test.ts` (actual routine and deliberate CLI
sequences). These tests establish the exercised boundaries, not a universal
authorization guarantee.

## Installation and metadata migrations

The upgrade and migration command entries also carry the memory-only opt-out:
`GBRAIN_NO_AUTOPILOT_INSTALL=1` / `--no-autopilot-install` is propagated through
package installation, post-upgrade and migration orchestration. It skips service
installation and unit rewrites, not unrelated migration work. Paid reindexing
has its own `GBRAIN_NO_REEMBED=1` control.

The grandfathering batch in `src/commands/migrations/v0_13_1.ts` changes only
`frontmatter.validate`. It holds canonical page guards and row locks, rechecks
eligibility, and advances the text seal only for already-sealed snapshots.
An unsealed page stays unsealed. This preserves keyword retrieval after a
metadata-only upgrade without bypassing revision safety. The verify phase
checks only the pages this run grandfathered, keyed on `pages.id` and the
revision each write produced: a page a concurrent writer (such as a connector
re-import) rewrote or deleted since is reported as `rewritten_concurrently`,
and only a page still at that revision without `validate: false` fails the
phase. The installed-lifecycle
test and `test/e2e/grandfather-projection-postgres.test.ts` cover the actual
upgrade consequence and engine parity respectively.

## Write request ids

- `src/core/persistence/preconditions.ts` — `parseWriteRequestId`, the one place a write op's `request_id` is normalized (F6, Cat 40 Hard): a UUID passes through lowercased, any other id of 1-128 printable ASCII characters maps to its RFC 4122 UUIDv5 under `CLIENT_REQUEST_ID_NAMESPACE` (no operation name, so receipt lookups find a write by the client's string); `clientRequestIdOf` is the string admissions store in `persistence_requests.client_request_id` (v238, outside the intent digest, kept by compaction) and receipts echo as `client_request_id`. Administration writer/deactivation ids keep strict UUID checks. `remember(items)` derives child ids from the root string as sent (`childRequestId`). Tests: `test/persistence-client-request-id.test.ts`, `test/e2e/persistence-client-request-id-postgres.test.ts`.

## Suffixed slugs

- `src/core/persistence/suffixed-slug.ts` — `.md`/`.mdx`-suffixed slugs (#4807). `preparePageAdmission` refuses a new put_page/put_pages slug ending in `.md`/`.mdx` before any journal row (`invalid_params`, why, suggestion naming the bare slug, read-only `get_page` fix and verify); a live page with that exact (source_id, slug) still updates and the put_page response carries `slug_advisory` (put under the bare slug, then delete_page). `suffixedSlugDryRun` serves put_page dry runs; `suffixedFrontmatterSlugHold` holds a file import whose frontmatter `slug:` identity ends in `.md` as `frontmatter_slug_conflict`. The same admission refuses a NEW slug with a Windows reserved device segment or a segment over 240 bytes (`slug_not_portable`, suggestion from `portable-slug.ts`); a live page with that slug still updates and gets a `slug_advisory` naming the move. `:` stays valid slug grammar. `validateSlug` and path-derived import slugs are unchanged. Tests: `test/ingestion/put-page-write-through.test.ts`, `test/pathological/b5-export-unsafe-slugs.test.ts`, `test/pathological/b12-slug-segment-bytes.test.ts`.

- `src/core/portable-slug.ts` — the one slug portability rule (GBRA-130 B-5/B-12): `FILE_NAME_MAX_BYTES` (240, a name's byte budget; a leaf also reserves `.json`), `RESERVED_DEVICE_NAME` (con, prn, aux, nul, com1-9, lpt1-9, alone or before an extension), `truncateUtf8`, `portableSegment` (a reserved name gets `-<suffix>`, an over-budget segment is cut at a code point boundary) and `slugPortabilityProblem` (reason, first segment, suggested slug). Used by `persistence/suffixed-slug.ts` admission; `enrichment-service.ts` `slugifyEntity` uses its parts, so a reserved entity name mints `people/con-person` or `companies/com1-company` and an over-budget one ends in a hash of the full name. `enrichEntity` reuses a page at a slug another entity also maps to (`Aux Company` at `companies/aux-company`) only when its title names the entity, preferring the matching legacy page (or, for a long name, the untagged cut slug an older gbrain minted, when its title maps to the same full slug), else uses the hash-tagged slug or skips with `entity_slug_taken` (F8, `test/pathological/b5-enrich-entity-identity.test.ts`).
