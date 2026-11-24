**The minion worker and its helpers stop hiding a Rust brain's capability refusals: the terminal hook runs, oneshot synthesis validates links, and a refused release or stall check is reported.**

### Fixed
- The terminal hook re-read each settled job with raw SQL and only logged the failure, so on a Rust brain the hook never ran. It now reads the job with `getJob`.
- Oneshot synthesis checked wikilink targets and the page count with raw SQL and, on failure, validated as if no page existed, rejecting valid pages. It now uses `listLinkPageMetadataForSlugs` and `countSourcePages`, and a capability refusal is no longer turned into strict validation.
- The worker's pause-marker release and quiet-hours defer logged one line and left the claim to expire. A capability refusal now stops the worker loudly. The worker's stall check does the same, ending the worker as unhealthy.
- A spend refusal on an engine that cannot store its result row still ends the job with the refusal, and now says on the console that `result.spend_refusal` was not stored.
