**OpenClaw's skill suggestions now know who is talking: the owner, a group or channel, or an automated run, and the owner gets a one-time skill brief at the start of each session.**

### Added
- Session classes for the OpenClaw skill resolver. Each turn is the owner's (the main session, an owner-private memory audience, or a direct message from an `--owner-sender`), a conversation (a group, a channel, or a direct message from someone else), or silent (relay, cron, heartbeat, webhook and subagent runs). When OpenClaw reports no memory audience, the class comes from the session key and the turn log says `audience: unknown`; with `--owner-sender` set, a message on the shared main session from anyone else, or with no sender id, counts as another person's DM.
- `audience: owner` in a skill's frontmatter keeps that skill out of every suggestion and pin outside the owner's sessions. Any other non-empty `audience` value (a typo, a list, `true`, a number) is treated the same way, and so is front matter that does not parse but has an `audience:` line, so a mistake never makes a skill public.
- `gbrain skills pin add <id> --class owner,conversation` chooses where an OpenClaw pin appears (adding it again with only `--line` keeps its classes); `gbrain setup openclaw --suggest-in owner|conversation|owner,conversation` chooses where suggestions appear.
- With `--pins-route first_turn`, the owner's pinned skills are a session-start brief: the first turn of each owner session gets it once, and a gateway restart or a retried run does not repeat it. A new session after `/new` or a compaction gets a fresh one.
- `gbrain doctor` shows each agent's conversation pins, where suggestions appear, and turns by memory audience.

### Changed
- OpenClaw pins apply to the owner's sessions unless you add `--class conversation`; relay and webhook turns get no suggestions and no pins.
- A worker that rebuilt a stale index refreshes the OpenClaw pin and exclude lists in the background (at most every 5 minutes; a rebuild during that wait gets one refresh when it ends).
- The OpenClaw skill probes time out after 20 seconds instead of 120.

### Fixed
- Pins no longer render a skill that is hidden or shadowed by a higher-precedence copy.
- The exclude list is no longer cut at 1,024 entries; each turn passes only its own pins, and hidden skills travel separately.
- A non-main agent with `workspaceOnly` reads and no workspace entry now uses OpenClaw's default workspace for that agent instead of being treated as readable anywhere.
- When OpenClaw does not answer during a refresh, the skill roots it reported and the skills it hid last time are kept instead of dropped, so a hidden skill is not suggested or pinned again.
- A first turn that carries the session-start brief and runs past its deadline is resolved when OpenClaw retries it, and the retry carries the brief once.
- The session-brief ledger is compacted across gateway restarts instead of growing until one process writes 5,000 lines.

<!-- behavior-change: openclaw_pins_owner_only_gst3896 -->
