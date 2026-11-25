---
kind: fix
---
gbrain status run on the brain's own machine no longer makes a healthy keyless brain look broken (a thin client reading a remote brain still shows the old lines). A source with no local folder, which keeps its pages in the database, that has never synced now reads "[OK] <source> repo-less (pages live in the database; nothing to sync)" instead of "[UNKNOWN] <source> never", and a brain with embeddings off on purpose shows embed=off instead of embed=0%. A full gbrain dream cycle over the whole brain (not one run with --source) that ran (ok, clean or partial) now records itself (config dream.last_full_cycle), so "Last full cycle" shows it instead of "never run"; status --json carries it under cycle.last_full with name dream, plus repo_less_sources and embeddings_off.
