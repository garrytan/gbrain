**A remote save of a forgotten claim now gets one plain refusal that carries no detail about the forgotten rows.**

<!-- behavior-change: remote_withdrawn_refusal_plain -->

### Changed
- Privacy: when a remote caller saves a claim that was explicitly forgotten, it gets the plain "this claim was forgotten" refusal with no `withdrawn` detail, whatever it can see of the forgotten rows. Its write receipts and replays leave the detail out too. Callers on the brain's own machine keep the detail. Applies on PGLite and Postgres. A Rust brain gets the same refusal once its forgotten-claim check (`isFactWithdrawn`) is served on Rust; until then it refuses such a save earlier, as not supported.
