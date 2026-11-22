**The github, google, meetings, slack and imessage connectors record their last sync time and newest content time through one typed engine call, which a Rust brain also serves.**

### Changed
- A connector's clean run now records the source's last sync time and the time of its newest content through `markSourceSynced` instead of raw SQL. A run that saw nothing newer keeps the newest content time it had, as before.
- `markSourceSynced` takes a newest content time, so the managed connector sync can switch to it in a later change.
