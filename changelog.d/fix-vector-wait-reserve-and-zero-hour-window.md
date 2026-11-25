**The skill resolver answers with its word matches instead of a timeout when the embedding call is slow and the machine is busy.**

### Fixed
- When a caller's deadline cuts the wait for the message's embedding short, the resolver now stops waiting 100 ms before the deadline instead of 20 ms. Before, a timer that fired a few tens of milliseconds late on a busy machine pushed the turn past its deadline, and the turn returned `skill_resolve_timeout` with no block instead of the word matcher's suggestions.
- The decide store's engine comparison tests let the clock move before they read a zero-hour window, so they no longer fail when a receipt and the read land in the same millisecond.
