---
important: regression
---
**Re-auditing an existing shared team brain can run its history purge again, and the Google, meeting-ingestion and purge skills say what they send and where their checks stop.**

### Fixed
- The history purge for an existing shared team repo (`skills/company-brainify/HISTORY-PURGE.md`) stopped with "no export list" before committing anything, because only the new-team-brain path wrote that list. This was a regression since v0.60.761.0. The re-audit path now writes the export list from every file already in the shared repo's six folders (the team can already read them), so the purge runs as it did in v0.60.761.0. The new-team-brain path keeps its fail-closed check that every file shipped got the full read.
- `skills/cold-start`: before `gbrain google setup`, the agent now also tells the user that synced mail and calendar text goes to the configured model provider for open-loop and atom extraction (both on by default), and names the two settings that turn that off.
- `skills/meeting-ingestion`: the final save after verification keeps `facts_backstop: false` when the user declined extraction, matching the paragraph above it.
- `skills/company-brainify/HISTORY-PURGE.md`: a note at the leased push says that a branch or tag created after the remote check carries no lease, and that the verify step catches it.
