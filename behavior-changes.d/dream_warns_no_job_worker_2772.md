---
kind: fix
---
On a Postgres brain, gbrain dream now warns in its facts_drain line when no job worker is extracting facts: once a facts-absorb job has waited longer than GBRAIN_QUEUE_NO_WORKER_WARN_HOURS (default 1) on a queue where no job is running or has started in that time, the phase reports a warning that counts the waiting jobs, gives the oldest one's age and names the fix, gbrain jobs supervisor start. It used to report the phase as skipped, so a brain whose worker never started looked healthy while its facts stopped updating. The cycle still exits 0.
