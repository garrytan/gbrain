**`gbrain doctor` lists held writes that no live page matches, so you can find and settle them.**

### Added
- New doctor check `write_gate_holds_stranded`. It lists, per source, held (quarantined) facts and takes that no live page matches: holds whose page was deleted, and holds whose name never had a page. These are informational. A hold that follows its page through a rename (holds remember the page id in this release) is not listed. The check names the read-only `gbrain trust review` as the next step.
- When the scan stops at its 5000-row limit or its time limit, or cannot read the rename records, or runs as a database role that has row-level security active on them, or runs on an engine that refuses the read, the check warns that the count is unknown instead of reporting ok.

### Not changed
- The check is read-only. Releasing or dropping a hold is still the owner's call in `gbrain trust review`.
