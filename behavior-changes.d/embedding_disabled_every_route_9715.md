---
kind: fix
---
With embedding_disabled set in the config file or the brain's database, no route sends page, fact, question or image text to the embedding provider (#9715): the synthesize phase-end embed, the safe-chunks, contextual-mode and secret-spans repairs, the doctor --remediate embed step, derived-writer, code and image imports, extract_facts fence facts, reindex-code, the grounding check and brainstorm now skip embedding, and gbrain embed (with its sync, connector and auto-fix callers) and gbrain reindex-multimodal refuse with the enable-command message when either plane disables embedding. Pages are stored without vectors and keyword search keeps working.
