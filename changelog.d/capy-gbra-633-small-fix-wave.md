**Three nightly test flakes are fixed, and five small bugs, three of them from outside reports.**

### Fixed
- `gbrain reindex --synopsis` now sweeps pages that choose the synopsis tier in their own frontmatter (`contextual_retrieval: per_chunk_synopsis`) on a source that trusts frontmatter. It used to say "Nothing to do". Reported and first fixed by @Masashi-Ono0611 (#9683).
- An Ollama server that answers "connection refused" while its model runner restarts is now a retryable error instead of a permanent one. Reported by @benswinney, first fixed by @Masashi-Ono0611 (#9696).
- On a managed brain, `add_link` no longer records a Chronicle decision for a page with no automatic extraction pending. Reported by @frxiaobei, first fixed by @Masashi-Ono0611 (#9636).
- `gbrain auth rescope` shows the hint about reading shared sources only when shared reads were off before and after and the key still reads a source.
- A held fact move's planning reads stop at the move's deadline, including while they wait for a database connection.
- `bun run regen:all` now rewrites the doctor hot-checks golden.
- Three tests that failed on busy CI runners (the stdio boot deadline, the notifier owner lease and the held-move timing bound) no longer depend on wall-clock speed.
