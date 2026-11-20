---
kind: fix
---
put_page, put_pages, edit_page and add_timeline_entry now save page text that holds a U+0000 character with that character removed, and keep every other character as written. Before, Postgres and PGLite refused the whole write with internal_error "unsupported Unicode escape sequence" and the page was not saved. A frontmatter value or key whose YAML escape reads as U+0000 is read without it too, and two keys that only U+0000 told apart are refused. An edit_page old_text holding U+0000 is refused with edit_no_match. append_page and capture still refuse text with U+0000.
