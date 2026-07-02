# 239-codex-new all IDE plugin / skill / hook install matrix - 2026-06-23

Owner/prefix: `239-codex-new-`

User durable scope: "all IDE" means exactly 8 default surfaces unless the user narrows or expands it:
Kimi Code, GLM ZCode, MiniMax Code, WorkBuddy, OpenCode, Claude, Codex, Hermes Agent.

## Matrix

- Codex: plugins via `codex plugin marketplace` / `codex plugin add`; skills are `SKILL.md` directories or plugin-packaged skills; hooks live in `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`, or plugin `hooks/hooks.json`; non-managed hooks require `/hooks` trust. Use `command_windows` on Windows.
- Claude Code: plugins via `/plugin marketplace add` and `/plugin install`; skills in `~/.claude/skills`, `<repo>/.claude/skills`, or plugin `skills/`; hooks in settings or plugin `hooks/`, with events including `UserPromptSubmit`, `PreToolUse`, and `Stop`.
- Kimi Code: plugins via `kimi plugin install TARGET`; manifests `kimi.plugin.json` or `.kimi-plugin/plugin.json`; skills in `$KIMI_CODE_HOME/skills`, `~/.kimi-code/skills`, `.kimi-code/skills`, `.agents/skills`, `--skills-dir`, or `extra_skill_dirs`; hooks via `[[hooks]]` fields `event`, `matcher`, `command`, `timeout`. Blockable events: `PreToolUse`, `Stop`, `UserPromptSubmit`; failure is fail-open except exit code 2 / JSON deny.
- OpenCode: plugins from `.opencode/plugins`, `~/.config/opencode/plugins`, npm packages in `opencode.json`, or `opencode plugin <module>`; skills in `.opencode/skills`, `~/.config/opencode/skills`, plus `.claude/skills` and `.agents/skills`; hooks are JS/TS plugin event handlers such as `tool.execute.before`, `tool.execute.after`, `session.*`, `message.*`, and `permission.*`.
- MiniMax Code: no stable public native plugin/hook schema confirmed. Official MiniMax says MiniMax Code is built on an OpenCode/Pi-based harness; use OpenCode plugin/skill adapter when the runtime reads it. Do not mutate internal MiniMax app data or DB files without real-profile proof.
- GLM ZCode: no stable public ZCode-native plugin/skill/hook schema confirmed in this pass. Z.AI official docs cover Coding Tool Helper, Claude Code/OpenCode GLM plan integration, and `zai-org/zai-coding-plugins` for Claude Code. Use Claude/OpenCode hooks when Z.AI is loaded through those hosts; keep ZCode adapter skill-only until schema is proven.
- WorkBuddy / CodeBuddy: plugins via `codebuddy plugin install <plugin> --scope user|project|local`; manifests `.codebuddy-plugin/plugin.json`, `.workbuddy-plugin/plugin.json`, or `.claude-plugin/plugin.json`; skills in plugin `skills/<name>/SKILL.md` or standalone `.codebuddy/skills`; hooks in `~/.codebuddy/settings.json`, `.codebuddy/settings.json`, `.codebuddy/settings.local.json`, or plugin `hooks/hooks.json`. Local WorkBuddy adapter may write `.workbuddy/settings.local.json`, but keep profile-gated and verify with real WorkBuddy.
- Hermes Agent: plugins via `hermes plugins install <owner/repo-or-git-url>`; skills via `hermes skills install <identifier-or-url>`; hooks under `~/.hermes/hooks/<name>/HOOK.yaml` + `handler.py`; shell hooks managed by `hermes hooks` and `~/.hermes/shell-hooks-allowlist.json`. Do not mutate `kanban.db` or `state.db`.

## Standing rules

- Skills are instruction/context packages. Hooks are deterministic lifecycle code. Do not mix the claim levels.
- Native hook support requires official docs, local CLI help, source code, or real-profile proof.
- MiniMax Code and ZCode are fallback/unknown for native hooks as of this search pass.
- Shared `.agents/skills` is appropriate for cross-platform skills; plugins/hooks must be installed per host.
- Use namespaced plugin skills and lowercase kebab-case names to prevent collisions.

## Evidence routes and blockers

- Used built-in web, GitHub search, local CLI help, local memory/project evidence, and MMX search.
- GLM MCP `web-search-prime`, `web-reader`, and `zread` were not exposed in current Codex tool surface.
- Context7 was not exposed by `tool_search`.
- Kimi CLI read-only research run hit `Max number of steps reached: 3` without final answer.
- gbrain MCP search transport closed during lookup, so this Codex-owned memory file records the result directly.
