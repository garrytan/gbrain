---
kind: fix
---
An API key granted private facts no longer reads a held fact row (a private restatement waiting on a visibility proposal) through recall, query, entity or the saved-facts match unless it can read every copy the proposals name, following a chain of held copies to its end. These reads now agree with get_page, which already hid such rows. The owner's own remote callers and the local CLI read what they read before.
