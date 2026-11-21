**A GitHub connector's first import now also stops at the job's deadline, and a connector sync refused on its own retained publication records that refusal.**

### Fixed
- The first, database-only pass of a GitHub connector import ignored the job's deadline, so a large first import could still run until the job was killed at its timeout and record nothing. It now stops importing at the deadline without counting a failed item, keeps every listed page, and the next sync picks up the items it did not reach. (#9968)
- A connector sync refused with `recovery_required` because its own retained publication was still recovering did not record the refusal, so `sources status` never counted it toward a stop. The refusal is now recorded as the source's last failure, with the blocking request. (#9968)
