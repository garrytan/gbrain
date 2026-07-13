# 239-codex-new-search-multiplexing-rule-20260620

Recorded: 2026-06-20 02:21:06 +0800 China time
Owner/prefix: `239-codex-new-`
Marker: `239-codex-new-search-multiplexing-rule-20260620`

## Search Source Multiplexing Rule

- When a task requires search, current external information, research, or source refresh, Codex must use the available GLM-related MCP/search route, MiniMax API/search route, and Kimi CLI/search route in addition to built-in/web search.
- For code, program, library, API, framework, CLI, plugin, MCP, repository, runtime, or engineering information, Codex must additionally search GitHub sources when applicable, including repositories, issues, pull requests, discussions, or release notes; it must also use Context7 documentation search when available.
- If any required search surface is unavailable, unauthenticated, quota-limited, missing from the current tool list, or unsafe for the task, Codex must record the exact blocker and continue with the available primary/official sources rather than claiming that all required routes were searched.
- This rule does not override source quality: official docs, primary source code, project-local evidence, and directly verified runtime behavior remain preferred over secondary summaries.
- Do not expose API keys, full tokens, or sensitive account data while invoking search routes.
