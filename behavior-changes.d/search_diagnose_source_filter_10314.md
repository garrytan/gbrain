---
kind: fix
---
gbrain search diagnose --json now reports source_id as null when no --source filter was given, because the search runs across every source; it used to print default. With --source, the field is that source id.
