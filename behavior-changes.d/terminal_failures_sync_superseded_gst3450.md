---
kind: fix
---
Doctor's persistence_terminal_failures check and `gbrain sources writer failures` now count a refused managed-sync page import or delete as settled once a later write of that page's content commits (a sync import, delete or page edit; a tag, link or take write does not count). The 24-hour and daily counts behind the spike warning leave out rows a committed write replaced, so a burst of refusals that a later sync settled no longer keeps the warning on.
