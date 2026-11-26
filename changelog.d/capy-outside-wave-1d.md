**Nine bugs reported from outside the project are fixed: starter-tier recall takes `max_chars`, the global maintenance cycle synthesizes every source's captured sessions, and init, Hermes skill suggestions, doctor and keyword search paging work as documented.**

### Fixed
- A remote client on the starter MCP surface (the Claude Code and opencode default) can pass `max_chars` to `recall` and gets a reply cut to whole facts within it, instead of `param_not_on_surface` (#9514).
- The global maintenance cycle runs the synthesize phase for one source that owns captured sessions at a time, in turn, so sessions captured in another source's checkout are synthesized under that source instead of being reported `corpus_source_other` forever. Archived sources and the storage shelf never take a turn (#8669).
- `gbrain init` works when the brain home sits under a symlinked folder, such as `/var` on macOS (#9925). A new content directory inside another Git repository is refused before setup records it, so a rerun with `--content-root` works, and `--git` whose `git init` fails is refused the same way instead of claiming the parent repository (#10287).
- `gbrain timeline-add --source-id` explains that `--source` is the entry's provenance and names `GBRAIN_SOURCE=<id>` as the way to choose the source it writes to (on a remote brain, the connection's grant), instead of suggesting `--source` (#8343).
- `gbrain doctor`'s index audit no longer lists primary-key and unique-constraint indexes as unused (#9966).
- Long Hermes sessions get their skill suggestions again, because the hook's deadline starts once its input has arrived. `gbrain doctor` warns when a harness times out on 20% or more of at least 20 recent prompts (#10334).
- A page whose re-extraction is held at its current content leaves the `extract_atoms` backlog and discovery, so `gbrain dream --drain` finishes instead of stopping `no_progress` every night. The hold stays visible in doctor (#10270).
- Keyword-only search applies `offset` as rows to skip, so pages past three times the limit are no longer empty, up to the existing three-times-the-search-cap pool (#9922).
