---
important: regression
---
**Search is fast again on brains where old upgrade work sits parked on image pages.**

### Fixed
- Since v0.60.723.0, every search on a brain whose readiness said "projection pending" also counted the pages a post-upgrade rebuild still had to process. When that rebuild's queue rows were parked on image pages, which the rebuild never touches, the count still read every page in the brain on every search. On a brain of several hundred thousand pages that added more than a second to each warm search. The count now reads only the rebuild queue first, and touches pages only when a rebuild is really running for text pages, so a parked queue costs a few milliseconds. Search results and the readiness report are unchanged.
