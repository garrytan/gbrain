**A test of the OpenClaw skill plugin's daily log no longer fails on a slow runner.** It didn't change what it checks.

### Tests

- `test/openclaw-skill-plugin.test.ts`: the plugin writes each daily-log line through a chain of awaited appends, and the test's Node driver exited a fixed 300 ms after its last step. On a slow runner, the 164 appends in "the daily log keeps event order when a skill read follows a turn at once" were still queued when the driver exited, so the tail of the log was lost and the check failed. The driver now waits, for at most 30 s, until the log holds the number of lines the test expects, and then exits as before. The other test that reads this log (six lines) waits the same way. A probe that slows every append by 5 ms fails the old test (109 lines lost) and passes the new one.
