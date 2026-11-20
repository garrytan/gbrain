---
kind: fix
---
get_page and get_versions with known_as_of now show a remote token bound to the brain owner the recorded history its current-time get_page shows: private editions of the page now at the slug, and the owner's view of a page's Facts fence. Before, every remote caller got only history recorded while the page was world-visible, so the owner's own agents read less than the owner. An edition whose own readable_by left the owner out stays hidden, and an earlier page that once held the slug keeps the world-only rule. Every other remote caller, another member or an unbound token, reads exactly what it read before.
