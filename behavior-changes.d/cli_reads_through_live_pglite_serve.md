---
kind: fix
---
While a gbrain serve holds a PGLite brain (the stdio server gbrain setup claude-code or codex starts for an agent session), everyday CLI reads (gbrain find, list, search, query, get, tags, links, backlinks, timeline, history, graph, whois, entity, search-exact and gbrain waiting) now go through that running server and print what they print with no server running, instead of refusing with pglite_busy. Admin commands that need the database to themselves still refuse as before, and so does a read run with read-affecting GBRAIN_* variables or provider keys the server does not share. A server started by an older gbrain answers owner_unavailable until it is upgraded and restarted.
