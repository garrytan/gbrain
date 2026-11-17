---
kind: fix
---
`gbrain extract-conversation-facts` no longer asks the model for a slot (where a person lives, who employs them or their role), because asking made it save fewer facts, wishes and preferences most of all. New conversation facts carry no slot, so re-extracting pages with `--force` no longer adds slots: skip the paid re-extraction the 0.60.735.0 notice suggested for them. Facts already stored with a slot keep it, and the facts block still works out their validity windows.
