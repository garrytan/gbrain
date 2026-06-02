---
conversation_id: 699d936e-7fe0-832c-8abd-74dec73afd70
created: 2026-02-24
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Claude Code to Figma
type: note
updated: 2026-02-24
---

# Claude Code to Figma

> Conversation ID: 699d936e-7fe0-832c-8abd-74dec73afd70
> Created: 2026-02-24T12:02:55Z
> Updated: 2026-02-24T12:03:29Z
> Messages: 2

---

## User

claude code to figma

---

## Assistant

**Claude Code → Figma (Claude Code to Figma)**

There’s *now an official way* to take UI/code you’re working on with **Claude Code** and turn it directly into editable Figma designs, called **“Code to Canvas.”** This isn’t just exporting code — it captures a running UI and converts it into real Figma frames you can edit like native design layers. citeturn0search0turn0search3

### What it is
- **Claude Code → Figma editable UI:** You build or preview a UI in Claude Code, then send it to Figma as editable frames (not flat images). citeturn0search0  
- Works with **live browser previews** — it captures the rendered UI and preserves structure, text, auto-layout, etc. citeturn0search2  
- You can *organize, refine, annotate, and share* that in Figma. citeturn0search3

### How to do it (high-level)
1. **Enable Figma’s MCP server:**  
   - Turn on Dev Mode → Enable the Model Context Protocol server in the Figma desktop app. citeturn0search9
2. **Connect Claude Code to Figma:**  
   - In your terminal, add Figma as a remote MCP server:  
     ```
     claude mcp add --transport http figma <MCP_SERVER_URL>
     ```  
   - Authenticate via the OAuth flow. citeturn0search2  
3. **Capture UI:**  
   - In Claude Code, type a command like “Send this to Figma.” Claude will grab the current UI and push it into your Figma file as editable design layers. citeturn0search2  

### Alternative workflow (non-official)
If you just want *to bring Claude-generated code into Figma* without the MCP integration, you can:
- **Generate a full webpage from Claude**, publish it, then import via a plugin like **html.to.design** in Figma. That converts a live site into editable frames. citeturn0search8

### Key points
- This is **new and official** (Code to Canvas via Figma + Claude Code). citeturn0news29  
- Output stays editable — text, layout, components, not a static screenshot. citeturn0search3  
- Requires MCP setup and authentication between Claude Code and Figma. citeturn0search9

If you want step-by-step terminal commands or a script example for installing and authenticating the MCP connection, let me know.


**Topic:** [[chatgpt-clusters/coding_ai]]
