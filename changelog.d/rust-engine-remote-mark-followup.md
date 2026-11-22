**On the experimental Rust engine, a write a model picks inside a local job or a SkillOpt run now reaches the owner as a remote call and is refused, and the owner no longer picks up the permissions of the call that started it; nothing selects the Rust engine yet, so PGLite and Postgres brains are unchanged.**

### Fixed
- A brain tool a subagent job runs, and a tool a SkillOpt run gives its model, now count as remote callers on a Rust brain, as an MCP call does. Before, such a write reached the owner as a trusted local call. The job's own writes stay local.
- A Rust brain's owner now starts with no caller's permissions, remote mark or cancel signal, even when a remote job is the first to load the engine.
- If a Rust brain refuses to start its owner because the runtime would pass on the caller's context, the next connect tries again instead of failing for the rest of the process.

### Changed
- The `owner_unavailable` advice now says the owner holds back every call to the member that would confirm a started write, not only calls on the same key.
- The `owner_ipc_peer_refused` advice now says a socket may have group or other permission bits only inside a private 0700 directory of this user, and names the systems where only file permissions guard the owner socket.
