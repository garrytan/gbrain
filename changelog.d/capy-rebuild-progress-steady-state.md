---
important: regression
---
**Search is fast again on brains where old upgrade work sits parked on image pages.**

### Fixed
- Since v0.60.723.0, every search on a brain whose readiness said "projection pending" also counted the pages a post-upgrade rebuild still had to process. When that rebuild's queue rows were parked on image pages, which the rebuild never touches, the count still read every page in the brain on every search. On a brain of several hundred thousand pages that added more than a second to each warm search. Search now reads only the rebuild's queued rows to decide whether a rebuild is running, and counts pages only while one is running for text pages in the caller's scope.
- Search results are unchanged. The rebuild progress in search's readiness metadata (`_meta.retrieval.coverage.rebuild`) now appears only while text pages in your scope still wait for the rebuild; work left only on image pages no longer shows as a running rebuild, and the pending-images notice still names it.
