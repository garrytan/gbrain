**An MCP client on the starter tool list can now say when a remembered fact was true by passing `valid_from` to `remember`.**

### Fixed
- Since starter clients were limited to the parameters their tool list shows, a single `remember` call with `valid_from` was refused with `param_not_on_surface`, although the same date was already accepted inside `items`. Ingest clients that know when each message was said can now date a single fact too. `valid_from` still doesn't appear in the starter tool list, so the list's size is unchanged.
