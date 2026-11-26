**OpenClaw agents can carry an operator rule line on every turn, a once-per-session skill brief beside the every-turn pins, and a fail-closed owner check, and gbrain warns when anyone who DMs the agent would be treated as its owner.**

<!-- behavior-change: openclaw_owner_sender_warning_gst3997 -->

### Added
- `gbrain setup openclaw --operator-rule "<line>"` sends one line from the operator on every live owner turn, ahead of the pins, in its own `<operator_rule>` block; `--conversation-operator-rule` does the same for groups, channels and other people's DMs. A line is at most 200 characters with no line breaks and no `<` or `>`, setup refuses anything else, the plugin drops a hand-edited line that breaks the rule, and an empty value clears it. `--pins-route` never moves it.
- `gbrain skills pin add <id> --catalog openclaw-<agent> --brief` puts a pin in the owner's session-start brief (`<session_brief>`, once per session and again after a compaction, a reset or a change to the brief) while the other pins stay on every turn; `--every-turn` moves it back. Brief pins are owner-only, are never also suggested, and `--pins-route first_turn` keeps working as before.
- `gbrain setup openclaw --require-owner-sender` fails closed: without a memory audience from OpenClaw, the main session counts as the owner's only for a turn from an `--owner-sender` id, so with none set it gets conversation pins and no owner-only skill. It is off by default, so existing installs behave as before.
- `gbrain setup openclaw` prints, and `gbrain doctor` warns with `skill_resolver_owner_unverified`, when a live agent on `session.dmScope: main` (globally or on a route binding) has no owner sender and its recent turns did not all carry OpenClaw's memory audience. The fix names the exact `--owner-sender` command, which takes the bare id the channel reports or the `telegram:<id>` form `commands.ownerAllowFrom` uses.
- `gbrain doctor` warns with `skill_resolver_plugin_outdated` when the installed plugin, or the one the gateway still runs, is older than this gbrain and so ignores these settings.

### Changed
- The OpenClaw guide says plainly that the rule line, pins and brief reach the model only while the agent's mode is `live`, and no longer claims owner pins never reach someone else's DM without a memory audience.
