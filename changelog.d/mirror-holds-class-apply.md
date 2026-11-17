**One approval now settles every held file-drift page of a read-only mirror that the whole-class preview listed, without writing the mirror's checkout.**

### Added
- `gbrain repair file-drift --held --side unknown --prefer file --whole-class --apply --expect <hash> --yes` applies the manifest the whole-class preview printed, after the user agrees to its hash. Each page is re-read first and applied only while its revision, file, hold, side, upstream version and mirror flag still match and it loses no more lines than the preview said; a sync that only rewrote hold records keeps the approval. On a read-only mirror each page takes the file's text database-only, with a page version (`gbrain revert`) and a private backup saved first, and the next sync releases its hold.
- A stopped apply prints its resume command first, then how many pages were applied, skipped and remaining, and exits 1; a rerun resumes at the next window and applies no page twice. It refuses a second apply of the same manifest (`class_apply_busy`), a manifest edited after its preview (`class_manifest_stale`) and any caller other than the local CLI.

<!-- behavior-change: mirror_holds_whole_class_apply -->
