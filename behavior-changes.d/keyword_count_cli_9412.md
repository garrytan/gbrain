---
kind: add
---
gbrain search and gbrain query now print how many pages contain the query's words (a literal match) on stderr, so an agent on the command line can tell "the brain has no page with these words" from "a few pages matched by meaning". When no page contains the words, the query names no known entity and rows still came back, the line reads "No page contains these words (literal match). The rows below matched only by meaning." Plain --json still prints the bare result array; --json --timings adds keyword_matches, which is counted (with the total), capped (with the cap) or unavailable (never a count of zero). The query tool over MCP now runs the same count as search and shows the same "Keyword matches" line, pointing at search with match "keyword" for the full list.
