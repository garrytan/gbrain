---
kind: fix
---
On a brain with embeddings off on purpose (gbrain init --no-embedding), search and query no longer print "[gbrain degraded: held_files]" saying pages are held from embedding, and no longer suggest gbrain embed --held. Such a brain never embeds anything, so a held page is not missing from any search it can run. _meta.retrieval.coverage drops its embedding_held count there too. Brains with embeddings on keep the notice and the count.
