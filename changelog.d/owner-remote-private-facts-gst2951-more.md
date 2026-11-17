**The brain owner's own remote agents now get the owner's private facts on the entity and context_pack cards, in search's facts about an entity, in the list of facts saved without an entity and in forget's similar-facts check.**

<!-- behavior-change: owner_remote_fact_reads_more_gst2951 -->

### Fixed
- The `entity` card (recent facts and `active_fact_count`) and the `context_pack` cards built from it, the entity facts and saved facts that `search` and `query` attach, `extraction_pending`'s unattributed list and `forget`'s `similar_active` decided fact visibility from the raw remote flag, so a credential bound to the brain owner got world facts only. They now use the same owner rule as recall, think and `find_trajectory`, and the owner's reads use the owner-aware page rule, so a fact from a private page the owner reads stays visible.
- Nothing widens for anyone else: another member, a labelled-only member, an unbound token, a call with no credential and the owner speaking for an audience of several read what they read before, and a private-facts grant works where it already did. Member access still applies to the owner, and withdrawn facts stay out of every read.
