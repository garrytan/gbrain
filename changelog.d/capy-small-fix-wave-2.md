**Fifteen small fixes: the doctor's grant repair grants every operation it counted, call import handles single files, look-alike names and pending writes, a folder whose own `.git` is not a repository is no longer taken as a checkout, storage adopt reports what it did, and doctor's type check reads through an index.**

### Fixed
- `gbrain doctor` (grant_new_ops_available) now prints a repair that grants every operation it counted as missing from a token's or OAuth client's grant, not only `put_pages`, and its preview is the same command with `--dry-run`, which shows each changed grant line as before and after. The apply still needs your agreement.
- `gbrain import <file> --calls` imports that one call file instead of reporting success with nothing imported; a file that is not `.txt` or `.md` is reported as an error.
- Call import keeps two files apart when a redaction pattern makes their names look the same, so the second file is imported instead of being treated as the first. Pages imported before this release are still found on a rerun.
- Call import reports a write that was accepted but is still being saved as pending, with the command that reads its receipt, and exits 10 instead of counting it as a failure.
- A folder whose own `.git` is not a repository (an empty `.git` folder, or a `.git` file pointing at a missing directory) is no longer taken as its own checkout, and when that folder sits untracked inside a real repository, gbrain no longer writes its managed marker into that repository, which made writes elsewhere in it fail with `writer_coordinator_required`.
- `gbrain doctor` (type_proliferation) reads the distinct source and type pairs through a new index on pages (schema migration 316) instead of scanning every page, which took over 20 seconds on a large brain.
- `gbrain storage adopt --apply` on a hosted shelf now indexes the cards it committed, so the shelf's sync checkpoint no longer lags until a manual sync; when it cannot, it prints the sync command to run.
- `gbrain storage adopt --apply --json` counts adopted, skipped, refused and pending records and gives each write its receipt id.
- `gbrain storage adopt` reports a record cut off by its 64 KiB read as `truncated`, and says to move the `## Record` section to the top, instead of reporting the record as missing.
- Atom extraction skips the storage shelf, and doctor no longer names the shelf as a source with held atoms.
- `gbrain storage-find` reports a card asked for by its exact title as an exact hit, not as a closest match.
- An empty storage location path now says to write `/` for an item at the root of its bucket or repository.
- Sync no longer tells you to restart a `gbrain serve` that already runs your gbrain version.
- Owner sessions whose first message starts with a Claude Code slash command (such as `/clear` or `/model`) are no longer classed as launched by an agent (#9390).

### Changed
- The graduation tests bound and retry their git calls to the remote, so a hung fetch fails fast with a clear error.
