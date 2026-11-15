**Five small fixes: doctor sees a project-level Codex registration, a stray `.git` no longer claims a checkout, the host's CLI can read a write receipt another principal owns, keyless search keeps working when its fill step fails, and the conversation archive's folder-cap notice stays accurate.**

### Fixed
- `gbrain doctor` (harness_wiring) now also reads the workspace's `.codex/config.toml`, so a gbrain MCP server registered there for one project counts as registered instead of being reported as unwired (#9398). Reported by @Masashi-Ono0611.
- An enclosing `.git` that is not a repository (for example an empty `~/.git` folder another tool left behind) no longer counts as the checkout that owns a brain folder under it, so gbrain stops writing its marker there and stops refusing writes under that folder with `writer_coordinator_required` (#9430). Reported by @garrietv and first fixed by @Masashi-Ono0611.
- `gbrain write-request <id>` on the brain host now shows the receipt of a write that ran under another principal, such as a fact extraction submitted by an MCP client, which `gbrain sources writer failures` names as each row's next step. Remote callers and request ids two principals share still answer not found (#9426). Reported by @cupit01.
- Keyless search no longer counts a fill row the model never answered as judged, leaves such rows out of the fill, and returns the plain keyword results when the any-word fill step fails instead of failing the whole search.
- The conversation archive's `archive_rescope_folder_cap` notice shows only while the `conversations/` rule still keeps the folder to the owner, and on a source already at the 256-rule limit it says that `gbrain access rule export` then `import` fails until another rule is removed.

### Changed
- The refresh-barrier TLA+ nightly now runs in its own job and checks the adoption-plus-foreign-commit case one write at a time; the two-write run is kept as `RefreshBarrierAdoptFull.cfg` and runs by hand.
