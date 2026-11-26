**`gbrain search` and `gbrain query` now say how many pages contain your words, so "nothing in the brain" is no longer confused with "a few loosely related pages".**

### Added
- The CLI prints the literal keyword-match count on stderr for `search` and `query`. With zero matches, no named entity and rows still returned, it says the rows matched only by meaning. A capped count reads `10000+`, and a count that did not finish says so instead of reading as zero (#9412).
- `--json --timings` carries `keyword_matches`: `counted` with the total, `capped` with the cap, or `unavailable` with `keyword_count_unavailable` and its reason. Plain `--json` stays the bare result array.
- The `query` operation runs the same strict keyword count as `search`, under its type, date, language and frontmatter filters, so MCP `query` shows the same `Keyword matches` line.

<!-- behavior-change: keyword_count_cli_9412 -->
