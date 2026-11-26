---
important: security
---
**A remote MCP caller now sees and steers only the background jobs it submitted, so one client can no longer read another client's agent prompts or job results.**

<!-- behavior-change: remote_job_owner_fence -->

### Fixed
- Remote job reads and controls (`get_job`, `wait_job`, `list_jobs`, `get_job_progress`, `watch_job`, `cancel_job`, `pause_job`, `send_job_message`, `retry_job`, `resume_job`, `replay_job`) are fenced to the caller's own jobs for every remote credential, admin scope included. Before, an admin-scoped remote credential saw every job on the brain, with its data and result.
- Behind a gateway that declares end users (`X-Gbrain-End-User`), each end user sees only the jobs submitted on their behalf, even though they share one credential.

### Changed
- Remote job submissions (`submit_job`, `submit_agent`) record an owner key (the credential plus the declared end user) on the job's submission authority. Agent jobs attribute their writes to that end user.
- The local CLI, a local stdio server and an admin credential bound to the brain owner keep the whole-queue view.
