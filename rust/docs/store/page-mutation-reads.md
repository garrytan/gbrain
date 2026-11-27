# The brain store: page mutation reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

A page write (`put_page`, `capture`, `revert_version` and the other page mutations in
`src/core/persistence/page-mutations.ts`) reads the stored page and its versions before it admits the write. PGLite and
Postgres run the SQL in `src/core/engine-sql/page-mutation-reads.ts` (`PAGE_MUTATION_READS_SQL`, the statements the
caller ran). The store answers from the page and version records the other families write
(`crates/gbrain-store/src/page_mutation_reads.rs`). It keeps no records of its own and adds no key prefix.

| Member | Returns |
| --- | --- |
| `brain.readStoredPageHead(sourceId, slug)` | `{ type, trust_tier, title, frontmatter }` of the page at the slug in the source, a soft-deleted page too (the statement has no `deleted_at` filter), or null. A record the store never stamped reads `trust_tier` as `unknown`, the column default. A remote `put_page` unquotes a page's own quoted read against it |
| `brain.readVersionSourcePath(versionId, pageId)` | The version's `source_path` when the version belongs to the page, else null. A `revert_version` on an unclaimed rooted source whose current revision has no file is judged file-backed by it |

The enforced member CLI (`GBRAIN_ENFORCED_MEMBER`, `src/cli/enforced-member.ts`) reads four more things around a write; the SQL is in the same
file (`readStoredPageLabels`, `readSlugFolderRules`, `memberViewPolicySql`, `hiddenSlugsPolicySql`). The two that judge a page by the member's read
policy take it as the TypeScript member renders it (`enforcedMemberPolicy`, `store-members/page-mutation-reads.ts`): the member renders the SQL
fragment in the caller's record, compares it with the same fragment for a fresh record of just the identity, the rules the member satisfies and
the record's pending prefixes, and sends the store the flags of that text (`identity`, `satisfiedRuleIds`, `folderCoverage`, `ownerOnly`, `open`).
A policy that is not that text refuses `engine_capability_missing` before any read: a labelled-only grant, a read through lineage
(`access.members_read_lineage`), an audience or an owner record.

| Member | Returns |
| --- | --- |
| `brain.readStoredPageLabels(sourceId, slug)` | `{ type, frontmatter, compiled_truth, timeline, body_storage, body_bytes }` of the page at the slug in the source, as stored: a soft-deleted page too, and no withdrawal overlay (`getPage` overlays one, so it is not the read). A segmented page's two body columns are null, so the label check refuses it. Null for no such page |
| `brain.readMemberPageReadable(sourceId, slug, policy)` | Null when the source holds no row at the slug (a soft-deleted row is a row); else whether `policy` (the member's access and the privacy part, `page_hidden`) admits it. The label check and the pre-write check of every enforced put start here |
| `brain.readSlugFolderRules(sourceId, slug)` | The `<source>:<rule id>` of every rule of the source whose prefix covers the slug, by rule id (`gbrain_access_folder_rules`), whether or not a page exists there; null when none does. A create judges its new slug by it in TypeScript. The same read is what row 32e-b-3 needs |
| `brain.readHiddenPageSlugs(slugs, hiddenSources, policy)` | The slugs that name a page in some source and no page `policy` admits outside `hiddenSources` (a soft-deleted row counts), in byte order. It point-reads each requested slug in every source, archived ones included, and never scans the brain's pages, so it costs the slugs asked and not the size of the brain. The output guard for shared-operation results containing candidate strings. The checked shared mutations (put, edit, append, add or remove a link or tag, add a timeline entry, remember) also ask it of no slugs after their target checks and before their handlers, so an unsupported-policy refusal writes nothing. get_write_request is non-mutating and skips that preflight. A shared read that reaches this guard is refused after its read; CLI-only commands and results without candidate strings do not necessarily call it |

A labelled-only member's read is not served: `readMemberPageReadable` refuses `engine_capability_missing` before any read, so a labelled-only
member's put on a Rust brain stops before it writes anything (row ec05-1 of `docs/designs/RUST_ENGINE.md`, pinned in
`test/rust-stop-pins/ec05-enforced-member.tsv`). Tests: `crates/gbrain-store/tests/enforced_member_reads.rs`,
`test/engine-parity/enforced-member-reads.test.ts`, `test/token-member-cli-parity.serial.test.ts`.

`capture --file` reads the source's local path through `readSourceLocalPath`, the member
[memory_mutation_reads.md](memory_mutation_reads.md) documents (the same statement).
