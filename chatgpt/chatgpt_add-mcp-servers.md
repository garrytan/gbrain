---
title: "Add MCP Servers"
type: note
created: 2026-01-28
updated: 2026-01-28
source: chatgpt-export
conversation_id: 697a55a5-e768-8328-b036-1a885703d11c
message_count: 2
tags: [chatgpt, import, code]
---
# Add MCP Servers

> Conversation ID: 697a55a5-e768-8328-b036-1a885703d11c
> Created: 2026-01-28T18:30:20Z
> Updated: 2026-01-28T18:32:22Z
> Messages: 2

---

## User

please add linear mcp, sentry mcp, and github mcp

---

## Assistant

Mr. White — in **Team Settings → Whitelisted MCP Servers → Add Server**, add these three entries.

### 1) Linear MCP (remote SSE)
**Server ID**
- `linear`

**Server Config (JSON)**
```json
{
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://mcp.linear.app/sse"]
}
```
citeturn4search1

---

### 2) Sentry MCP (remote SSE)
**Server ID**
- `sentry`

**Server Config (JSON)**
```json
{
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://mcp.sentry.dev/sse"]
}
```
citeturn4search2turn4search21

---

### 3) GitHub MCP
**Recommended (Windsurf plugin-store default)**
**Server ID**
- `github-mcp-server`

**Server Config (JSON)**
- leave **empty**  
citeturn1view0

**Alternative (GitHub hosted remote MCP)**
**Server ID**
- `github`

**Server Config (JSON)**
```json
{
  "serverUrl": "https://api.githubcopilot.com/mcp/"
}
```
citeturn1view0turn0search14turn0search6

If you tell me which GitHub option you want (plugin-store vs hosted remote), I’ll tailor the GitHub entry to match your setup.
