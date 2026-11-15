**Guest notes now refuse writes from a database role that cannot see which sources are guest sources, and several smaller guest-note gaps from the first release are closed.**

A brain whose gbrain process connects to Postgres as a scoped row-level-security role used to read the guest source list as empty, so a write into a guest source passed as if the source were ordinary. Such a role is now refused with `writer_coordinator_required` until it can read `guest_sources` (one SELECT policy, added to the maintainer recipe in docs/ENGINES.md). The owner, a role that bypasses row-level security and PGLite brains see no change.

### Fixed
- Schema migration v314 re-creates the guest guard in the trust trigger and the guest-record guard so they refuse a role that row-level security keeps from reading `guest_sources`; guest admission, `remember`, links and remote deletes refuse the same way instead of treating the source as ordinary.
- `gbrain guests promote` no longer answers `already_promoted` when the kept page was purged, so promoting again writes the page and keeps one link. v314 adds a unique index on the promotion link (a brain that already holds duplicate links keeps them, gets no index and a warning), and two promotions of the same note to the same page that race each other both succeed with one link.
- A guest note whose mark writes no row now fails the save instead of committing a guest page with no mark.
- `gbrain guests init` counts the source's pages under the source row's lock, so no page can land between the check and the change.
- The repair `gbrain doctor` suggests for a source whose config says guest but has no guest record, `gbrain guests init --source <id> --yes`, now works when the source holds pages.
- A cycle phase skipped because the guest-source lookup failed now says the lookup failed (`reason: guest_source_lookup_failed`, with the error), instead of reporting a plain guest-source skip.
- A read the guest-note stamp cannot copy is refused, instead of marking the handler's own object.
- A page write on a brain whose schema is behind the guest-notes migration is refused `migrations_pending` instead of failing with a missing-table error.
- The owner-credential read behind `gbrain guests grant-owner-clients` and doctor's `guest_source` check no longer loads token hashes.
- `gbrain auth rescope --client <id>` with no grant flag now prints the client's operations and slug prefixes, and `gbrain delete --help` says `--expected-revision` is required unless `--force`.
- docs/guides/guest-notes.md gives the setup order that works (init, register the broker client, rescope its operations, then add it as a writer), and says that deletes need a revision or `--force` and that a put with attribution but no audience is refused `readable_by_invalid`.

<!-- behavior-change: guest_sources_scoped_role_fail_closed_9354 -->
