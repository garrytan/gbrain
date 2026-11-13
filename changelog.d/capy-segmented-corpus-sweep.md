---
important: data-loss
---
**Captured session files that mention a large entity page are extracted again instead of being stopped and later deleted.**

### Fixed
- The session sweep no longer fails every window whose facts name an entity page stored in segments (a page over about 1 MiB). Facts the extractor left without an entity and that mention such a page were checked against the page's whole body, which a segmented page refuses (`page_body_segmented`) after the model call; the window failed five times, stopped, and the session file was deleted at the un-ingested retention limit. The check now reads the page the way its writer does, so the window commits its facts onto the page's `## Facts` table, on a Git source and on a repo-less brain. Reported by @dvasselin (#9279).
- A refusal that retrying cannot change now stops its window after the one paid attempt instead of five, retention keeps the session file it holds, and `gbrain doctor` (`memory_writeback`) counts these files as held. The first sweep after an upgrade retries each such window once, so a brain with files stopped by this bug recovers with no command.
- A Gmail thread you purged while its import was still waiting to commit no longer leaves its open loops behind. `gbrain waiting` could keep listing the thread's subject and evidence quote after the purge; the sync now drops loops for threads it refused as purged in the same run when no page for them exists (#9011).

<!-- behavior-change: corpus_segmented_entity_9279 -->
