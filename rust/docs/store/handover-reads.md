# Member handover preview reads (`handover_reads.rs`)

`gbrain access member handover` (src/core/access/handover.ts) previews which pages, folder rules and source bindings a
leaver hands over, and `--status` reads a recorded handover. The reads are typed engine members with one SQL
implementation for PGLite and Postgres (src/core/engine-sql/handover-reads.ts). The Rust store serves them from
`rust/crates/gbrain-store/src/handover_reads.rs` and `jobs/doctor_credentials.rs`; it keeps no record of its own.

| Member | Result |
| --- | --- |
| `listHandoverReaderPages(principals, limit)` | `[{ id, source_id, slug, frontmatter }]`: the live pages whose normalized readers (`gbrain_access_readers`) share a principal with `principals`, by source id and slug in byte order, at most `limit`. |
| `listHandoverPrefixPages(sourceId, prefix)` | `[{ source_id, slug, frontmatter }]`: the live pages of the source the prefix covers (the prefix itself, or every slug under a prefix that ends in `/`), at most 5000. The SQL sets no order; the store sorts by slug in byte order. |
| `countMemberPage(slug)` | the live pages, in any source, with the slug. |
| `countMemberPageFacts(slug)` | the facts whose `source_markdown_slug` is the slug and whose source holds a live page with it. |
| `countMemberBoundCredentials(memberId)` | the member's tokens not revoked plus every OAuth client bound to it (a deleted client counts, as the SQL does). |
| `readLastUndoneHandoverId(memberId)` | null: the store keeps no handover records. |
| `readHandoverRow(by, value)` | null, for the same reason, so `--status <id>` answers `not_found` as the SQL engines do for an id they do not hold. |
| `listMemberSourceRows(memberId)` | `[]`: the store keeps no member-source bindings (`read_shared.rs`). |

A handover's apply (`--yes`) and undo (`--undo`) write the handover record, member-source bindings, folder rules and
page readers. On this engine they refuse `engine_capability_missing` (`raw_sql`) before any read or write
(`refuseHandoverWrites`), so no handover record or binding can exist here and the null answers above are exact.
