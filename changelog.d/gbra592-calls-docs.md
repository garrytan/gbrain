**The company-brain tutorial explains how imported calls are kept to the people on them, and the `--propose` preview no longer lists a partly matched call as "nothing is proposed".**

### Changed
- `gbrain repair visibility --propose` lists a call that was proposed with some names left out under its own heading, "Proposed with names left out", instead of under "Unmatched: nothing is proposed for these". It also reads only the first 8,192 characters of each call, which holds the header, so a brain with many long calls previews faster.
- The meeting-ingestion skill writes no `readable_by` on a brain shared by several people.

### Fixed
- The changelog entry for `gbrain repair visibility --propose` covering imported calls said names are matched exactly as `gbrain import --calls` matches them. That is not quite true: `--propose` reads the call header as it was stored, so an address that import redaction blanked cannot be matched, and that name is listed instead of matched.

### Docs
- docs/tutorials/company-brain.md: "Calls are kept to the people on them" covers how `gbrain import --calls` picks readers, the `calls_not_scoped` notice, how to label calls imported before, and that agent-written meeting pages are labelled by hand or with a folder rule.
