---
kind: fix
---
Doctor's opt-in PostgreSQL index audit now reports invalid or not-ready live indexes from the system catalog, including partitioned parent indexes with no scan-statistics row. It keeps the existing warnings for indexes with zero recorded scans and limits the displayed names.
