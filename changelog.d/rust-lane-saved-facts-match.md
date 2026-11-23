**`search` and `query` now show your saved facts on the Rust engine too.**

### Fixed
- On the Rust engine, the saved-facts block of `search` and `query` stopped with "engine capability missing". It now returns the same facts, in the same order, as PGLite and Postgres: active facts that share enough of your words (CJK words as substrings), with a newer correction ranked ahead of the fact it corrects.
