**`submit_job` now tells a Rust brain's user that no worker is running, and a remediation run names the manual-only jobs an earlier run queued.**

### Fixed
- The no-worker notice counted waiting jobs with raw SQL and dropped the notice when that failed. It now counts them with `countJobsByStatus`.
- A remediation run found the manual-only jobs an earlier run had queued with raw SQL behind `.catch(() => [])`, so it reported none. It now lists them with `listJobs`, and a capability refusal is no longer reported as "none queued".
