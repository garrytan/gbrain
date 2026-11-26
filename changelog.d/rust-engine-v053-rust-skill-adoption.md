**On the experimental Rust engine, a brain swapped from PGLite can now turn shared skills on with the reviewed `gbrain sources writer activate --shared-skills --expected-state` step, and the v0.53.0 upgrade then adopts the content root's skill pack, as on a SQL brain; nothing selects the Rust engine yet, so PGLite and Postgres brains are unchanged.**

### Fixed
- `gbrain sources writer activate --shared-skills` with a reviewed `--expected-state` works on a Rust brain. It checks the reviewed state again and turns shared skills on in one transaction. A stale state refuses `writer_admin_state_changed` and changes nothing. A run while another gbrain process (such as `gbrain serve`) holds the brain refuses `owner_unavailable` and changes nothing.
- On a Rust brain, the v0.53.0 migration reads whether shared skills are on from the Rust store, checks the source's registered root as its owner, and adopts the pack. Before, it always stopped at `writer_not_quiesced`, and adoption refused `engine_capability_missing`.
- Pack adoption reads the source and the sealed pack row through typed engine reads, with the same answers on PGLite, Postgres and Rust.
