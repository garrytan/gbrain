---
important: data-loss
---
**Two skills can no longer publish shared files whose paths differ only by letter case.**

<!-- behavior-change: shared_skill_case_collision -->

### Fixed
- Every skill can publish files under `skills/conventions/`. When one skill held `skills/conventions/Guide.md`, another skill could publish `skills/conventions/guide.md`, or a file inside `skills/conventions/GUIDE.md/`, on a case-sensitive brain host. A clone on macOS or Windows then kept only one of the two files. Submission and prepare now refuse a publication that adds such a pair with `local_conflict` and write nothing, and a request accepted by an older release is checked again at prepare. A remote caller's refusal names only the path it proposed. Sharing the exact same path still publishes, and a pack that already holds such a pair keeps publishing its other changes.
