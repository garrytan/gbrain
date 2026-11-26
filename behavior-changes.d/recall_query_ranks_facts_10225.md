---
kind: default
---
recall with query and no fact selector (no question, entity, since, session_id or supersessions) now ranks saved facts by relevance to the query, as if question were the query, and says facts_order: relevance. Before, it returned the newest saved facts whatever the query asked, with a recall_hint notice, and agents answered from facts unrelated to the question. Facts that do not match the query are left out, so a query with no matching facts returns an empty facts list. Page results are unchanged, recall with none of query, question or a fact selector still returns the newest facts, and the recall_hint notice is gone.
