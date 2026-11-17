**`gbrain repair open-facts` now keeps a fact private once its end date has passed, and opens facts tables that sit below the timeline.**

<!-- behavior-change: open_facts_lapsed_timeline_8194 -->

### Fixed
- A private fact whose `valid_until` date has passed stays private, and the preview counts it under a new reason, `lapsed`. Before, the repair could open a fact that was no longer true.
- A fact in a `## Facts` table below the timeline sentinel now opens in place. Before, the apply looked only above the timeline and reported every such fact `fact_left_private`.
- The preview warns that a fact saved private on purpose before the cut looks the same as a legacy one, and that `--ids-file` limits the run to the ids you list.
