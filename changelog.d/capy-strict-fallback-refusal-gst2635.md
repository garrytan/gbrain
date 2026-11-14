---
important: data-loss
---

**On a source whose pages are canonical in Git, a fact the Google loops extraction finds for an entity with no page that an exact page rule names is now refused before anything is stored, the way `remember` already refused it.**

### Fixed

- On a `canonical: git` source, a commitment fact for an entity with no page under an exact page rule (`gbrain access rule add --slug people/bob-example --readers alice-example`) used to be stored in the database only, with no file or commit holding it, so a rebuild from Git lost it. Once `memory/unattributed` existed, the same write was refused instead, with a message that named `memory/unattributed` rather than the entity. The write is now refused `git_home_required` (reason `facts_lane`) before any row is written, and the message and fix name the entity's page to create. An access state the database role cannot read refuses `access_policy_pending` (retry), and that message now names the entity too.
- The loops job still records the loop. Its log line reads `[loops_extract] fact projection failed … (git_home_required)` (or `(access_policy_pending)`) and names the entity's page, so an operator can see which page to create.
- Sources that are not strict, brains with no Git repository, and fact writers that do not keep a fallback entity behave as before.
- Facts an earlier version already stored this way are untouched: `gbrain repair facts-home --source <id>` lists them as `folder_restricted` (`page_rule`) and its apply leaves them; creating the entity's page lets the `extract_facts` upkeep step fence them.

<!-- behavior-change: strict_fallback_refusal_gst2635 -->
