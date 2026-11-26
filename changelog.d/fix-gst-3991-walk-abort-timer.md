**The test that checks an extract_facts page walk stops on a timer abort passes again on PostgreSQL.**

### Fixed
- The test armed its abort timer before the walk read its fence holds, so on PostgreSQL the timer fired during that read and the walk stopped before its first page. It now arms the timer when the walk reads its first page, and it still fails when the walk stops yielding to timers. Test-only change; nothing to do on upgrade.
