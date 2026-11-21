**New: `gbrain engine swap --to rust --plan` previews moving a brain to the opt-in Rust engine, and writes nothing.**

### Added
- `gbrain engine swap --to rust --plan [--json]` shows whether a brain is ready to move to the Rust engine: the verdict, one row per readiness criterion with what was measured or which evidence is missing, the variables and service definitions on this machine that select the current engine (names only, never values), the free disk space and a plan hash. Speed is reported but never blocks this opt-in move. The move itself arrives in a later release.
- The plan refuses with `engine_swap_refused` (reason `refresh_unsettled`) while a `gbrain sources refresh` is unfinished, before it reads anything else, and names each refresh and the command that finishes it. The Rust engine cannot resume a refresh, so moving one across would block its sources.
- The plan previews only this machine's own brain and never creates one. A mounted brain is refused (`engine_swap_refused`, reason `team_brain`), and a configured path with no brain in it is refused with `no_brain` before anything is opened.
- READY needs the shadow follower's current lag, queue and coverage, and exactly one observed writer host. Zero observed writers is not ready (`writer_coverage_unknown`).

<!-- behavior-change: engine_swap_plan_s5a -->
