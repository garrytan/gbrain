**Company pages that are plainly the same company are now linked across sources by themselves; a person's pages still wait for your confirm.**

### Added
- After each sync, company pages in different sources that share a LinkedIn company page, a GitHub login or a declared id and have exactly the same name are linked as one identity, so `rank_entities` and enrichment tiering count the company once. `gbrain dedupe --preview --kind auto` lists every automatic link with the command that undoes it, and `gbrain dedupe reconcile` runs the same sweep on demand. A company with a page already linked by hand or confirmed, a quarantined page, an unverified auto-extracted stub or a flagged page is left out.
- `gbrain dedupe reject <group-id>` on an automatic link removes it and records that the pages are different, so no later sync links them again.

### Changed
- A person's pages are never linked without you. A person pair that shares a LinkedIn profile, GitHub login or declared id and exactly the same name stays on the `gbrain dedupe confirm` list with a hint line naming the shared id, to be confirmed on its own, and `gbrain dedupe confirm --clean` now covers company groups only.
- `gbrain doctor`'s `entity_duplicates` check leaves automatically linked companies out of its undecided list and says how many there are.

### Fixed
- `gbrain doctor`'s reject suggestion for a confirmed decision with no group id now names its identity, which `gbrain dedupe reject` accepts, instead of a decision id it refused.
- The remedy for a duplicate decision file that does not validate says the last valid version stays applied.

<!-- behavior-change: dedupe_companies_link_automatically -->
