---
important: security
---
**A shared skill convention file can no longer reach a wider audience through another skill's publication.**

<!-- behavior-change: shared_convention_keeps_audience -->

### Fixed
- A file under `skills/conventions/` is shared by every skill that holds it. Importing a skill proposal, or a remote `put_skill`, that newly referenced such a file with a wider audience used to republish the other skills' copy to that audience. Submission and prepare now refuse it with `local_conflict` and write nothing. A request accepted by an older release is checked again at prepare. Content changes and narrower audiences still apply.
