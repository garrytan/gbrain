**Connector syncs on a distant database spend fewer round trips per item, so an unchanged re-check of contacts or mail runs about 1.6 times faster.**

### Fixed
- A managed connector sync (Google, GitHub and the rest) re-read the same run-wide rows (its lock, the source row, the owner binding, the writer grant, the mirror and slug-root modes) up to nine times for every page it read or wrote. Each is now read once per page read or write; the checks that guard a write still run under their locks when the write is admitted and published. An unchanged contact now costs about 32 database statements instead of 52, and a contact written for the first time about 181 instead of 190. On a Supabase pooler about 30 ms away, re-checking a contacts page that a previous run already wrote drops from roughly 1.5 s to under 1 s per contact (#9990).
- The contacts sweep no longer reads the owner of the same page twice when the contact's page keeps its name.
