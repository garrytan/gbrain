---
kind: fix
---
gbrain migrate embeddings now counts the database's stored embedding_model and embedding_dimensions in its convergence check. A brain whose database records the model under another name, for example without its provider prefix, is no longer reported as having nothing to migrate: --status lists the mismatch, and a run rewrites the stored name and dimensions without re-embedding vectors that are already in the target space.
