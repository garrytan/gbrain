**The Rust storage engine's store code on master catches up with the trunk's work since the snapshot, and nothing selects it yet.**

### Changed
- The Rust store crate and the `gbrain-napi` addon gain the work done on the Rust trunk since the first snapshot: the Rust half of page purges, identity drift and restore, private reads for a remote caller, connector sync stamps, derivation inputs, fence-row trust, the chronicle decision records, and the fix for a deadlock when a bound transaction waited for the writer. Every file under `rust/` is the trunk's version, merged with the changes master made to `rust/` since the snapshot landed.
- The store writes format 8 and opens formats 1 to 8. Older stores are converted when they open: loop mutes move to their own key prefix (format 7), and the shared-skill catalog's token secret and the access member links move to their own key prefixes (format 8). A downgrade after an upgrade needs a re-seed, because an older addon refuses a format 8 store.

### For contributors
- No brain behaves differently after this lands: the default engines are unchanged and the Rust engine stays opt-in.
