**A flaky timer test is now deterministic, and every test file shows up in CI run evidence.**

### Fixed
- The db-lock heartbeat test no longer fails when a busy CI runner pauses the process. It now waits until the heartbeat fires, up to 5 seconds, instead of checking after a fixed 40 ms.
- Two export test files no longer share cases by importing one test file from the other, so each file reports its own tests when both run in one process. A new test blocks that import pattern.
- The CI health report counts a failed checkout retry step as an infrastructure failure, not a test failure.

These change only tests and CI scripts; nothing users install changes.
