---
important: security
---
**Link context no longer shows remote callers private or held fact rows: get_backlinks, get_links, traverse_graph, the entity card, context_pack and delta's belief changes leave that text out for callers who may read only world facts, and context_pack's always-loaded core block leaves held rows out for them too.**

### Fixed
- A link's stored context is a short excerpt of the page around the reference. When the reference sat in or next to a page's `## Facts` table, the excerpt carried rows of that table, including rows saved private and world rows held until the operator accepts a widening. Remote callers who may read only world facts (another member, an unbound token) read that text through get_backlinks, get_links, traverse_graph walks, the entity card's edges and context_pack's cards. An attendance edge, stored on the attendee's page but cut from the meeting page, carried the meeting's rows the same way. For those callers, a context cut from a page that has a facts or takes table is now returned only when it reads, word for word, inside that page as the caller may see it; otherwise it comes back empty. A context written by add_link or derived from frontmatter, and contexts cut from pages with no such table, are unchanged.
- `delta` with `beliefs: true` returned each changed link's stored context in its before and after values. Those callers now get the link change without the context.
- With `memory.core.enabled` on, context_pack's core memory block showed those callers a core page's held rows. It now leaves them out, as get_page does.
- The owner's remote callers and the local CLI read exactly what they read before. Stored links are not rewritten and no migration runs.
