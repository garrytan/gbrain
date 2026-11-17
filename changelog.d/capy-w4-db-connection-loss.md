**Long-running gbrain processes recover from a lost database connection: a bounded read cancelled while the database stops answering frees its connection at once, and the background job worker keeps running through a PostgreSQL shutdown instead of exiting.**

### Fixed
- A bounded read (a statement with a time limit) whose caller cancels it after it has a connection now sends the database a cancel request, discards that connection and returns at once. Before, the call waited until the database answered, and the connection stayed reserved the whole time, so a process that hit a stalled socket or pooler again and again could run out of connections. (#8155)
- `gbrain jobs work` no longer exits when PostgreSQL shuts down and removes its local Unix socket (`connect ENOENT <dir>/.s.PGSQL.<port>`). The worker reconnects and claims again on its next poll, the same as for other lost connections. A first connect to a socket path that doesn't exist still fails at once. (#9540)
