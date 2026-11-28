---
important: data-loss
---
**Re-auditing a shared team brain no longer overwrites a teammate's page that changed after the sanitized copy was made.**

### Fixed
- company-brainify's history purge copied the sanitized staging folder over a fresh clone of the shared repo, so a page a teammate changed, added or deleted after staging was silently reverted to the staged version and pushed. The re-audit staging step now records the commit the sanitized pages sit on (`$STAGING.base`), and the purge lists every page in the six sanitized folders that changed on the shared repo since that commit and stops before copying anything. It also stops when the base is missing or was never pushed, and after the sanitize push when a teammate's push to those folders was merged in. The skill says how to reconcile: bring the teammate's commits into the sanitized checkout, read the listed pages, re-stage and restart.
- meeting-ingestion no longer keeps an attendee name that neither the transcript nor calendar or invite metadata supports just because `gbrain whois` matches it exactly. A recorder's invented name can match a real person in the brain; `whois` now only resolves attendees the evidence already supports.

### Changed
- postgres-adopt describes both `pglite_scale` warnings: 1000+ pages, and the chunk vector index nearing what PGLite can build.
- The rooms guide's `room_above_level` row matches the agent protocol's wording.
- Convention examples use `example.com` addresses.
