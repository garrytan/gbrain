---
kind: fix
---
gbrain repair ghost-pages now also keeps a page whose deleting commit rewrote another file to its content (moved_to or move_unproven), keeps a page with more than five same-name files as move_unproven, and checks the move again when a commit lands between preparing and writing a soft-delete. With sync.apply_held_deletions on, a held page whose file moved stays held, refused as file_moved, and a held deletion is passed over (the page stays held, the rest of the pass publishes, a later sync checks it again) when a commit lands before it publishes. Nothing extra is deleted; some pages that were approved for soft-delete before are now kept.
