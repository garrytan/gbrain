**OpenClaw agents now get skill suggestions for every skill OpenClaw loads, including skill folders outside the workspace, and the suggestions still work when OpenClaw's own skill list is switched off.**

### Added
- `gbrain setup openclaw --skill-loading resolve` builds each agent's catalog from every folder OpenClaw loads skills from. That covers the workspace and `.agents/skills`, `skills.load.extraDirs`, plugin skill folders, managed, Skill Workshop, custodian and bundled skills. It asks the running gateway (`skills.status`) where each skill lives, and falls back to `openclaw skills list` plus one `skills info` per folder it cannot place. When two folders hold a skill with the same name, the catalog keeps the copy OpenClaw loads.
- The plugin's state file records `gbrain_home` and, per agent, the skill folders with their OpenClaw source, each skill's `SKILL.md` path and which paths the agent may read. `gbrain doctor --only skill_resolver --json` reports the same `gbrain_home`.
- Each plugin log line names the session class (owner, group, relay, webhook, cron and so on) and the source of each suggested skill. Doctor splits recent counts by both, and reads `listing off, resolver live` for an agent whose OpenClaw skill list is off while gbrain suggests for it.

### Changed
- Suggestions tell the model to open the `SKILL.md` at its path first and fall back to `skills_read` by name (through `dispatch_action` when `skills_read` is deferred). An agent that cannot read the path (`tools.fs.workspaceOnly` for a skill outside its workspace, or a sandbox) is told to use `skills_read` first. Pinned skills follow the same rule.
- A `read` of a suggested skill's `SKILL.md`, directly or through `dispatch_action`, now counts as one read of that skill.

### Fixed
- A skill folder symlinked into an OpenClaw skill folder is treated as the copy OpenClaw loads, so it is still suggested.
