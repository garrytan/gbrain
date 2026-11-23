---
kind: add
---
A new table, engine_writer_observations, is added to every brain by a schema migration. It stays empty unless you turn on Rust engine shadow mode (gbrain engine shadow start). While shadow mode is on, each gbrain process that writes to the brain notes one row in it (its host id, the name its database connections carry, its command kind, its gbrain version, and when it first and last wrote), at most every 10 minutes and after its write committed, so a later swap check can tell how many machines write the brain. It holds no page content, paths or query text. Turning shadow mode off stops new rows.
