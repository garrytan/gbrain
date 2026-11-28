# The brain store: doctor reads over sources

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements that `gbrain doctor` checks (and the helpers they call) ran through `executeRaw` against the
`sources` table. PGLite and Postgres run the same SQL as before (`src/core/engine-sql/doctor-sources.ts`; the text is
pinned by `test/doctor-sources-sql.test.ts`). The store answers from its source records
(`crates/gbrain-store/src/cli_reads/doctor_sources.rs`) and has no keys of its own. The TypeScript side is
`src/core/rust-engine/store-members/doctor-sources.ts`: it reads the store once per call, then filters and projects the rows
as each statement did.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listDoctorSources()` | every source, archived ones too, as `{id, name, local_path, archived, config, incarnation, last_sync_at, chunker_version}` in id byte order (`default` is not forced first) | the `sources` columns the statements select |
| `brain.listSourceIdsWithLivePages()` | the ids of the sources that hold a live page, in id order | `SELECT s.id FROM sources s WHERE EXISTS (a live page)` |
| `brain.countDefaultSourceFiles()` | `{live, file_backed}`: the live pages of the `default` source and those that record a source path | the `COUNT(*)` and `COUNT(*) FILTER (WHERE source_path IS NOT NULL)` over `default` |

The engine members are `readDoctorSources(variant, scope)`, `listGuestSourceRows`, `listCheckoutRoots`,
`listPendingRoster`, `listOwnedContentRows`, `countDefaultSourceFiles` and `listAdoptedSkillPackSourceIds`.

## How each variant of `readDoctorSources` is answered

`roots_live_ordered`, `roots_live_fallback`, `live_path_ids` (scoped by `sourceIds`), `relative_paths`, `pathless_live`,
`paths_scoped` (archived ones included), `strict_git`, `google_connectors`, `guest_marked_ids`, `first_two_ids`, `all_ids`,
`ids_with_live_pages`, `local_path_state`, `storage_shelf`, `brain_writer_by_id`, `brain_writer_live`, `live_incarnations`,
`connector_keys`, `freshness`, `shared_skills_view`, `detached` and `claim_candidates` are served: the same filter and the
same columns as the statement, over the store's rows. The `config` column is the source's config object; a connector kind
is one of `google`, `github`, `meetings`, `slack`, `imessage`.

`config_shape` (sources whose config is not a JSON object) answers empty: the store keeps a config only as a map, so no
source has any other shape. `synopsis_ids` answers empty: no store writer sets a source's contextual retrieval mode, so no
source runs the synopsis tier. Neither reads the store.

Statements with no `ORDER BY` in SQL (`roots_live_fallback`, `live_path_ids`, `local_path_state`, `live_incarnations`,
`connector_keys`, `freshness`) answer in id byte order here; `default` is not forced first.

## Columns the store keeps no value for

| Column | Read as |
| --- | --- |
| `last_commit` (`strict_git`, `detached`, `freshness`, the roster) | null |
| `newest_content_at` and `upstream_checked_at`, `upstream_commit`, `upstream_behind` (`freshness`) | null |
| `managed` (`listPendingRoster`) | false; the roster root is the source's own `local_path` |

A source's `last_sync_at` is served as a `Date`.

## The other members

- `listGuestSourceRows`: the sources whose config says `guest`, with `writers` and `ceiling` null (the store has no
  `guest_sources` rows).
- `listCheckoutRoots`: the live sources' paths with their ids; there is no worktree binding, so the host half of the union is
  empty and `hostId` is ignored.
- `listPendingRoster`: the live sources with a path, scoped by `sourceIds`.
- `listOwnedContentRows`: empty. A gbrain-owned content source needs a persistence brain, a worktree binding and a shared-skills
  receipt, none of which the store has, so no source qualifies.
- `countDefaultSourceFiles`: the store scans the `default` source's page records; a page is file-backed when it records a source path.
- `listAdoptedSkillPackSourceIds`: the sources other than `default`, archived ones included, whose shared skill pack has at
  least one head that is not deleted. It reads `listDoctorSources`, then `readSharedSkillPack` and `listSharedSkillHeadKeys`
  for each source; this mirrors the `EXISTS` join of `shared_skill_packs` and `shared_skill_heads` on the source's
  incarnation. The doctor `sync_freshness` check uses it to exempt read-only pack sources.

The shared `scan_live_pages` of `cli_reads/sources.rs` supplies the live-page ids behind the two page-reading methods.
