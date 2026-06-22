# 239-ecc-comet 8 IDE effective rule/MCP/skills paths

Recorded: 2026-06-23 01:49 +0800 China time
Owner/prefix: `239-ecc-comet-`

## Prefix correction

The earlier file `239-codex-new-8ide-rule-mcp-paths-20260623.md` used the wrong prefix for this lane. The correct prefix is `239-ecc-comet-`. Prefer this file when resolving ownership for the 8-IDE comet-ecc configuration matrix.

## Scope

The user's "all IDE" scope is now 8 surfaces:

1. Codex
2. Claude Code
3. Kimi Code
4. GLM ZCode
5. MiniMax Code
6. WorkBuddy / CodeBuddy
7. OpenCode
8. Hermes Agent

## Effective local paths

- Codex: `C:\Users\datoo\.codex\AGENTS.md`, `C:\Users\datoo\.codex\config.toml`, `C:\Users\datoo\.codex\hooks.json`, `.codex\skills`, `.codex\plugins`.
- Claude Code: `C:\Users\datoo\.claude\CLAUDE.md`, `C:\Users\datoo\.claude\rules\`, `C:\Users\datoo\.claude.json`, `C:\Users\datoo\.claude\settings.json`, `.claude\settings.local.json`, `.claude\skills`, `.claude\agents`, `.claude\hooks`.
- Kimi Code: `C:\Users\datoo\.kimi\config.toml`, `C:\Users\datoo\.kimi\mcp.json`, `C:\Users\datoo\.kimi\skills`, `C:\Users\datoo\.kimi-code\skills`, `C:\Users\datoo\.agents\skills`; no local `.kimi\AGENTS.md` or `.kimi\KIMI.md`.
- OpenCode: `C:\Users\datoo\.config\opencode\AGENTS.md`, `C:\Users\datoo\.config\opencode\opencode.json`, `C:\Users\datoo\.config\opencode\skills`, `C:\Users\datoo\.config\opencode\plugins`.
- GLM ZCode: `C:\Users\datoo\.zcode\v2\config.json`, `C:\Users\datoo\.zcode\cli\config.json`, `.zcode\skills`, `.zcode\commands`, `.zcode\rules`, `.zcode\cli\plugins`; official global `~\.zcode\AGENTS.md` missing locally.
- MiniMax Code: `C:\Users\datoo\.mavis\config.yaml`, `C:\Users\datoo\.mavis\mcp\mcp.json`, `.mavis\skills`, `.mavis\agents`, `.mavis\plugins`, `.mavis\.opencode`; no local `.mavis\AGENTS.md` or `.mavis\MAVIS.md`.
- WorkBuddy/CodeBuddy: `C:\Users\datoo\.codebuddy\CODEBUDDY.md`, `C:\Users\datoo\.codebuddy\.mcp.json`, `C:\Users\datoo\.codebuddy\mcp.json`, `.codebuddy\skills`, `.codebuddy\commands`, `.codebuddy\plugins`, `.codebuddy\extensions`, `C:\Users\datoo\AppData\Roaming\WorkBuddy\User\settings.json`; no `.codebuddy\AGENTS.md` and no `.codebuddy\settings.json`.
- Hermes Agent: `C:\Users\datoo\AppData\Local\hermes\SOUL.md`, `C:\Users\datoo\AppData\Local\hermes\config.yaml`, Hermes `skills`, `hooks`, `profiles`; no Hermes-home `AGENTS.md` and no shell hook allowlist yet.

## Official rule behavior summary

- Codex reads global `~/.codex/AGENTS.md` and project `AGENTS.override.md` / `AGENTS.md` while walking from project root to cwd.
- Claude Code reads `CLAUDE.md` files, user/project `.claude/rules`, and auto memory; it does not read `AGENTS.md` unless imported by `CLAUDE.md`.
- Kimi Code CLI uses `~/.kimi/config.toml`, `~/.kimi/mcp.json`, and can inject `${KIMI_AGENTS_MD}` merged from project `AGENTS.md` and `.kimi/AGENTS.md`.
- OpenCode reads project/global `AGENTS.md`, with Claude compatibility fallback only when OpenCode AGENTS is absent.
- ZCode reads user `~/.zcode/AGENTS.md` and workspace `AGENTS.md`; it does not continuously read `CLAUDE.md` at runtime.
- CodeBuddy official docs confirm `~/.codebuddy/skills`, `.codebuddy/skills`, frontmatter hooks, and MCP priority `~/.codebuddy/.mcp.json` > `~/.codebuddy/mcp.json` > `~/.codebuddy.json`.
- Hermes loads `SOUL.md` independently and project context by priority `.hermes.md` / `HERMES.md` > hierarchical `AGENTS.md` > cwd `CLAUDE.md` > `.cursorrules`.

## Search routing update

- GLM MCP exact names: `web-search-prime`, `web-reader`, `zread`.
- Exa MCP exact server name: `web-search-exa`.
- Full search means using every available route: built-in/web search, GLM three MCPs, Exa, Kimi, MiniMax/MMX M3, GitHub/GH, and Context7 for code/library/API/runtime topics; any missing route must be logged as a blocker.

## Blockers

- Kimi route was callable but hit max-step limit twice before final answer.
- MMX route was callable but returned low-quality results for this specific query.
- Current Codex tool surface did not expose GLM/Context7/Exa MCP tools, so live use of those MCPs was not proven in this session.
