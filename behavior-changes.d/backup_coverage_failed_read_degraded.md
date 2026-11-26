---
kind: fix
---
The backup check no longer answers confidently when it could not read something. A backup-coverage read that fails now marks the verdict degraded (doctor says the database was unreadable during the check) or the item unknown (an install receipt or gbrain.yml that exists but cannot be read shows as an unknown row), in place of a confident answer such as a young, empty brain or no db_only tiering. A missing receipt or gbrain.yml is still simply empty, and a healthy check prints exactly what it did before.
