---
important: security
---
**A remote MCP credential, admin scope included, now reads and steers only the background jobs it submitted, so one client can no longer read another client's agent prompts, job data or results.**

<!-- behavior-change: remote_job_owner_fence -->

### Fixed
- Remote job reads and controls (`get_job`, `wait_job`, `list_jobs` and its `finished_since` page, `get_job_progress`, `watch_job`, `cancel_job`, `pause_job`, `resume_job`, `retry_job`, `replay_job`, `send_job_message`) are fenced to the caller's own jobs for every remote credential. Before, an admin-scoped remote credential saw and could steer every job on the brain, including jobs the local operator queued. A foreign job and a missing id now get the same `not_found` answer.
- Behind one shared credential, each person or audience a call declares (`x-qm-actor`, `X-Gbrain-On-Behalf-Of`) sees only the jobs queued for it; `submit_job` now records it on the job, as `submit_agent` already did.
- For a fenced caller, job insight (`submitted_by`, `blocked_by`, `spend`) and `parent_job_id` never name another caller's parent, child, queue-slot holder or lock holder, and default job responses leave other callers' child jobs out of spend and token totals. Queue positions and pending-child totals still count every job.
- A job's owner is its verified credential, recorded at submission, never a value in the job's data; agent jobs from before submission authority existed still match their client.

### Changed
- The local CLI, a local stdio server without per-token auth, and a remote admin credential bound to the brain owner (`access.owner_member`) keep the whole-queue view. A brain with no owner set fences every remote credential; bind one to the owner to restore its view (`gbrain access owner set <id>`, `gbrain auth rescope --client <client_id> --member <id>`).

Reported and first fixed by @comtihon (#10469).
