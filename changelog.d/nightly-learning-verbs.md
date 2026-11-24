**You can now keep or undo what the nightly run learned, and your agent hears about it when a session starts.**

### Added
- `gbrain learned-keep <ids>` (MCP tool `learned_keep`) marks items from `gbrain learned` as right. `gbrain learned-keep all` keeps every pending change from the last 7 days. Keep writes only the note's own record; no page, fact or loop changes.
- `gbrain learned-undo <ids> [--reason "<why>"]` (MCP tool `learned_undo`) reverses an item through the command that owns it: a new fact is forgotten, a promise is closed as dropped, and a filled-in page goes back to the version before it was filled. A page edited after it was filled is never overwritten; undo refuses and prints the `gbrain history` and `gbrain revert` commands instead. A disagreeing pair of facts is answered by rejecting the newer one, on the brain host only; a remote caller gets the command to run there. A possible duplicate hands back its `gbrain dedupe reject` command, and a row you typed in a Facts table is edited on the page. Pass ids as `12,15`.
- Both verbs act only on items the caller can read now, need write scope over MCP, and run the same checks a direct call to forget, loops or revert would.
- At session start, agents that load gbrain's context (MCP context packs and OpenClaw) get one line saying how many new things the nightly run learned, with no item text, until the note has been shown. Compactions don't repeat it. `gbrain config set learning.note.push false` turns it off.
- Items nobody saw expire after 7 days. A disagreement answered with `gbrain decide` closes its item, and a duplicate question that `gbrain dedupe` no longer offers closes too. Duplicate questions you have not answered stay open until you do.
- `docs/guides/morning-note.md` explains the note, keep, undo and the count line.

### Fixed
- A page that was filled in and then edited before the nightly run is still listed as filled in. A revert back to a filled-in version still lists nothing new.
- A restricted token's `gbrain learned --stats` no longer says the ledger was truncated because of rows it cannot read.
- `gbrain dedupe` no longer offers confirm for a cross-source group that holds two pages from one source.

### For contributors
- `test/learning-decide.test.ts` covers keep and undo for every item kind, expiry, the session-start line and restricted stats on PGLite and Postgres.
