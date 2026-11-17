**One preview now lists every held file-drift page of a read-only mirror under one hash, so a person can review the whole class at once.**

### Added
- `gbrain repair file-drift --held --side unknown --prefer file --whole-class` (also `--side database` or `both`) walks every window of held pages into one manifest with one hash. It prints the total lines lost, the 50 pages that lose most, the pages kept held and why, and the data-loss card. It refuses `--prefer database` and `--side deleted` (`whole_class_prefer_unsupported`) and a class whose backups would pass the recovery-bytes limit (`class_capacity_exceeded`). Applying the manifest is not available yet.

### Fixed
- On a read-only mirror, the held window previews (`--held --side unknown --prefer file`) no longer read a page whose file is newer as `no_drift`; they list it `prefer_file`, the same way the held comparison does. The comparison now names the whole-class preview instead of `gbrain sources mirror-writable`. A held deleted page whose file differs names keeping the deletion first and `mirror-writable` second, never a `--prefer file` preview.

<!-- behavior-change: mirror_holds_whole_class_preview -->
