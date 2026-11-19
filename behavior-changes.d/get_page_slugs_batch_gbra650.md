---
kind: add
---
`get_page` now reads up to 50 pages in one call with `slugs` instead of `slug`, and `gbrain get a b c` reads several pages from the CLI. Each page reads exactly as a single `get_page` would; a page that is missing or that the connection may not read gives the same not-found entry, in request order. Remote callers get lean pages by default (the body and every safety and trust marker, without raw frontmatter and storage fields); `fields: "full"` returns each page as a single read does. Replies stop at `token_budget` (default `mcp.batch_read_token_budget`, 12,000 tokens, at most 32,000 over MCP) or the connection's egress cap, and list the rest under `omitted` with the `next` call that reads on. A single `get_page` with `slug` is unchanged.
