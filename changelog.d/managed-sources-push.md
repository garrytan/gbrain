**Retry managed source backups without publishing uncommitted files.**

### Added
- `gbrain sources push` can publish an owner-verified managed checkout's committed HEAD without staging, committing, pulling or invoking checkout hooks. It scans all unpublished history, including binary blobs and deny-listed paths, before pushing that exact commit.

<!-- behavior-change: managed_sources_push_committed_head -->
