---
kind: fix
---
When a later conversation page records a new employer, location or role for someone, gbrain now stores the end of the old value on the old fact (its valid_until and superseded_by, never expired_at) each time conversation facts are published or cleared. Entity facts, recall, fact lists and remember's duplicate check now show the old value as ended. The query facts block and slot history read the same as before. Existing conversation facts get their stored ends the next time their page's facts are published; nothing is rewritten on upgrade.
