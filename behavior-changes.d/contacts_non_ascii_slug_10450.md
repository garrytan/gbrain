---
kind: fix
---
Google Contacts whose names normalize to an empty ASCII path now render using a stable contact-ID path when they have an email or phone. Original display names are preserved. Google and Apple Contacts refuse an unresolved page-path ownership collision before overwriting another contact or retiring the old page. This rendering fix does not reset existing sync cursors or automatically backfill previously skipped contacts.
