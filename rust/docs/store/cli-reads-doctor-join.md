# The brain store: doctor reads of the checks from the main join

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements two `gbrain doctor` checks that came with the rust-engine/main join ran through `executeRaw`:
`access_pages_read_by_nobody` (`src/commands/doctor/checks/access-pages-read-by-nobody.ts`) and `owner_identity`
(`src/core/identity/owner.ts`). PGLite and Postgres run the same SQL as before (`src/core/engine-sql/doctor-join.ts`;
the text is pinned byte for byte by `test/engine-sql-caller-raw-sql-pins.test.ts`). The TypeScript side is
`src/core/rust-engine/store-members/doctor-join.ts`. The two page scans are store methods
(`crates/gbrain-store/src/cli_reads/doctor_join.rs`); the other members answer there from store methods other families
serve.

## Served by the store

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listPagesReadByNobody(live)` | `{ source_id, slug, readers }` for each live page whose normalized readers name none of `live` and not `!nobody`, member pages (`memory/members/`) left out, by source and slug | the labelled-page statement of the check |
| `brain.listRulePagesReadByNobody(sourceId, prefix, admittedCount, admitted)` | the same rows for the live pages of `sourceId` the folder rule at `prefix` covers that are not closed on purpose; with `admittedCount` above 0, only those whose own readers name none of `admitted` | the folder-rule statement, `ruleCoversSql('slug', '$2')` included |

`readers` is the page's `page_readers` column as `gbrain_access_readers(frontmatter)` (v282) computes it
(`facts/privacy.rs` `access_readers`): none without a `readable_by` key, the sorted distinct principals otherwise, and
`['!nobody']` for a malformed value. The SQL leaves the row order undefined and the check sorts what it keeps; the store
answers by source and slug.

## Answered from other store methods

| Member | Reads | Notes |
| --- | --- | --- |
| `listAccessMemberStatuses` | `readAccessMembers({ includeRemoved: true })` | removed when tombstoned, else disabled when disabled, else enabled; by id in byte order |
| `listAccessGroupMemberships` | `readAccessGroups(null)` | one row per group and member |
| `listGoogleSourceMembers` | `listAllSources` | the sources that are not archived with `config->>'kind'` = `google`, their `config->>'g_account'`, by id in byte order. The store keeps no personal-source bindings (`access_member_sources`; binding one is a raw SQL write a Rust brain refuses), so `members` is null for every source, as SQL's `array_agg` over no rows is |
| `listOwnerMemberLinks` | `listAccessMemberLinks(memberId)` | the member's links by system and external id in byte order |

Store tests: `crates/gbrain-store/tests/doctor_join.rs` (both scans, and the owner-only mark state of `owner_only_marks.rs`).

Statement bounds: the SQL engines run the two page scans with the check's `timeoutMs`. The store has no statement to
bound, so it reads them to the end and never reports a partial scan.
