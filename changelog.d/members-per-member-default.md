**Naming the people in `gbrain setup <harness> --members` now turns on per-member access by default.**

### Changed
- `gbrain setup <harness> --members a,b` no longer needs `--serves several`: naming the people gives each one a member, a `people/<id>/` folder rule and a bound key (a new rule lists only that person; an existing rule that also lists the owner is kept). `--serves one --members ...` is refused with a fix that says to drop one or the other. `--members` on a run that cannot set members up (another harness, `--instructions-only`, `--remove`, `--skills-index-only`, `--wakeshift`) is now refused before anything is written, where it used to be ignored; the refusal says to run setup again without `--members` and to label the people with `gbrain access serves several` (preview first, then `--yes`). A setup that names no members stays a keyless one-person setup, unchanged. Recommended by the per-member access run in harness-evals#616.

<!-- behavior-change: setup_members_per_member_default_harn1 -->
