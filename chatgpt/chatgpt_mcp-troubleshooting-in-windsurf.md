---
title: "MCP troubleshooting in Windsurf"
type: note
created: 2025-12-04
updated: 2025-12-05
source: chatgpt-export
conversation_id: 69322012-1e00-832f-a799-b0452dd4495f
message_count: 2
tags: [chatgpt, import]
---
# MCP troubleshooting in Windsurf

**Related:** [[coding_troubleshoot]]

> Conversation ID: 69322012-1e00-832f-a799-b0452dd4495f
> Created: 2025-12-04T23:58:10Z
> Updated: 2025-12-05T00:36:52Z
> Messages: 2

---

## User

mcp not working in windsruf

---

## Assistant

Mr. White — if the entity["software","Windsurf",0] IDE’s entity["technical_protocol","Model Context Protocol",0] (MCP) integration isn't working, here are the most common issues plus how to troubleshoot them:

---

### ✅ Key checks  
1. Confirm MCP is enabled in Windsurf: In Settings → Cascade section, ensure MCP/Plugins support is turned on. citeturn0search1turn0search13turn0search12turn0search0  
2. Check the `mcp_config.json` file is correctly configured (e.g., correct JSON schema, server URL or command defined). citeturn0search0turn0search18turn0search13  
3. After editing config, click **Refresh** in the plugin manager to load changes. citeturn0search8turn0search18  
4. Ensure your MCP server (local or remote) is running and reachable — transport types supported are `stdio` and HTTP (with SSE) in Windsurf. citeturn0search1turn0search8  

---

### 🛠️ Troubleshooting steps  
- Open the log view (Cmd/Ctrl + Shift + P → “Show Logs” or similar) and inspect any errors related to MCP connection or tool loading. citeturn0search13  
- If using a remote server: check network, firewall, and URL correctness (e.g., missing `/mcp` path, wrong scheme) citeturn0search0turn0search18  
- If local server: ensure the command path is correct, dependencies installed (e.g., Node.js), and server started. citeturn0search13turn0search17  
- Verify the MCP server itself is serving tool definitions (check its API separately) and that the tool count is within the limit Windsurf allows. citeturn0search8  
- Check authentication/credentials: some MCP servers require API keys or tokens — mis-authenticated servers will silently fail. citeturn0search15  

---

If you like, I can walk you through *your* specific `mcp_config.json` and logs (you’d need to paste them) and we can identify exactly what’s failing. Do you want to do that?


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]


## See Also
- [[chatgpt/chatgpt_ac-crackling-troubleshooting]]
- [[chatgpt/chatgpt_ac-not-working-troubleshooting]]
- [[chatgpt/chatgpt_al-error-troubleshooting]]
- [[chatgpt/chatgpt_app-crash-troubleshooting]]
- [[chatgpt/chatgpt_auto-claude-troubleshooting-steps-part1]]
