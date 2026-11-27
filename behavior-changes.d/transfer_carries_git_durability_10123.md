---
kind: fix
---
gbrain sources writer transfer accept on another host now records the previous owner's Git durability on the new host's binding: disabled as it was, enabled only when the read-only push probe that git-durability --enable runs passes on the accepted checkout. When it is not enabled, the accept result carries a git_durability_not_enabled warning with the enable command, and the probe failure when one stopped the carry. Before, the new host's setting was always unrecorded, so page writes there were silently never committed or pushed.
