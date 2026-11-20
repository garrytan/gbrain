---
important: security
---
**An API key with private-facts access no longer reads a held fact row through recall, query, entity or any other fact read.**

### Fixed
- A held row is a private restatement waiting on a visibility proposal. A key granted private facts (`gbrain auth rescope --private-facts granted-sources`) now reads one only when it can also read every copy the proposals name, and a copy that is itself held counts only when the key can read that copy's own copies too. Before this, the page view hid such a row while the fact reads (`recall`, `query`, `entity`, `delta`, `context_pack`, the saved-facts match) could still return its text; the test reproduced it through `recall`, `query` and `entity`. The owner's own remote callers and the local CLI read exactly what they read before.
- The check is now worked out once per query instead of once per fact row, so these reads do no extra lookups per row.

<!-- behavior-change: held_row_fact_reads_gst2979 -->
