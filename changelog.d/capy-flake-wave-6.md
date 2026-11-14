**Searches stay within their four-connection limit, the extraction-lag check saves a database round trip, and four tests that failed now and then for reasons unrelated to the code under test now pass reliably.**

### Fixed
- One search or query can no longer hold a fifth database connection. Reads that turn off the query planner's JIT compiler or set a statement timeout used to take their own connection without waiting for one of the search's four slots. The projection readiness check is one of these reads, so a search running while any write was open on the database server could use five connections. These reads now wait for a slot like every other read. A read whose cancel signal fires while it waits now stops at once instead of waiting for another read to finish.
- The extraction-lag check (used by `gbrain doctor` and the graph ranking) reads whether managed persistence is on at the same time as its config, not afterwards. On a remote database that saves one round trip.

### Tests
- The read round-trip test now holds each wave of queries until it settles, so it counts dependent round trips the same way however fast the database answers.
- The status-mode server test no longer fails when the lock holder's process id happens to appear inside the server's random instance id. A process id in any other field still fails it.
- Four HTTP-server end-to-end tests now remove the access members they add. Leftover members made a later test file's connection check fail.
- The search connection limit test waits for background writes from its warmup search before it starts measuring, and checks that JIT-off and statement-timeout reads respect the limit.
- The lock-wait sync test prints the rows that did not commit when it is about to fail, so a future failure names its cause.
