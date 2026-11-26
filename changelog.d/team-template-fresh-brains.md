**`gbrain setup <harness> --template team` sets up a brand-new brain for a team in one run, and naming `--members` now turns on per-member access by default.**

### Added
- `gbrain setup claude-code|codex --template team --members a,b [--groups name:a+b]` (and `gbrain access team` for the brain part alone) adds the owner and each member, groups `team` and `team-<name>`, folder rules that keep `people/<id>/` to that person, `team/` to the team and `groups/<name>/` to the owner and that group, marks members labelled-only, ties your own harness entry to the owner and writes one key per member to a 0600 file, last. It ends with who reads what and the next steps. Works on repo-less and repo-backed brains.
- It refuses any brain that is not brand-new (pages, soft-deleted pages, facts or page history, notes waiting in a source folder, or members, groups, an owner, folder rules or unbound credentials of its own) with `team_template_not_fresh`, before writing anything. `--guests`, `--transcripts`, `--shape` and `--history` are refused with it.

### Changed
- `gbrain setup <harness> --members a,b` no longer needs `--serves several`: naming the people turns on per-member access (a member, a `people/<id>/` rule and a bound key each). A setup that names no members stays a keyless one-person setup, unchanged. Recommended by the per-member access run in harness-evals#616.

<!-- behavior-change: setup_members_per_member_default_harn1 -->
