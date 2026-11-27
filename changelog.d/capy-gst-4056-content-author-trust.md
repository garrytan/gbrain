---
important: security
---
**A remote agent can no longer make its own text read as an imported transcript, whatever maintenance runs afterwards.**

<!-- behavior-change: importer_trust_live_text_gst4056 -->

### Fixed
- Speaker markers and transcript fence acceptance trusted a page when its first-ingest stamp named the transcript importer and the newest revision carried no remote attribution. A tag change, compaction or other maintenance cleared that attribution, so a page a remote agent had rewritten read as the importer's again. Each page now records who wrote its current text and the content hash they wrote (migration v342); only the importer's own unchanged text is trusted, a remote write names its operation, and a tag change keeps the author while a body change does not. Existing importer and connector pages with no remote writer on record are stamped by a separate backfill (migration v343); pages the old rule trusted only through their first-ingest stamp keep speaker markers and any fence acceptance the owner already recorded for their exact content, and are offered for new acceptance only once the importer next writes changed text for them. A re-import that changes only tags never makes untrusted text trusted, and `gbrain migrate-engine` copies each page's author exactly.
- Remote `put_page`, `append_page`, `capture`, streamed uploads and segmented edits now keep a page's first-ingest record (source kind, URI, channel and time), as `edit_page` already did.
