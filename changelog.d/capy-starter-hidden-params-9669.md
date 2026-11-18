---
important: security
---
**A remote MCP client on the starter tool surface can no longer pass parameters its tool list leaves out, so it cannot read soft-deleted pages; connector imports now write their trust marker into each new page.**

<!-- behavior-change: starter_hidden_params_refused_9669 -->

### Fixed
- A remote client on the starter surface could pass any parameter its tool schema hides, and the server honoured it. A read-only client pinned to starter could pass `include_deleted: true` to `get_page` or `list_pages` and read soft-deleted pages, and `page_not_found` told it to (#9669). Dispatch now refuses such a parameter with `param_not_on_surface` before anything runs. Its fix widens the surface with `request_tools` where the connection may widen itself, and otherwise asks the user, because only the operator widens a pinned client. A short reviewed list of hidden parameters that gbrain's own clients and fixes send stays usable on starter, each with its reason (`STARTER_CALLABLE_PARAMS` in `src/mcp/surface.ts`). The local CLI and full-surface callers are unchanged.
- Fixes and hints no longer name a parameter the caller's surface refuses: a rendered fix drops an MCP call that would be refused, and `page_not_found` on starter offers a search instead of `include_deleted`.
- A connector import stored each new page as `external_untrusted` but wrote no `trust_tier` marker into the page's frontmatter, so a re-read of its file could place it above its stored tier and doctor's `provenance_stamp_drift` count grew with every import (#9676). Every connector import now writes the marker, on new pages and on re-renders of pages stored without it. A stored marker never raises a page: the import writes the less trusted of the stored marker and its own tier. Pages imported before this change still need `gbrain repair provenance --apply` once.
