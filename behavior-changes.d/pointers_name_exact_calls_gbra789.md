---
kind: fix
---
The brain-page pointers gbrain adds to an agent's turn now name calls that work. A page pointer reads "use get_page {slug: "<slug>"} before relying on details", and the pointer block adds "If get_page is not in your tool list, call request_tools {tools: ["get_page"]} first; if it still is not callable, this connection cannot open pages, so say that rather than answer from memory." for the starter tool list, where get_page is not listed. Entity cards in context_pack and turn context read "use entity {name: "<slug>"} or get_page {slug: "<slug>"}", with source_id when the card is from another source. entity called with slug instead of name now says "entity takes name, not slug." and names the exact entity {name: ...} call. No tool grant changed.
