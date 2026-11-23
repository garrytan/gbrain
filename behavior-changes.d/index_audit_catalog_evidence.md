---
kind: fix
---
The opt-in PostgreSQL index audit reports the raw number of zero-read indexes and distinguishes valid write-enforcing indexes and indexes on empty heap tables from those requiring workload review. It checks partition parent validity without requiring physical read counters for parents. Invalid indexes, unavailable statistics and remaining unexplained zero scans still warn.
