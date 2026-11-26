**A Rust brain now keeps remote-edit notices for core pages, so a remote edit of a core page goes through and `gbrain core diff` and `gbrain core ack` work.**

### Fixed
- On a Rust brain, an agent connected over MCP that edited a core page while `memory.core.remote_edit` was `notify` (the default) was refused and nothing changed, because the Rust engine had nowhere to record the notice that tells you about the edit. The edit now goes through and leaves one pending notice, as on PGLite and Postgres.
- `gbrain core diff <slug>` and `gbrain core ack <slug> --revision <token>` used to fail on a Rust brain. They now show the first pending remote edit (its time, who made it and what changed) and acknowledge edits with the same counts and wording as on PGLite and Postgres.
- `gbrain core remove <slug>` now closes the page's pending notices on every engine. On a Rust brain it used to skip that step.
- `gbrain core status`, `gbrain doctor` and the core block now list pending notices on a Rust brain, and forgetting a fact or purging a page now blanks or deletes the notices that quote it there too, so a purged claim does not survive in a saved "before" copy of a core page. Removing a source deletes its notices.
- No change on PGLite and Postgres: the same statements run, now behind four named engine methods, and the output text is unchanged.
