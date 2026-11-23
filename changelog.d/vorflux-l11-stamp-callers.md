**More syncs record their last sync time through one typed engine call, which a Rust brain also serves.**

### Changed
- A managed plain-folder sync and an Apple Contacts sync now record the source's last sync time through the typed `markSourceSynced` engine call instead of raw SQL. On Apple Contacts, a stamp that fails is now logged instead of hidden.
- `markSourceSynced` can be limited to one source incarnation, so a managed sync run can stamp only the source it started on. The sync runs switch to it in a later change.
