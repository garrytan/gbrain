**On a read-only mirror, the held file-drift comparison no longer points at previews that find nothing, and a pass that only re-held what a retry asked for no longer counts as progress.**

### Fixed
- On a read-only mirror, `gbrain repair file-drift --held` keeps each differing page's verdict and evidence but no longer names a `--prefer` preview, because those previews read every mirror page as database-only. It says the page stays held until the source is writable again (`gbrain sources mirror-writable <id>`).
- A stopped sync pass whose only rewritten holds were re-checked because `sync unblock` or `sources retry-held` asked, or that brought a transient hold to its attempt cap, no longer resets the abandoned-pass count.
- The sync-unblock runbook's `pass_abandoned` row, the repair guide (mirror comparison, `complete: false` on a held dry run) and the `sources status` key-file entry (`by_code` counts every hold) now match what gbrain does.

<!-- behavior-change: mirror_compare_names_writable_route_gst2869 -->
<!-- behavior-change: rehold_retry_not_progress_gst2869 -->
