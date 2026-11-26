---
kind: add
---
New: gbrain learned-keep and gbrain learned-undo (MCP tools learned_keep and learned_undo) answer the morning note. Keep marks what the nightly run learned as right and changes nothing else. Undo reverses an item through the command that owns it: a new fact is forgotten, a promise is closed as dropped, and a filled-in page goes back to its earlier version unless it was edited since. Agents that load gbrain's context at session start also get one line saying how many new things are waiting, with no item text, until the note is shown; gbrain config set learning.note.push false turns it off. Items nobody saw expire after 7 days.
