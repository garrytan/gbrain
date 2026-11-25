**get_page grep with `a|b` now finds paragraphs holding either side, not only the literal text.**

<!-- behavior-change: get_page_grep_alternatives_3786 -->

### Fixed
- `get_page` with `grep: "uptime|SLA"` (and `gbrain get --grep 'uptime|SLA'`) used to look for the exact string "uptime|SLA", found nothing and read as "not on this page". A pipe between non-space text now also matches each side, and the response lists them in `grep.alternatives`. The literal term still matches, so a page that really holds `a|b` is found. A spaced pipe (`a | b`, a Markdown table row) or a leading or trailing pipe stays literal, as before.
