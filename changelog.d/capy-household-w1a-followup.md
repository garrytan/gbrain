**A remote agent that is not the brain's owner can no longer learn whether hidden household records exist by deleting a person's page or giving that person a role.**

### Fixed
- On a brain that serves several people, a remote `delete_page` of a household subject from anyone but the owner is refused with one `household_reclassify` message whatever records exist. Before, the refusal counted the records about the subject, hidden ones included.
- Giving a subject with no role a role like `adult` is refused only when a record about it is kept to adults by the placement table alone, which every adult reads. A record whose `readable_by` was written narrower no longer blocks the change, so the outcome no longer reveals that such a record exists.
- `bun scripts/synthetic-household.ts <dir>` checks the same path it seeds (a trailing space no longer slips past the "already exists" check) and removes a half-written brain when seeding fails.

### Changed
- The live household check's opt-in is now `GBRAIN_TEST_LIVE_HOUSEHOLD=1`, matching the naming rule for paid opt-ins; the old name stops the run with the rename. Its no-gbrain baseline is reported in the log instead of asserted.
