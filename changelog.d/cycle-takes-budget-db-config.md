**`gbrain config set cycle.propose_takes.budget_usd` (and the `grade_takes` / `calibration_profile` caps) now sets the per-run spending cap those dream phases enforce.**

<!-- behavior-change: takes_trio_budget_config_set -->

### Fixed
- The calibration phases `propose_takes`, `grade_takes` and `calibration_profile` read their per-run USD cap only from the file config the cycle hands them, so a cap written with `gbrain config set` was never seen and the defaults ($5, $3 and $0.50) always applied. The cap now resolves in this order: an explicit caller value, the file config, the value `gbrain config set` stored, then the default. A stored `0` stops the phase's model calls, and `unlimited` removes the cap, the same as the other dream phase caps.
