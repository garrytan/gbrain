**Naming the people in `gbrain setup <harness> --members` now turns on per-member access by default.**

### Changed
- `gbrain setup <harness> --members a,b` no longer needs `--serves several`: naming the people gives each one a member, a `people/<id>/` folder only they read and a bound key. `--serves one --members ...` is refused with a fix that says to drop one or the other. A setup that names no members stays a keyless one-person setup, unchanged. Recommended by the per-member access run in harness-evals#616.

<!-- behavior-change: setup_members_per_member_default_harn1 -->
