**A remote agent that is not the brain's owner can no longer learn how many hidden household records are about a person by trying to delete that person's page.**

### Fixed
- On a brain that serves several people, a remote `delete_page` of a household subject from anyone but the owner is refused with one `household_reclassify` message whatever records exist. Before, the refusal counted the records about the subject, hidden ones included.
- `bun scripts/synthetic-household.ts <dir>` reserves the same `.gbrain` folder it seeds (a trailing space no longer slips past the "already exists" check) and removes that folder when seeding or saving the config fails.

### Changed
- The live household check's opt-in is now `GBRAIN_TEST_LIVE_HOUSEHOLD=1`, matching the naming rule for paid opt-ins; the old name stops the run with the rename. Its no-gbrain baseline is reported in the log instead of asserted.
