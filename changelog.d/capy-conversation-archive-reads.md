**The conversation archive reads OpenClaw's Gateway in far fewer process starts, and `gbrain transcripts archive status` no longer reads any session.**

### Changed
- The OpenClaw Gateway reader asks `chat.history` for pages of up to 1,000 messages within a 4 MiB budget, and reads up to 4 sessions at once. Each `openclaw gateway call` is its own process, so on a test install with 350 sessions a read went from 162 process starts and 164 s to 52 starts and 16 s. A Gateway older than 2026.10 that refuses the byte budget is asked again without it. Pages of one session stay in order, conversations keep their `sessions.list` order, and a failed session still fails the whole read before any day is written.
- `gbrain transcripts archive status` and `gbrain doctor --only transcript_archive_freshness` report what the last archive run read for each reader (conversations, newest session day, time and any error) instead of running the readers. They start no `openclaw` process and parse no session file. A reader no run has read yet says so. Each real run records this in `transcripts.archive.last_read.<source>`; a dry run records nothing.

### Fixed
- Doctor warns when no archive run has read a reader successfully within `transcripts.archive.stale_days`, for example when maintenance passes keep stopping at their deadline before that reader, and suggests `gbrain transcripts archive run`.
