**A remote agent that is not the brain's owner can no longer learn how many hidden household records are about a person by trying to change that person's role.**

### Fixed
- On a brain that serves several people, a remote `put_page` or `edit_page` from anyone but the owner that would make a subject a child, or remove its `household_role`, is refused with one `household_reclassify` message whatever records exist. Before, the refusal counted the records about the subject that were shared with helpers, including records the caller could not read. The owner, and `gbrain household replace` on the brain host, still reclassify as before.

### Added
- A live check that Claude Code and Codex get the same household answer through gbrain, and that their own notes files alone miss part of it (`test/e2e/household-cross-harness-real.serial.test.ts`, opt-in with `GBRAIN_TEST_HOUSEHOLD_LIVE=1`). `bun scripts/synthetic-household.ts <dir>` seeds a keyless brain with the invented household it uses.
