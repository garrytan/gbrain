**Host transfers keep committing and pushing, sync stops storing pages no command can reach, and several repair checks stop failing or misreporting.**

<!-- behavior-change: sync_slug_too_long_10080 -->
<!-- behavior-change: transfer_carries_git_durability_10123 -->
<!-- behavior-change: gitignore_anchored_db_only_10102 -->

### Fixed
- `gbrain sources writer transfer accept` on another host carries the previous owner's Git durability to the new host (enabled only when the push probe passes there) and warns with the enable command when the new host will not commit or push. Before, every cross-host transfer silently turned durability off (#10123).
- `transfer accept`, `gbrain doctor` and every command that lists managed roots no longer abort when an old recorded root sits under a directory this user cannot enter (EACCES or EPERM); the record keeps fencing its literal path, and an unreadable record now names its file and the cause (#10122).
- Sync writes a single-folder `db_only` entry to `.gitignore` as `/folder/`, so a tracked nested folder of the same name is no longer ignored and `git pull --ff-only` no longer breaks over it (#10102).
- A page an older sync stored under a slug over 255 characters can be deleted, restored and purged, and keeps syncing and reindexing; sync now holds a new file with such a slug as `slug_too_long` (and `gbrain import` on an unmanaged brain skips it) instead of storing a page nothing can name (#10080).
- The post-write links effect reuses the per-source slug index write preparation keeps, instead of listing every slug of the source for each landed page (about 15 MB per page on a 121k-page source) (#10101).
- Remote `get_versions` lists a page's history when one stored version's segment rows no longer cover its body (a page `repair segmented-tiling` republished): that version is flagged `body_unreadable` with no size or `body_ref`, instead of the whole list failing `page_body_rows_unreadable` (#10002).
- `gbrain repair file-drift --slug <slug>` on a read-only mirror compares a held page through its hold, as `--held` does, so the command a hold's fix names no longer reports `no_drift` for it; its comparison form no longer crashes on `page.exceptions` (#9711).
- A held `file_gone` page an import stored while its source was a read-only mirror is no longer listed `side_changed` ("its file is present now") forever by `repair file-drift --held` (#9576).
