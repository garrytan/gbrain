# The brain store: direction evidence and the mirror page mark

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Direction evidence (`readDirectionEvidence` in `src/core/persistence/git-gap.ts`) decides which side moved since a page
and its committed file last agreed. `gbrain sources git-gap` and the rows-behind scan read it. The mirror page mark
(`classifyMirrorPage` in `src/core/persistence/mirror-read-only.ts`) stamps a page that a publication stored
database-only in a read-only mirror source. PGLite and Postgres run one SQL text each
(`src/core/engine-sql/direction-evidence.ts`):

| Member | Reads or writes |
| --- | --- |
| `listEvidenceVersionOrigins(pageIds)` | the distinct recorded file paths of the pages' versions (empty paths left out), with each page's slug |
| `readEvidencePageStates(pageIds)` | the live pages among them: knowledge revision (text) and whether the version history has a gap |
| `listEvidenceVersionMeta(pageIds, depth)` | the newest `depth` versions of each page, newest first: size and whether the body is readable |
| `readEvidenceVersionBodies(versionIds)` | the body fields of those versions, for their content digest |
| `markMirrorReadOnlyPage(sourceId, slug)` | sets `database_only_reason='mirror_read_only'` on a page with no reason and no recorded file; returns 0 or 1 |

The evidence reads run in one read-only snapshot transaction per batch (`beginSnapshotRead({ readOnly: true })`,
REPEATABLE READ), with the export views of the same pages.

The Rust engine has no store member for any of them, so each refuses by name (`engine_capability_missing`; capability
`page_versions` for the version reads, `pages` for the page states and the mark). The store keeps no
`database_only_reason` (see [write-guards.md](write-guards.md)) and does not serve the export views the evidence compares
with, so a partial answer would report evidence it never read. It never answers an empty evidence set, which a caller
would read as "no history".

Parity: `test/engine-parity/direction-evidence.test.ts`.
