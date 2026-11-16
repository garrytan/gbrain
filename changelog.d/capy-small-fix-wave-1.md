**Ten small fixes from outside reports: agent-session repair, doctor, the prompt hook, sync, transcript ingest and enrich.**

### Fixed
- `gbrain repair agent-session-facts` no longer counts sessions that already carry a speaker sidecar toward another session's repeated opening, so an owner session whose prompt was replayed by marked workers is no longer listed as ambiguous (#9521, reported and first fixed by @Masashi-Ono0611).
- `gbrain doctor --only memory_writeback` connects the database instead of reporting it unreachable (#9513, reported and first fixed by @Masashi-Ono0611).
- The Retrieval Reflex recipe's health check and setup steps run only its own doctor check, so an unrelated failing check no longer fails the integration (#9228, reported and first fixed by @johnerik).
- A facts-absorb job that finished by skipping (superseded, page missing, extraction off) no longer counts as proof the page was extracted, so a later rewrite that keeps the body still queues extraction (#9248, reported and first fixed by @Masashi-Ono0611).
- Task notifications and teammate messages no longer get the brain-first nudge, in the main prompt hook and in the turn-rule hook; prompts a person types are unchanged (#9163, reported and first fixed by @Masashi-Ono0611).
- A failed commit-ledger location lookup is retried on the next call instead of being remembered for the life of the process (#8870, reported and first fixed by @sx4im).
- `gbrain sync --all --parallel N` caps how many sources run at once, as its help says, and `--max-sources` still wins when both are given (#8951, reported and first fixed by @Masashi-Ono0611).
- `gbrain transcripts ingest` skips Claude Code's per-project `sessions-index.json` instead of reporting an unknown format on every run (#9115, reported and first fixed by @Masashi-Ono0611).
- The autopilot-install doctor test names its installer target, so on macOS it can no longer load a real LaunchAgent (#9545, reported and first fixed by @Kkkkkuro).
- `gbrain enrich` stops asking the provider for a prompt cache, because its system prompt is below the smallest cacheable prefix and the cache was written on every call but never read (#9541, reported and first fixed by @mattverlaque).
