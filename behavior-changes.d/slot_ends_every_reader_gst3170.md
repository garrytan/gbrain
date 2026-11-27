---
kind: fix
---
Recall, the entity card, hot memory, an entity's saved facts, search's saved-fact matches and the local gbrain recall command now treat a person's or company's slot value (an employer, a city, a role) as ended once a later value for the same slot is saved, the way the query facts block already did. Active reads drop the ended value and history reads show its end date. The end is worked out when the facts are read, from the facts that reader can see, so a fact a reader cannot see never ends one it can, and nothing is stored.
