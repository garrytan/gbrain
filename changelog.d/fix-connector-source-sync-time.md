**A Google sync that ends `partial` now says why, and the loops catch-up stops at a usage limit instead of failing every remaining thread.**

### Fixed
- A Google (Gmail, Calendar, Contacts) sync run that ends `partial` now records its causes in the job result as `partial_causes` (one line each: every run-level cause, such as a failed service sweep, a missing scope, an abort or a usage limit, plus up to 5 failed threads or items), and `gbrain doctor`'s sync_freshness result shows them, for example `completed (partial: gmail sweep failed: upstream error)`. Before, such a run gave no reason anywhere.
- The loops catch-up on a gbrain.io source kept reading every waiting thread after the daily usage limit was reached, failing each read. It now stops at the first usage-limit error, logs one line, and reads the rest on a later sweep.
- A usage limit hit while moving pages for the private-senders list now ends the run as a usage-limit stop (`stopped_on: usage_limit`), so doctor's usage-limit warning applies, instead of a partial failure.
- `gbrain jobs list --name <name>` ignored the filter and listed every job. It now lists only jobs of that name, locally and against a remote brain.
