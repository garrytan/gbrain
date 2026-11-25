**Skill vectors no longer store an all-zero vector, write a file the resolver can't read back, or write into a catalog that was removed during the build.**

### Fixed
- An all-zero vector from the embedding provider now counts as a bad reply. A build used to store it and a turn used to rank with it; now the build keeps no vectors and the turn answers with words (`bad_reply`).
- The 64 MB vectors-file cap now counts the file's header. A catalog just under the old count could publish vectors that every turn refused to read. The cap is now checked before any request when `embedding_dimensions` is set, and after the first reply otherwise, so an oversized catalog no longer pays to embed every skill.
- A catalog removed while a build was embedding its skills is no longer written back, and neither is a new catalog made under the same name in the meantime. The build fails with `skill_index_removed`.
- A build that timed out with requests still running no longer publishes vectors with gaps.
- Plain `gbrain skills resolve --explain-target <id>` now prints the skill's cosine and floor, as `--json` already did.
