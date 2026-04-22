# Phase 4 Personal Episode Lookup Implementation Plan

1. Add failing route, operation, selector, trace, and benchmark tests for `personal_episode_lookup`.
2. Add a deterministic `personal-episode-lookup-route` service on top of `listPersonalEpisodeEntries`.
3. Add a shared operation for direct exact-title lookup with optional `source_kind` filtering.
4. Extend the scope gate and retrieval selector with the `personal_episode_lookup` intent.
5. Extend retrieval traces so personal episode route selections record scope-gate evidence and `personal-episode:*` refs.
6. Publish a `phase4-personal-episode-lookup` benchmark and include it in the Phase 4 acceptance pack.
7. Document verification commands in `docs/MBRAIN_VERIFY.md`.
8. Run targeted tests and benchmark, then `test:phase4` because the acceptance pack changes.
