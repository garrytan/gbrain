**`gbrain doctor` now warns when a held write no longer points at a live page, so you can see the quarantine a rename lifted.**

### Added
- New doctor check `write_gate_holds_stranded`. A fact or take the write gate holds names its page only by name, so after a page is renamed (a sync Git rename, `gbrain repair rename-identity`) the hold still names the old name and the page at the new name is no longer protected by it. The check lists those holds per source, separates a suspected rename from a soft-deleted page and from a name that never had a page (informational), and points at the read-only `gbrain trust review`.
- When the scan stops at its 5000-row limit or its time limit, or cannot read the rename records, or runs as a database role that has row-level security active on them, or runs on an engine that refuses the read, the check warns that the count is unknown instead of reporting ok.

### Not changed
- This check detects the problem; it does not fix it. Releasing or dropping a hold does not restore the quarantine on the renamed page or take back text already delivered. Holds that follow a page id instead of a name are a separate, later change.
