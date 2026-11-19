**`gbrain repair visibility --readers` now edits pages whose `readable_by` lists one reader per line, the way `put_page` writes it, instead of refusing them.**

### Fixed
- On a Git-backed brain, the label-only write refused every page whose `readable_by` was a block list (`readable_by:` followed by `  - alice-example` lines) with `label_edit_refused`. It now replaces the key line and its item lines with one `readable_by: [...]` line and keeps every other byte of the file. A list holding a comment, an item on its own indented line, or a block scalar (`readable_by: >-`) is still refused and left byte for byte.

<!-- behavior-change: label_edit_block_list_gbra593 -->
