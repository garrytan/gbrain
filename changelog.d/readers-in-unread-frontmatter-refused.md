**A page whose frontmatter fence is indented no longer stores open when it names readers.**

<!-- behavior-change: readers_in_unread_frontmatter_refused -->

### Fixed
- A page that opened with ` ---` (a space, tab or no-break space before the fence), `----`, `+++`, or a fence that never closes, and then listed `readable_by` (in block style or as a `{title: Example, readable_by: [alice-example]}` flow mapping), used to save with no readers at all, because gbrain reads frontmatter only when the fence is in the first column. Every member could then read it. `put_page`, `edit_page` and `capture` now refuse it with `invalid_frontmatter` (reason `ambiguous_protected_key`) and store nothing, large uploads and large local captures refuse it the same way, and git sync and `gbrain import` hold such a file while the rest of the source still syncs.
- Start both `---` fences in the first column and write `readable_by: [alice-example]` on its own line, then check who can read the page with `gbrain access check --token <name> --as <member>`. A page that opens with an indented fence and names no readers saves as before, and a block with its fence in the first column is read exactly as before. Pages already stored this way are not rewritten, and `gbrain doctor` does not count them yet.
