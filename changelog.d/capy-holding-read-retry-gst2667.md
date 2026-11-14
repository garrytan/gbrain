---
important: data-loss
---

**On a source whose pages are canonical in Git, a fact the Google loops extraction saves for a person or company with no page is no longer thrown away when the database has a brief hiccup while gbrain prepares the write.**

### Fixed

- On a `canonical: git` source, a fact for an entity with no page is kept on a holding page (`memory/unattributed`, or its folder's holding page under a folder access rule) until the entity's page exists. Choosing that page takes one read of the access rules. If that read hit a passing database error while the write was being prepared (a cancelled statement, a stale cached plan, a lock or serialization conflict, a dropped connection, a pooler's client limit), gbrain treated it as "the access rules cannot be read" and refused the write for good with `access_policy_pending`. For the Google loops extraction, the only writer on that path, the commitment fact was dropped while the loop row stayed, so the open loop pointed at no fact.
- Now that error is handed back to the write queue, which releases the write and prepares it again, the same way it already retries every other passing database error. The fact lands on the holding page with its entity, committed to Git, and the loop row points at it. A statement that keeps getting cancelled still stops after `persistence.max_transient_retries` tries and ends `write_interrupted` with nothing written.
- Real refusals are unchanged. An exact page rule on the entity still refuses `git_home_required`, and an access state the database role really cannot read (for example permission denied on the access tables) still refuses `access_policy_pending`.
- A hiccup on the same read earlier, while the loops job first hands the fact to gbrain, still loses that one fact as it did before. The loops job keeps the loop row and logs `fact projection failed`.
- Facts dropped this way before the fix are not recovered by this change.
