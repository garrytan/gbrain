---
title: "Neon MCP server URL"
type: note
created: 2025-12-22
updated: 2025-12-22
source: chatgpt-export
conversation_id: 6948920d-5c24-8331-a320-d98c009867f8
message_count: 2
tags: [chatgpt, import, code]
---
# Neon MCP server URL

> Conversation ID: 6948920d-5c24-8331-a320-d98c009867f8
> Created: 2025-12-22T00:34:22Z
> Updated: 2025-12-22T00:35:24Z
> Messages: 2

---

## User

give me the neon mcp server url

---

## Assistant

The **Neon MCP server URL** for the **remote hosted MCP endpoint** you’d add to your MCP client config is:

```
https://mcp.neon.tech/mcp
```

Alternately, for **Server-Sent Events (SSE)** transport you can use:

```
https://mcp.neon.tech/sse
``` citeturn0search0turn0search3

Use this URL in your MCP client (e.g., Claude Code, Cursor, etc.) config under the `"url"` or `"args"` field when setting up the Neon MCP server connection. citeturn0search0


**Topic:** [[chatgpt-clusters/coding_devops]]


## See Also
- [[chatgpt/chatgpt_accessing-localhost-server]]
- [[chatgpt/chatgpt_bartender-server-cover-letter]]
- [[chatgpt/chatgpt_clerk-mcp-server]]
- [[chatgpt/chatgpt_dev-server-testing-optimization]]
- [[chatgpt/chatgpt_mcp-server-for-iap]]
