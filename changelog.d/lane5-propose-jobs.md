**Your agent can offer jobs it could take on, found in what is already in your brain, with no model call.**

### Added
- `gbrain propose [--days 7]` and the MCP tool `propose_jobs` list five kinds of job. They are people waiting on you, email threads you owe a reply, recurring meetings with no prep page, bulk senders you never wrote to, and the same question asked in two agents. Each job gives a count, the pages it found and the installed skill or gbrain command that does it; the skill is picked by the skill resolver's word match on a fixed description, with skill vectors and the model picker off. Only the install's owner can read them (`propose_owner_only` otherwise), a remote call sees only pages it can read, and a connection with a trust floor is refused.
- `gbrain propose accept|decline <signal>` and `propose_decide` record your answer in the first-session record and read it back.
- On a new personal brain, once a Google source has synced, the first-session suggestion also offers the top job you have not answered. It is computed after the sync and cached, so session start runs no detector.
- `gbrain onboard --propose` points to `gbrain propose`.

<!-- behavior-change: propose_jobs_gst3955 -->
