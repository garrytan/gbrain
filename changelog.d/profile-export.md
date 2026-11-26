**`gbrain profile export` writes your own profile as text another assistant keeps: a memory list for Claude, a marked GBrain block in Muse's Memory.md, or a readable page.**

### Added
- `gbrain profile export --format memory-text|muse-memory|markdown [--include-private] [--json]`. Only facts visible to everyone leave unless you pass `--include-private`, which warns and makes an `--into` file readable only by you. A fact a tool or an outside source wrote keeps a "not confirmed by you" label. Facts your credential cannot read, and facts cut at 500 characters, are named in the output and in `--json`.
- `--into <Memory.md>` replaces only the previous GBrain block and leaves your own lines alone. It refuses, changing nothing, a damaged block, a file that changed during the write, an incomplete profile read or a symlink loop; it follows symlinks to their target, and marker lines inside fenced code are left alone. `gbrain profile import` skips that block, so an exported profile is never read back as new facts.
- The Muse connector brief (docs/connectors/muse.md) and the grok.com connector path in docs/guides/grok-bot.md.

### Changed
- The owner login page leads with the owner's own `gbrain mcp admin login-link` command, with the URL quoted and a waiting connector's request kept; the prompt for someone else who runs the brain host is folded below it. The expired-link page says the same.
- On the starter tool surface, `remember` accepts `content_origin` only as `inferred` or `tool_output`; `user_said` is refused as off the surface, and the refusal quotes nothing the caller sent beyond that value.

### Fixed
- `gbrain profile import` keeps an honest receipt. A resume reads the write's own error, a write held for review counts as not saved and names its release command, an unknown outcome is checked on resume, and one line the brain refuses or holds costs only itself. A damaged receipt is refused the same way by apply, `--resume` and `--status`.
