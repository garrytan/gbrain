**Shadow mode can now compare sync-import page writes on a default brain.**

### Changed
- The Rust store's `put_page` now takes the contextual-retrieval option and stores the same stamp as the primary. Sync imports and `put_page` send that option in the default mode, so their page writes were counted uncomparable (`unknown_option`) on a default brain. They are now replayed and compared like any other page write.
- Page writes in the default mode can now count toward the swap's write check. It still covers page and link writes only.
