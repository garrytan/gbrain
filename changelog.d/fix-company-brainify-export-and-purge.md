---
important: data-loss
---

**The company-brainify skill now ships only the files it actually read when it builds a team brain, and its history purge can no longer overwrite a teammate's push or leave old history on other branches and tags.**

### Fixed
- The team-brain export copies only the files on its export list, each of which gets the per-file privacy read, instead of whole folders. The export commit stops when a staged file is not on the list or the list is missing.
- Phase 4's checks now also look for personal email addresses outside the work domain, home addresses, phone numbers in every scanned folder, and family, medical and legal words.
- The history purge, now in its own file (`skills/company-brainify/HISTORY-PURGE.md`), records every remote branch and tag, pushes them all in one atomic push with a lease on each recorded commit, and checks afterwards that no branch or tag still reaches the old history. A push made while the confirmation card waits makes the whole purge refuse instead of being overwritten.
- The purge stops before its first commit when the shared repo still holds files nobody read, deletes only the branches and tags the user marked for deletion, and stops before pushing when any other recorded branch or tag is missing locally.
