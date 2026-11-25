**`gbrain dedupe auto --apply` collapses a person's page kept twice in one source, with a backup, and holds back a few more wrong links.**

<!-- behavior-change: dedupe_auto_collapse_gst3642 -->

### Added
- `gbrain dedupe auto` now also lists class C7, two person pages in one source with the same name and a shared id, email or phone, and `--apply` collapses each pair. The newer page gets `merged_into: <older slug>` and a `dedupe_collapse` record, and the older page takes its title and aliases. Nothing is deleted or renamed. With a repository both files change in one commit, whose parent is the backup; without one, both pages are edited through the page history. A read-only source (a mirror or a URL clone) and a file with edits not committed yet are left out.
- `gbrain dedupe undo <collapse id>` takes one collapse back; `gbrain dedupe reject <collapse id>` takes it back and keeps the pair apart for good; `gbrain dedupe auto --off C7` takes back every collapse and stops the class.

### Changed
- A plan previewed before a reject, an `--off` or a page edit no longer writes over it, because every link and collapse checks again inside its write.
- `gbrain dedupe reject` of an automatic link is recorded as a correction of its class, and `gbrain dedupe sample --since` counts the corrected links; the `dedupe_auto_links` doctor line now leads with the reject command and includes collapses.
- `gbrain dedupe auto --off <class>` also removes links made while it was switching off.
- A phone number with an extension (also written `;ext=12`) is its own number, so two extensions of one switchboard no longer pair.
- Two pages whose account ids disagree are a contradiction (C6) even when another id matches, so they never link or collapse.
- A page that names another in `distinct_from` keeps the pair apart across sources, and a rejected pair stays apart after either page is renamed or moved.
- Names that disagree link automatically only when one is a handle. A title with a digit in it, or a lone common first name, is held.
- A copy of a page no longer hides the pairs of other copies that hold an email or phone it lacks.
- A relative of a founder, an investor, a client or a boss now counts as family for the hold, since that person can be you.
