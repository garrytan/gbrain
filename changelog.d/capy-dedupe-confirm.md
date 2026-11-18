**You can now confirm or reject the duplicate people and companies `gbrain dedupe --preview` finds, and a confirmed group counts as one person in rankings and enrichment.**

### Added
- `gbrain dedupe confirm` prints the groups you can confirm, clean ones first, each with what differs between the pages (employer, title, city, birth year) and, for a group that shares only an email, phone, X handle or domain, a hint line with how many other pages carry the value. `gbrain dedupe confirm <group-id>` links one group as one identity, and `gbrain dedupe confirm --clean --expect <hash>` links every clean group in the list you read and refuses if the list changed. A group that shares only contact keys is confirmed on its own.
- `gbrain dedupe reject <group-id>` records that the pages are different people: the pair is never proposed again, a confirmed group is unlinked, and two pages in one source also get `distinct_from`.
- Your decisions are kept in `.gbrain/identity/` in the default source's repository (never another source's, so page names from other sources never reach a repository their readers may not share), committed through `gbrain git commit-push` before anything reaches the database, so a database rebuilt from git keeps them; a brain whose default source has no repository keeps them in the database. `gbrain dedupe reconcile` moves decisions the database holds alone into git, and `gbrain doctor` reports when the two disagree.
- Six new error codes: `dedupe_group_unknown`, `dedupe_group_not_confirmable`, `identity_member_in_other_group`, `dedupe_page_changed`, `identity_link_owned_by_dedupe` and `dedupe_decision_store_mismatch`.

### Changed
- `rank_entities` counts a confirmed group once, on its main page, and enrichment tiering counts the mentions in every source of a confirmed group. Groups linked by hand are unchanged.
- `entity_identity_link` and `entity_identity_unlink` refuse to move or remove a page that `gbrain dedupe confirm` linked; use `gbrain dedupe reject`.

<!-- behavior-change: dedupe_confirmed_counts_once -->
