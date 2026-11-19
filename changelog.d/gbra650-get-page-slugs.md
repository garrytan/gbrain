**Agents can read up to 50 pages in one `get_page` call, and `gbrain get a b c` reads several pages at once.**

### Added
- `get_page` takes `slugs` (up to 50) instead of `slug`. Pages come back in the order asked, each read exactly as a single `get_page` reads it. A page that is missing, or that the connection may not read, gets the same not-found entry a single read returns, so a batch never reveals which hidden pages exist.
- Remote callers get lean pages by default: the body and every safety and trust marker, without raw frontmatter and storage fields. `fields: "full"` returns each page exactly as a single read does.
- A batch stops at `token_budget` (default `mcp.batch_read_token_budget`, 12,000 tokens; at most 32,000 over MCP) or the connection's size cap, and lists the remaining slugs under `omitted` with the `next` call that reads them. The first page is always delivered, so each `next` makes progress.
- `gbrain get a b c` prints the pages in order, lists misses on stderr and exits 1 when any slug was not read. The thin client follows `omitted.next`, and against an older host it reads each page on its own.

<!-- behavior-change: get_page_slugs_batch_gbra650 -->
