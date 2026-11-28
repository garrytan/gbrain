---
kind: fix
---
Dream synthesis has a new dream.synthesize.since setting (an ISO date or timestamp): when set, only transcripts and conversation pages from that time on become candidates, in the autopilot cycle and on the CLI, so turning synthesis back on does not process the whole retained corpus. gbrain dream --dry-run --json shows the cutoff and the candidate count. Separately, dream --date/--from/--to windows now include undated writeback transcripts by their file modification day (UTC) instead of excluding them all.
