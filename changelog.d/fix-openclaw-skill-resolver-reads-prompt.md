**OpenClaw's skill resolver now suggests skills for the message the user just sent.**

### Fixed
- The `gbrain-skill-resolver` plugin read the user's text from fields a real OpenClaw gateway does not send. OpenClaw 2026.10.33 and 2026.11.5 pass it as `event.prompt` and keep only earlier turns in `event.messages`. So the first turn of every session got no suggestions (`skipped_empty`), and each later turn was ranked on the message before it, in live and in shadow mode. The plugin now reads `event.prompt` first.
- The plugin now finds OpenClaw's `assertActive` check under `ctx.hookInvocation`, so a run that OpenClaw already ended no longer counts toward the session.
- `gbrain setup openclaw` now parses `openclaw skills list --json` from stdout only. A warning OpenClaw printed on stderr used to make the list read as failed. Setup then skipped the hidden-skill filter and the `skill_resolver_host_load_cut` note.
- An upgrade does not rewrite the plugin on its own. To install the fixed plugin, run `gbrain setup openclaw --skill-loading resolve` (or `shadow`) again, then restart the gateway.
