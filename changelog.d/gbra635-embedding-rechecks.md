---
important: security
---
**Turning on `embedding_disabled` now also stops reindex work that was already queued or running, and an unreadable setting keeps work pending instead of marking it done.**

<!-- behavior-change: embedding_disabled_rechecks_9715 -->

### Fixed
- A contextual reindex job queued before `embedding_disabled` was set now sends nothing when the worker runs it. A job already running checks the setting again before each embedding send and each per-chunk synopsis call, and a `gbrain reindex-multimodal` run already in progress stops before its next batch with the enable-command message. When the database setting can't be read, the contextual reindex job, the `doctor --remediate` embed step and `gbrain serve`'s background embed send nothing, and keep the work pending to try again later instead of counting it as done. Reported by @DaCal90 (#9715).
