---
kind: fix
---
On a brain whose embeddings were turned off on purpose (gbrain init --no-embedding), search, query, find_experts and recall are keyword-only by design, so their results no longer carry the [gbrain degraded: ...] stamp or a degraded_recall notice, and the keyword arm finding nothing is not degraded either. An empty result now says the search was keyword-only and no page the caller can read holds those words. _meta.retrieval still records the keyword-only run. A brain with no embedding provider configured, a timed-out embed or a failed search arm is stamped exactly as before.
