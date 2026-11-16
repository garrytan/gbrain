**A large read-only mirror source whose sync passes only re-check old holds no longer parks as `pass_abandoned` with nothing settled, and its status and repair output now say what is actually held.**

### Fixed
- A sync pass that stopped while it re-checked old holds now counts as progress when it cleared a hold's re-check trigger, so a few such passes no longer build the abandoned streak. Passes that re-check the same holds every time (slug conflicts) still end `pass_abandoned`, and so do passes that only re-hold a page edited again before each of them: once that hold has been held three times, `gbrain sync status` reports `needs_human: true` with that page's own decision.
- A pass now reads the earlier Git versions of the held pages it re-checks one batch at a time, just before that batch commits, instead of for the whole round before its first commit. On a source with many such holds the first commit came only after the whole history read.
- `gbrain sync status` leads with the pass's own next step when the holds are not what stops the source, and `next.why` for `pass_interrupted` and `pass_abandoned` names the step the stopped pass was last seen in (the level read, or the history read with how far it got).
- On a read-only mirror, `gbrain repair file-drift --held` compares each held page with its file. A differing page reads `prefer_file` or `needs_human` with its evidence, a matching one `release_hold`, and only a page whose file is gone reads `no_drift` with `database_only`. The comparison still writes nothing.
- A windowed held dry run reports `complete: false` while held pages remain past its window, and `details.window.next_command` names the next window.
- `gbrain sources status --json` counts `git_holds.by_code` over every hold of the source, not only the listed ones.

Larger sources still need a per-class decision flow for their held pages; this change only makes the counts and the comparison true.

<!-- behavior-change: mirror_compare_reads_file_gst2843 -->
<!-- behavior-change: held_compare_complete_window_gst2843 -->
<!-- behavior-change: hold_by_code_counts_all_gst2843 -->
