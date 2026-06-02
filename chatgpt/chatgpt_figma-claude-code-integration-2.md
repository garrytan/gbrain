---
conversation_id: 699c9c6e-c3e0-8325-a147-3db5e5d8a512
created: 2026-02-23
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Figma Claude Code Integration
type: note
updated: 2026-02-23
---

# Figma Claude Code Integration

**Related:** [[coding_ai]]

> Conversation ID: 699c9c6e-c3e0-8325-a147-3db5e5d8a512
> Created: 2026-02-23T18:29:03Z
> Updated: 2026-02-23T18:29:36Z
> Messages: 2

---

## User

figma claude code plugin

---

## Assistant

There **isn’t currently a standalone “Figma Claude Code plugin” in the Figma Marketplace** in the traditional sense — but there *are real, supported ways to integrate Claude’s code-generation capabilities with Figma designs for design-to-code workflows: citeturn0search1turn0search21

### 🔹 Official Integration: Claude + Figma via MCP / Connector
Anthropic and Figma now support a **Model Context Protocol (MCP)-based connection** that lets AI tools like **Claude / Claude Code** interact with Figma design files: citeturn0search1turn0search21

- **Figma Connector for Claude**: In Claude (desktop or cloud), you can install the Figma connector, which retrieves design frames and context and then generates code from them. citeturn0search21  
- **MCP Server (Figma Dev Mode)**: By enabling the MCP server in the Figma desktop app (Dev Mode), Claude Code and similar tools can access design tokens, layout, components, etc., to generate accurate code. citeturn0search16  
- You can share a Figma design link with Claude or select frames directly and ask it to generate React, HTML/CSS, Tailwind, etc. citeturn0search12

This is effectively a *plugin-like integration* but it runs via Claude’s connector/MCP rather than a simple one-click install in Figma.

### 🔹 “Code to Canvas” (Reverse Workflow)
Figma announced **Code to Canvas**, a feature where working UIs built with Claude Code can be captured and pasted back into Figma as editable frames — not exactly a plugin, but a workflow integration bridging code → design: citeturn0news25turn0search14

### 🔹 Community / GitHub Projects
There are community efforts (e.g., MCP bridges on GitHub) that aim to connect Claude Desktop/Claude Code with Figma via the MCP protocol, enabling deeper AI interaction: citeturn0search18

---

### Summary
- **Official integration exists** via Claude’s Figma connector and Figma’s MCP server — this is how you effectively get Claude to *read* designs and *generate code* from them (similar to a “plugin”). citeturn0search21  
- There isn’t a simple Figma-store plugin named “Claude Code plugin,” but the connector + MCP setup gives essentially the same outcome. citeturn0search1  
- You can also bring AI-generated UI *back into* Figma via the Code to Canvas feature from Figma’s AI partnership. citeturn0news25

If you want setup steps or an example prompt for generating code from a Figma file with Claude, tell me what framework or output you need (React, Tailwind, etc.).


**Topic:** [[chatgpt-clusters/coding_ai]]


## See Also
- [[chatgpt/chatgpt_claude-code-figma-integration]]
- [[chatgpt/chatgpt_figma-claude-code-integration]]
- [[chatgpt/chatgpt_claude-code-to-figma]]
- [[chatgpt/chatgpt_apple-shortcuts-claude-code]]
- [[chatgpt/chatgpt_claude-agent-teams-integration]]
