---
important: security
---
- A member's connection can no longer use `sources_resolve_path` to learn that a page it may not read exists. A guessed path for a restricted or owner-private page now gets the same answer as a path with no file and no page, even when an older readable copy of that path was deleted. The brain owner's own connections read exactly what they read before. (#8761)
- The `gbrain access rule add` commands printed by `gbrain doctor`, the labelled-only create refusal, `gbrain access serves` and the federation exposure check now include the owner in `--readers`, so they are accepted on a brain with an owner set. Re-running `gbrain access serves` after applying its printed fix now reports the rule as already in place.
- `sources_resolve_path` on a plain directory with no Git history now refuses with `sync_not_applicable` (reason `plain_directory`) and a next step, instead of a raw Git error. Contributed by @Kkkkkuro.
