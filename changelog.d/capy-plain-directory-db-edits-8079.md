---
important: data-loss
---
**A plain-directory source no longer loses database edits to an old file on sync.**

<!-- behavior-change: plain_directory_db_edits_8079 -->

### Fixed
- On a managed brain, syncing a plain-directory source (a folder with no Git checkout) used to import every file whose bytes differed from its page, so a page edited only in the database (for example a put_page with `sync.write_through` off) was overwritten by its unchanged old file on the next sync, and again on every autopilot run. Sync now keeps such a page and refuses that one file (`file_drift`, reported as a failed file) until you pick a side: update the file to match the page, or import the file explicitly with `gbrain import <file> --source <id>`. The rest of the source keeps syncing, and a later file edit still imports after a write that wrote or imported the file (a large file imported in place included) or after you matched the file to the page, whatever its layout. Reported and first fixed by @javieraldape (#9965, #8079).
