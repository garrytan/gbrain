---
kind: add
---
gbrain bundled-skill --json, with no skill name, now includes skills_root: the absolute path of the skills folder of the gbrain that is running (found from the running gbrain, not the current directory), or null for a single-file binary whose skills live only inside it. Tools that read gbrain's skills or skills/conventions can use it instead of walking up from the gbrain binary. Nothing else changes.
