# The brain store: command page reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Three commands read pages through `executeRaw`: the member-disable pages check, who-can-read and the reconcile-links
walk. PGLite and Postgres run the same SQL as before, now in `src/core/engine-sql/collate-command-reads.ts`, each
ordering its text keys by byte (`COLLATE "C"`). The store answers from its page records
(`crates/gbrain-store/src/collate_command_reads.rs`) and has no keys of its own. The TypeScript members are in
`src/core/rust-engine/store-members/collate-command-reads.ts`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listLivePagesNamingReader(principal, limit)` | `[{ source_id, slug }]` of the live pages whose normalized readers name exactly `principal`, by (source id, slug) bytes, at most `limit` | `listLivePagesNamingReader` |
| `brain.readPageAccessRows(slug, sourceId)` | `[{ slug, source_id, type, frontmatter, folder_rule_ids }]`: the page in `sourceId` (a `null` or empty id reads every source), by source id bytes | `readPageAccessRows` |
| `brain.listMarkdownPageSlugs(sourceId)` | the slugs of the source's markdown pages, by byte | `listMarkdownPageSlugs` |

## What each member answers

| Member | Notes |
| --- | --- |
| `listLivePagesNamingReader(principal)` | `brain.listLivePagesNamingReader(principal, 201)`: member disable checks 200 pages and reads one more to see a cut. A soft-deleted page is left out (`deleted_at IS NULL`), unlike `listPagesNamingReader`. A page with no `readable_by` key names nobody. |
| `readPageAccessRows(slug, sourceId?)` | A soft-deleted page is read too, as the SQL has no deleted filter. `folder_rule_ids` is the ids (`source:rule_id`) the last restamp or page write kept, `null` when it kept none, as the column reads NULL. |
| `listMarkdownPageSlugs(sourceId)` | A soft-deleted page is listed too, as the SQL has no deleted filter. |
