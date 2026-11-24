---
kind: fix
---
gbrain status no longer makes a healthy keyless brain look broken. A source that keeps its pages in the database (no Git checkout) and has never synced now reads "[OK] <source> repo-less (pages live in the database; nothing to sync)" instead of "[UNKNOWN] <source> never", and a brain with embeddings off on purpose shows embed=off instead of embed=0%. A full gbrain dream cycle that ran (ok, clean or partial) now records itself (config dream.last_full_cycle), so "Last full cycle" shows it instead of "never run"; status --json carries it under cycle.last_full with name dream, plus repo_less_sources and embeddings_off.
