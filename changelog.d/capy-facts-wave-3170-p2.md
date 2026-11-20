**Fact reads now treat an employer, city or role as ended once a newer one is saved, everywhere the query facts block already did.**

<!-- behavior-change: slot_ends_every_reader_gst3170 -->

### Fixed
- Recall, the entity card, hot memory, an entity's saved facts, search's saved-fact matches and local `gbrain recall` end a slot value (employer, city, role) when a later value for the same slot is saved, as the query facts block already did. The end is derived when the facts are read, from the facts that reader can see, so a fact hidden from a reader (another member's private fact, a flagged or quarantined one, one below the trust floor) never ends a fact it can see. Nothing is stored. A read with a limit still fills it after dropping ended values, and the entity card's fact count leaves them out.
