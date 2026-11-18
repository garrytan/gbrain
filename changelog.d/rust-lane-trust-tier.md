**The Rust engine keeps who wrote each fact, so a lower-trust page edit can no longer quietly replace a fact an operator curated.**

### Changed
- The Rust engine now stores each fact's trust tier and write origin, the same as Postgres. When an agent rewrites a page, a fact that a more trusted writer stated stays in place and goes to the owner's review queue instead of being replaced.
- The Rust engine now keeps the trust review queue (`gbrain trust review`): one open proposal per decision, the same accept, reject and undo steps, and the same "held" answer when a widening proposal still waits on a private fact. On the Rust engine a proposal does not yet record which principal or write request filed it.
