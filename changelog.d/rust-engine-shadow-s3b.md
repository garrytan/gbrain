**Shadow mode now copies entity groups, link state, link transitions, purge tombstones and access tokens into the Rust engine's store.**

### Added
- `gbrain engine shadow seed` copies five more tables whose Rust families are on master: `entity_identities`, `link_relationships`, `link_transitions`, `fact_purges` and `access_tokens`. Follow and reconcile keep them in step, so the swap check counts fewer gap rows. A brain seeded before this change has no rows for them in its Rust store: reseed it (`gbrain engine shadow stop --delete`, `seed`, `start --plan`, `start --yes --expect <plan_hash>`).
- Shadow follow now refreshes link state when a link is added or removed, so the write map names those relations.
- `page_write_guards` is listed as not copied, with the new kind `lock_anchor`: its rows only hold a lock and no read differs.

### Fixed
- A purge tombstone is imported before the claims it guards, so a reconcile removes a tombstone the primary cleared before it imports the claim.
- The fingerprint probe now fails while a purge tombstone exists and the primary's `lower()` or whitespace rules differ from the Rust store's, because a purged claim could otherwise be saved again after a swap.
- A page's membership of a second source stops the seed instead of being skipped silently, and a token column with a NULL element is refused rather than narrowed, so neither can turn into a wider grant.
- A link transition is stored where the evidence read looks for it, an access token that moves its hash to another id no longer blocks a reconcile, and a relationship range with an explicit infinite bound no longer aborts the seed.
- A reconcile pass for facts or purge tombstones runs the fingerprint probe again, so a tombstone added after a passing probe cannot ride on a cached pass.
