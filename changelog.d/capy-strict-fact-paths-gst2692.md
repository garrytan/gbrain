---
important: data-loss
---
**On a source whose files live in Git, two paths no longer save a fact only in the database or drop it: a held fact the owner releases while managed persistence is off, and a commitment fact the Google loops job meets a passing database error on.**

### Fixed
- The Google open-loops job (`loops_extract`) now retries when saving a commitment's fact hits a passing database problem: a cancelled statement, a lock or serialization conflict, a dropped connection, or the write door giving up after its own retries (`write_interrupted`). Before, the job saved the open loop with no fact attached and moved on, so the fact for that commitment (for example "send alice-example the invoice summary by Friday") was lost. Now the job stops, the queue runs it again, and the retry saves both the fact and the loop that points at it. A write the door reports as still pending keeps the old behaviour, because it may still commit and a retry could save it twice.
- On a source marked git-canonical (`canonical: git`, for example source-a), `gbrain trust release` of a held fact while managed persistence is turned off now refuses with `git_home_required` (reason `persistence_disabled`) and leaves the fact held, instead of writing it to the database with no file in Git. The refusal's fix previews turning managed persistence back on (`gbrain sources writer activate --confirm-quiesced --dry-run --json`); run the release again once it is on. Sources that are not git-canonical release exactly as before, and with `sync.write_through` off every write on a source stays database-only, the release included, on purpose.

Facts that were dropped, or released database-only, before this fix are not recovered by upgrading. A dropped commitment fact comes back only if its email thread is extracted again; a fact already released database-only stays that way.
