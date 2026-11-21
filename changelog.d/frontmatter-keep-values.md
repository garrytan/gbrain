**Frontmatter values are kept exactly as you wrote them: dates, timezone offsets, zip codes like 02134 and versions like 1.10 no longer change when a page is stored, read, exported or edited.**

### Fixed
- Dates in frontmatter stay the text written instead of a UTC timestamp, timestamps keep their offset, and numbers whose text does not print back the same (02134, 1.10, 1.0) stay as written. get, export and write-back files show them as written, and a one-word body edit no longer rewrites them in your Git file. Pages stored by an earlier release get their written values back on the next sync or the first write, once per page. (pages-03)

<!-- behavior-change: frontmatter_values_as_written_pages03 -->
