# 239-codex-new 8 IDE ZCode and Context7 MCP correction

Recorded: 2026-06-23 01:10 +0800 China time
Owner/prefix: `239-codex-new-`

## Scope

User's "all IDE" scope is 8 surfaces:

1. Kimi Code
2. GLM ZCode
3. MiniMax Code
4. WorkBuddy/CodeBuddy
5. OpenCode
6. Claude
7. Codex
8. Hermes Agent

## ZCode correction

ZCode is confirmed to have official Plugin, Skill, MCP Servers, Subagents, Commands, and Hook-bearing plugin concepts.

Evidence:
- ZCode Plugin docs: a plugin can package Skill, Command, Agent/Subagent, MCP server, Hook, and LSP.
- ZCode Skill docs: user-level skills live at `~/.zcode/skills/<skill-name>/SKILL.md` and are invoked with `$skill-name`.
- ZCode MCP docs: MCP servers can be manually added and imported from Claude Code, Codex CLI, OpenCode, and generic `.agents`.
- Local proof: `C:\Users\datoo\.zcode\v2\config.json` contains an active `mcp` block.

## GLM MCP names

Use exact names:

- `web-search-prime`
- `web-reader`
- `zread`

## Context7 configuration

Configured or confirmed Context7 MCP across the 8 surfaces:

- Codex: `C:\Users\datoo\.codex\config.toml`
- Claude: `C:\Users\datoo\.claude.json`
- OpenCode: `C:\Users\datoo\.config\opencode\opencode.json`
- Kimi Code: `C:\Users\datoo\.kimi\mcp.json`
- GLM ZCode: `C:\Users\datoo\.zcode\v2\config.json`
- MiniMax Code: `C:\Users\datoo\.mavis\mcp\mcp.json`
- WorkBuddy/CodeBuddy: `C:\Users\datoo\.codebuddy\.mcp.json` and `C:\Users\datoo\.codebuddy\mcp.json`
- Hermes Agent: `C:\Users\datoo\AppData\Local\hermes\config.yaml`

Local stdio command:

`cmd /c npx -y @upstash/context7-mcp`

`CONTEXT7_API_KEY` was not set, so no fake key was written.

Runtime proof:
- `codex mcp list` shows `context7` enabled.
- `kimi mcp test context7` connected and found `resolve-library-id` and `query-docs`.
- `hermes mcp test context7` connected and found `resolve-library-id` and `query-docs`.
- `opencode mcp list` timed out during full enumeration; OpenCode claim is static config only until runtime retest.

Restart each desktop IDE or open a new session before claiming runtime-loaded status.
