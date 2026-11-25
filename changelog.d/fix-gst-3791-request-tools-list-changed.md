**Agents on a remote GBrain connection now see the tools they unlock with `request_tools`, and Codex and OpenClaw agents are told plainly when those tools arrive.**

### Fixed
- On the OAuth HTTP server, `request_tools {"surface": ...}` now sends `notifications/tools/list_changed` on the call's own response stream, and the server declares `tools.listChanged`. A client that refreshes on that notice picks up the new tools without reconnecting. The reply says the notice was sent only when it actually went out.
- Codex and OpenClaw keep the tool list they got at the start of a turn (Codex) or a run (OpenClaw). On a local connection, GBrain now tells them when unlocked tools become callable, instead of "call them now", and names the setup command that registers the full tool list for good.
- A tool now counts as already callable only if the client's latest `tools/list` answer included it.
- Docs: the agent operator protocol has a table showing how Codex and OpenClaw handle a changed tool list. The MCP deploy guide and the surface runbook cover the HTTP notice.
