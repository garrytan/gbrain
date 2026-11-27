**On the experimental Rust engine, the recovery steps of a write to a claimed source no longer need raw SQL, so a refused publication can be recorded, retried and ended there.**

### Changed
- The recovery record, the publication stamp and the recovery pass of a write to a worktree-bound source moved from raw SQL into one typed engine member. PGLite and Postgres run the same SQL as before.
- On the Rust engine, a write to a claimed source still refuses at admission until that step is typed.
