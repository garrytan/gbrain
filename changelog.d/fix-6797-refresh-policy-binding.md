**`gbrain bootstrap harness --refresh-skills` now clears `requirements_changed` after a source's skill policy changes.**

<!-- behavior-change: shared_skills_rejoin_rebinds_6797 -->

### Fixed
- An approved `join_brain` on an active shared-skills enrollment now renews the stored source policy binding, so refreshed skills deliver again without a leave and re-join. On PostgreSQL brains each enrollment gets one new delivery batch after the upgrade. Closes #6797. Contributed by @javieraldape (#9409).
