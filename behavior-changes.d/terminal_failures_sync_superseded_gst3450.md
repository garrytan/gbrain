---
kind: fix
---
Doctor's persistence_terminal_failures check and `gbrain sources writer failures` now count a refused managed-sync page import or delete as settled once any later write of the same page commits. The 24-hour and daily counts behind the spike warning leave out rows a later request superseded, so a burst of refusals that a later sync settled no longer keeps the warning on.
