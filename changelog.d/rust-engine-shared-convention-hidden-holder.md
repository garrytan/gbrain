---
important: security
---
**A shared skill convention file held only by a hidden skill stays hidden when another skill publishes it.**

<!-- behavior-change: shared_convention_hidden_holder -->

### Fixed
- A file under `skills/conventions/` can be held by a skill whose SKILL.md audience is narrower than the file's own, or by a private skill. Publishing a public skill that newly included that file, or rewriting a shared file so a public skill gained it, used to show it to every reader. Submission and prepare now refuse it with `local_conflict` and write nothing, and a request accepted by an older release is checked again at prepare. A file that another skill already shows to readers, or a copy no wider than the hidden skill gives it, still publishes.
