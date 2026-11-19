**A page whose text holds a U+0000 character is now saved with that character removed, instead of the whole write failing with `unsupported Unicode escape sequence`.**

<!-- behavior-change: page_writes_strip_nul_gst3170 -->

### Fixed
- put_page, put_pages, edit_page and add_timeline_entry, from a remote MCP client or the local CLI, failed with `internal_error` "unsupported Unicode escape sequence" on PGLite and Postgres when the page text held U+0000 (a pasted chat turn such as "canap" + U+0000 + "es"), because Postgres text and jsonb cannot store it, so the page was lost. The write now removes every U+0000 from the page text before it is accepted and keeps every other character as written ("canapes"), so the canonical file, the stored page and the facts and timeline rows it derives all read the same text. The count removed goes to the writer's log as `[nul_removed]`; the receipt is unchanged.
- A frontmatter value or key whose YAML escape reads as U+0000 (`"\0"`, `"\u0000"`) is read without it, so the page's frontmatter can be stored. Two keys that only U+0000 told apart are refused rather than merged, so one can never overwrite the other (`readable_by` included).
- edit_page removes U+0000 from `new_text` only. An `old_text` holding U+0000 is refused with `edit_no_match`, since stored page text never contains it, so it can never select a different span.
- Still refused as before: append_page, capture, managed sync and imports of a file holding U+0000, remember, and staged uploads through commit_page_upload.
