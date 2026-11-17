---
kind: fix
---
`gbrain extract-conversation-facts` no longer asks the model for a slot (where a person lives, who employs them or their role), because asking made it save fewer facts, wishes and preferences most of all. New conversation facts carry no slot, so skip the paid `--force` re-extraction the 0.60.735.0 notice suggested for adding slots: it now adds none. A fact stored with a slot under 0.60.735.0 keeps it, and its validity window, until the part of its page it came from is extracted again (an edit there, or `--force`, which re-extracts every page); the new rows then have no slot, and those facts read as they did before 0.60.735.0. The fact text is kept either way.
