---
kind: fix
---
On a read-only mirror source, gbrain repair file-drift --held without --prefer now compares each held page with its file. A page that differs from its file reads prefer_file or needs_human with its evidence (what differs and which side is newer), and one that matches reads release_hold. Only a page whose file is gone reads no_drift with database_only. Before, every held page on a mirror read no_drift with database_only, whether or not it matched its file. Every compared page in details.pages now carries an evidence field, null when nothing was read. The comparison still writes nothing, and sync holds the same pages as before.
