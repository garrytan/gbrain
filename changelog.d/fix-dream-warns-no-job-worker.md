**`gbrain dream` on a Postgres brain now warns, and names `gbrain jobs supervisor start`, when no job worker is extracting facts, instead of showing a quiet skip every night.**

### Fixed
- With no job worker running, a Postgres brain's `facts-absorb` jobs waited indefinitely while `gbrain dream` printed `facts_drain` as skipped, so nothing said that facts had stopped being extracted. The `facts_drain` phase now reports a warning (reason `no_worker`) once a `facts-absorb` job has waited longer than `GBRAIN_QUEUE_NO_WORKER_WARN_HOURS` (default 1) on a queue where no job is running or has started in that time. The warning gives the number of waiting jobs, the oldest one's age and the command that starts a worker. It reads the queue, so a worker on another machine counts. The cycle still exits 0, as with any other warning. Reported by Devin McNulty (overtonxyz/gbrain#2772), first fixed by @JamisonMercurio.

<!-- behavior-change: dream_warns_no_job_worker_2772 -->
