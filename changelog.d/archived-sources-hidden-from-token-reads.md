---
important: security
---
**Archiving a source now hides its pages from every API token, not just from search.**

<!-- behavior-change: archived_source_token_reads_gst3163 -->

### Fixed
- After `gbrain sources archive <id>`, a bearer token whose source list named that source still read its pages over HTTP when the call named no source: `get_page` by slug returned the body, and `list_pages`, `get_versions`, `get_backlinks`, `get_timeline`, `get_raw_data`, `entity`, `recall`, `chronicle_day` and `chronicle_since` all answered from it. A token's sources are now checked against the live sources each time it is used, the way OAuth clients already were, so an archived source reads as absent until `gbrain sources restore <id>` brings it back for the same token. Naming the archived source still answers `unknown_source` on every read that takes a `source_id`, `resolve_slugs` included. A token whose write source is archived, or whose every source is, reads nothing and is told so with that code, as an OAuth client whose source is archived already was. The owner's own tokens keep reading everything else.
- `gbrain access serves several --members <ids> --yes` and adding or enabling a member from the admin page over HTTP now keep conversation archive pages written while the brain was personal to the owner before the new member can read them, as `gbrain access member add` already did. Before, those pages stayed readable by the new member until the next archive run.
