---
conversation_id: 690faedd-30d8-8330-b651-7728d44b29f6
created: 2025-11-08
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: RevenueCat MCP overview
type: note
updated: 2025-11-08
---

# RevenueCat MCP overview

> Conversation ID: 690faedd-30d8-8330-b651-7728d44b29f6
> Created: 2025-11-08T20:58:09Z
> Updated: 2025-11-08T20:58:43Z
> Messages: 2

---

## User

revenue cat mcp

---

## Assistant

Hi Mr. White — here’s a summary of entity["software", "RevenueCat MCP Server", 0] (Model Context Protocol) from entity["brand", "RevenueCat", 0]:

---

### What it is  
- The MCP Server is a bridge between AI assistants and the RevenueCat API—allowing natural-language commands to manage your subscription infrastructure (apps, products, entitlements, offerings, paywalls). citeturn0search1turn0search8turn0search0  
- It supports both a **cloud deployment** and a **local extension** (e.g., for VS Code or Cursor). citeturn0search1turn0search5  
- It provides ~26 distinct “tools” (API endpoints/commands) such as creating apps, listing products, attaching entitlements, etc. citeturn0search10turn0search0  

---

### Key use-cases  
- Developers or product teams can instruct the system via plain language: e.g., “Create a monthly subscription product for iOS and Android” and the MCP server does it in RevenueCat. citeturn0search21turn0search8  
- Especially useful if you want to embed subscription-management commands into developer workflows (AI assistants, editor integrations) instead of manually using the RevenueCat dashboard. citeturn0search8turn0search1  
- Cross-platform product/app management: Create apps, set up products/offers across iOS, Android, web etc. citeturn0search1turn0search21  

---

### Setup & security notes  
- You’ll need your RevenueCat **API v2 secret key**, or OAuth for supported clients. citeturn0search5turn0search8  
- Best practice: Use scoped keys (read-only vs write), rotate keys, separate environments. citeturn0search8  
- When using local extension, you install an extension in your editor, set up config (e.g., `mcp.json`), and ensure your credentials aren’t committed to version control. citeturn0search5turn0search6  

---

### Limitations / current state  
- As of the info available, it **does not** create products directly in external platforms (like Apple App Store Connect, Google Play Console) for you — only in the RevenueCat system. citeturn0search8  
- It’s fairly new / in “public beta” mode (according to their blog) so you’ll want to test carefully before relying on it in production. citeturn0search8  

---

If you like, I can pull together the **full list of the 26 tools/commands**, and we can review how to integrate this into your stack (e.g., mobile apps built with Flutter/React-Native) — would that be useful?


**Topic:** [[chatgpt-clusters/business_startup]]
