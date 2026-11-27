---
important: security
---
**On an OpenClaw host with no native memory provider, a turn gets the owner's rule, pins, brief and owner-only skills only after the plugin verifies the owner sender, and the turn log says so.**

### Fixed
- With `--owner-sender` or `--require-owner-sender` set and no memory audience from OpenClaw (an unset or legacy `plugins.slots.memory`, such as the bundled `memory-core`), a turn on the main session or a direct session is the owner's only when OpenClaw's trigger is `user`, the sender id is an `--owner-sender` id, the channel context names no other sender, OpenClaw did not say `senderIsOwner: false`, and the chat is not a group, supergroup or channel. Before, a matching sender id was enough, so a turn whose channel context named someone else, or that came from a group chat, got the owner's context. Every other turn there stays another person's DM.
- Those verified owner turns log `session_class: owner` and `audience: sender` instead of `main` and `unknown`, and `gbrain doctor --only skill_resolver` counts them ("N owner turns verified by sender id"), so a host without a memory audience shows its owner turns instead of logging every turn as unknown.
- A memory audience OpenClaw does send still decides on its own: a `conversation` audience is never turned into the owner's.
- The plugin code is version 8: rerun the `gbrain setup openclaw` command you installed with and restart the gateway (`skill_resolver_plugin_outdated` until then).
