**Five small fixes from outside reports: connector sync on a brain with an active writer, Gmail bodies that are HTML labelled as plain text, `repair captured-facts` for Codex sessions, `doctor --only` on checks that need no database, and `regen:all --check` for the CLI flag registry.**

<!-- behavior-change: connectors_sync_managed_brain_9124 -->
<!-- behavior-change: gmail_html_plain_body_8937 -->
<!-- behavior-change: captured_facts_codex_sessions_9554 -->
<!-- behavior-change: doctor_only_engine_free_9527 -->

### Fixed
- `gbrain connectors sync` now imports chat history on a brain whose writes go through the writer, the way `gbrain transcripts ingest` already does, instead of being refused. (#9124, reported and first fixed by @Masashi-Ono0611)
- A Gmail message part labelled `text/plain` that is really an HTML document is now stripped to readable text instead of being stored with its raw tags and CSS. (#8937, reported and first fixed by @Masashi-Ono0611)
- `gbrain repair captured-facts` now recognises facts captured from Codex sessions, in both the live and the archived Codex session folders, instead of counting them as unclassifiable. (#9554, reported and first fixed by @Masashi-Ono0611)
- `gbrain doctor --only <check>` on a check that needs no database now reports "No finding" when the check has nothing to say, instead of a warning that the database checks stopped early. A connection that really failed still reports the stop. (#9527, reported and first fixed by @Masashi-Ono0611)
- `bun run regen:all --check` now fails when the committed CLI flag registry is out of date, by comparing it with a fresh render. (#9019, reported and first fixed by @sx4im)
