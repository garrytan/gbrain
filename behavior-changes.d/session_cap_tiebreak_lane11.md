---
kind: fix
---
On PGLite and Postgres, when more delta or context_pack sessions than the per-client cap (1,000 per source and client) are written in one transaction, the session-state cleanup now keeps the sessions whose ids sort first by bytes among those written at the same moment, and deletes the rest. Before, the order the database happened to store the rows in decided which of those sessions kept their cursor, so the result could change after the table was rewritten or vacuumed, and the Rust engine could keep different sessions. A session whose cursor is deleted starts again at its next delta call. Sessions written at different moments are unchanged: the newest are still kept. The output of delta, context_pack and the CLI keeps its shape.
