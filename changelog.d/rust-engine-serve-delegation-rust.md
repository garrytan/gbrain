**On the experimental Rust engine, the CLI's sync, fact repair, stale-link extraction, source refresh and code reindex commands can now hand their work to a running `gbrain serve` that owns a Rust brain, as they already do on PGLite; nothing selects the Rust engine yet, and a Rust serve does not take this work until the rest of the Rust engine lands, so nothing changes for anyone today.**

### Changed
- When a `gbrain serve` owns a Rust brain and can take the work, `gbrain sync`, `gbrain embed --stale --facts`, `gbrain extract --stale`, `gbrain sources refresh` and `gbrain reindex-code` run inside that serve instead of opening the brain themselves. A Rust owner that cannot take the work leaves each command as it runs today.
- While `gbrain serve` owns a Rust brain, a command that cannot be handed to it (a full `dream` or cycle run, `import`, `embed --all`) waits for the serve or refuses, as on PGLite today. On Postgres these commands run beside the serve.
- The "owner stopped before admission" errors of sync, fact repair and source refresh no longer say "PGLite", because the owner can now be a Rust brain's serve.
