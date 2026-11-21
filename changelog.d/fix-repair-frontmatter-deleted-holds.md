**`gbrain repair frontmatter` no longer brings back deleted or purged pages; restoring one now always goes through the file-drift step that asks the user first.**

<!-- behavior-change: repair_frontmatter_routes_holds_lc2 -->

### Fixed
- `gbrain repair frontmatter` used to offer every held file whose frontmatter parses as `safe: Import <path> as it is now`, and its apply imported it. For a file held because its page was deleted or purged (`file_drift`, side `deleted`), that restored the soft-deleted page or re-created the purged one, past the `gbrain repair file-drift` step that asks the user first. Two spellings of one path (`page_identity_changed`) were offered the same way. Now a file held for anything other than its frontmatter is listed `needs_review` with its hold's own fix (for a deleted page, the `gbrain repair file-drift --held --side deleted --state <state>` preview), and the repair never imports it.
- A file with no hold whose import would restore a soft-deleted page (`page_deleted`) or re-create a purged one (`page_purged`) is `needs_review` too, never a safe or interpretive change. An approval saved before this release is refused at apply for such a file.
- Two files whose paths differ only by case and name one page (for example `notes/Max.md` and `notes/max.md`) are `needs_review` too, held or not, so the repair never picks one spelling.
