**Calls imported before calls were kept to their attendees can now be fixed by preview, then approval.**

### Changed
- `gbrain repair visibility --propose` now covers imported calls with no reader list: each one is proposed for the brain owner plus the teammates its `Attendees:` or `Participants:` header names, matched exactly as `gbrain import --calls` matches them, owner first. Names that match no enabled member are listed beside the proposal instead of holding the call back, and a call with no list is proposed for the owner only. With no owner set, calls are listed with the `gbrain access owner set` command and nothing is proposed. Nothing changes until the admin applies a printed command with its `--expect` hash; the owner reads every call before and after.
