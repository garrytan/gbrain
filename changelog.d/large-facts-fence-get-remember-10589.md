---
important: data-loss
---
**`gbrain get` reads a person page whose facts fence is longer than a segment, and `remember` on such a page no longer runs out of time and drops the save.**

### Fixed
- `gbrain get` (and `get_page`'s markdown view for a trusted caller) refused a page stored in segments whose `## Facts` fence runs past a forced cut when the page's source has fact withdrawals, with `page_projection_stale`. The view now measures and reads the segments such a fence spans as one run, the way the trusted body read already joins them, so the page prints whole with withdrawn rows struck and purged rows gone. Windows, digests and outlines of that view read the same run. Remote reads are unchanged.
- `remember` on a page like that rewrote the whole page for every fact: it read the body back, segmented, hashed and staged all of it again, and checked the canonical file by overlaying the whole fence in the database twice. On a page with a fence of about 1.7 MB a save could pass its 30-second preparation budget and end `preparation_stalled`, and the fact was lost unless the caller sent it again. The new fence row is now published as a splice of the segments it touches, with the same stored body, file and facts rows as before, and the file check compares the file with the stored bytes before overlaying either copy. On a 1.7 MB fence, preparation drops from about 1.7 s to about 0.3 s locally (about six times less); doubling the fence to 3.3 MB adds about 0.1 s.

Reported by @andrew-agents-bot; Part 1 read-path fix informed by @javieraldape (#10596). Fixes #10589.
