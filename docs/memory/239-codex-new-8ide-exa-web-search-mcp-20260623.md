# 239-codex-new 8 IDE Exa web-search MCP and full-search rule

Recorded: 2026-06-23 01:30 +0800 China time
Owner/prefix: `239-codex-new-`

## Rule update

Future "full search" / "全量搜索" / search-current-info tasks must include Exa MCP `web-search-exa` when available, in addition to:

- built-in/web search
- GLM MCP `web-search-prime`, `web-reader`, `zread`
- Kimi CLI/search
- MiniMax/MMX M3 thinking/search/advice
- GitHub/GH evidence surfaces for code/repo/runtime topics
- Context7 docs for code/library/API/runtime topics

Exa is specifically for semantic search, URL content extraction, company research, people research, code/doc examples, and deep research. If unavailable, rate-limited, not exposed, or unauthenticated, record the exact blocker.

## Installed server

Server name: `web-search-exa`

URL:

`https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa,deep_researcher_start,deep_researcher_check,get_code_context_exa,company_research_exa,crawling_exa,people_search_exa,linkedin_search_exa,deep_search_exa`

`EXA_API_KEY` was not set, so no fake key was written. Add `x-api-key` later for high-volume or production use.

## 8 IDE configuration

- Codex: `C:\Users\datoo\.codex\config.toml`
- Claude: `C:\Users\datoo\.claude.json`
- Kimi Code: `C:\Users\datoo\.kimi\mcp.json`
- OpenCode: `C:\Users\datoo\.config\opencode\opencode.json`
- GLM ZCode: `C:\Users\datoo\.zcode\v2\config.json`
- MiniMax Code: `C:\Users\datoo\.mavis\mcp\mcp.json`
- WorkBuddy/CodeBuddy: `C:\Users\datoo\.codebuddy\.mcp.json` and `C:\Users\datoo\.codebuddy\mcp.json`
- Hermes Agent: `C:\Users\datoo\AppData\Local\hermes\config.yaml`

## Runtime proof

- `codex mcp list`: enabled `web-search-exa`
- `claude mcp list`: connected `web-search-exa`
- `kimi mcp test web-search-exa`: connected, 10 tools
- `hermes mcp test web-search-exa`: connected, 10 tools

Tools discovered:

- `web_search_exa`
- `web_search_advanced_exa`
- `company_research_exa`
- `web_fetch_exa`
- `crawling_exa`
- `people_search_exa`
- `linkedin_search_exa`
- `deep_researcher_start`
- `deep_researcher_check`
- `get_code_context_exa`

Restart desktop IDEs or open a new session before claiming runtime-loaded status there.
