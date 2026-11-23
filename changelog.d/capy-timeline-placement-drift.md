**A page whose stored timeline sits inside its body no longer reads as drifted from its file, so writes to it stop being refused and sync stops holding it.**

### Fixed
<!-- behavior-change: timeline_split_not_drift -->
- Pages imported before v0.46.25.0 kept a bare dated `## Timeline` section inside the stored body with an empty timeline. Today's parser reads the same unchanged file with that section split off as the timeline, so every write to such a page was refused `source_changed` (`file_database_drift`) and sync held its next file edit `file_drift`, though both copies held the same text. The comparison now also reads the stored body split the way today's parser splits it, so these pages take writes and sync their files again. A page that differs from its file in any line still refuses and stays held.
- A `file_drift` hold written by an earlier release on a live page is checked once more by the next `gbrain sync`, so holds that came only from where the timeline was split clear without a repair. The rest stay listed by `gbrain repair file-drift --source <id> --held`.
