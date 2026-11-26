**On a brain that serves several people, only the owner can give, change or remove a person's household role or delete their page over MCP, so another agent can no longer learn about hidden household records by trying.**

### Changed
- On a brain that serves several people, a remote `put_page`, `edit_page`, sync row or `household_add about_role` from anyone but the owner that gives, changes or removes a subject's `household_role` is refused with one `household_reclassify` message whatever records exist. Before, giving a person with no role the role `adult` was refused only when a record about them was kept to adults, which told the caller that record existed even when it could not read it. The owner, and `gbrain household replace` on the brain host, set roles as before.

### Fixed
- On a brain that serves several people, a remote `delete_page` of a household subject from anyone but the owner is refused with one `household_reclassify` message whatever records exist. Before, the refusal counted the records about the subject, hidden ones included.
- `bun scripts/synthetic-household.ts <dir>` reserves the same `.gbrain` folder it seeds (a trailing space no longer slips past the "already exists" check) and removes that folder when seeding or saving the config fails.
- The live household check's opt-in is now `GBRAIN_TEST_LIVE_HOUSEHOLD=1`, matching the naming rule for paid opt-ins; the old name stops the run with the rename. Its no-gbrain baseline is reported in the log instead of asserted.
