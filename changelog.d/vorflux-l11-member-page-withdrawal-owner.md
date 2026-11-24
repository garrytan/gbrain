**A Rust brain checks a save onto the brain owner's member page against earlier withdrawals the way PGLite and Postgres do.**

### Fixed
- When a remote save lands on the member page of the brain owner, the withdrawal check (`readMemberPageWithdrawal`) now runs on a Rust brain instead of refusing. It counts a withdrawn row of any visibility. It judges a page that was derived from other pages by whether the owner reads every page it came from (the owner read rule), so a page derived from a page kept to another member stays closed.

### Changed (tests)
- Tests: a parity case for the owner read of a member page (a private row, a page derived from the owner's own page, a page derived from another member's page) runs equal on PGLite, Postgres and Rust. A Rust store test covers the owner read's origin rule.
