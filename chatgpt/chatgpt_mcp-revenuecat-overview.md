---
conversation_id: 6928c6df-708c-8325-aca3-d977898a32e9
created: 2025-11-27
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: MCP RevenueCat overview
type: note
updated: 2025-11-27
---

# MCP RevenueCat overview

> Conversation ID: 6928c6df-708c-8325-aca3-d977898a32e9
> Created: 2025-11-27T21:47:14Z
> Updated: 2025-11-27T21:47:53Z
> Messages: 2

---

## User

mcp revenue cat

---

## Assistant

Here’s a summary of **entity["software", "RevenueCat MCP Server", 0]** (MCP) and what it enables:

---

### What is it  
- RevenueCat MCP Server implements the entity["technical_standard", "Model Context Protocol (MCP)", 0] standard to allow AI assistants (or other tooling) to manage subscription-apps via the entity["software", "RevenueCat", 0] platform, without using the dashboard manually. citeturn0search2turn0search1  
- It acts as a bridge between AI tooling and the RevenueCat v2 API. citeturn0search12turn0search2  

---

### Key Capabilities  
With MCP you can do things like:  
- Create and manage apps, products (subscriptions, consumables, etc.), entitlements, offerings, paywalls via natural-language / programmatic tooling. citeturn0search1turn0search12turn0search2  
- Use either a cloud MCP server (hosted by RevenueCat) or a local development extension (e.g., VS Code, Cursor) depending on your workflow. citeturn0search6turn0search2  
- Authenticate via an API-v2 secret key (or OAuth in supported clients) to connect your AI tooling to the MCP endpoint. citeturn0search6turn0search1  

---

### What it’s *not* (yet)  
- Although you can create products and configure in RevenueCat via MCP, MCP currently does *not* publish those products directly into the app store consoles (like App Store Connect or Google Play) in all cases. citeturn0search1  
- It focuses on configuration within RevenueCat rather than full store-publishing automation (at least as of the public beta).  

---

If you like, Mr. White, I can pull up **detailed instructions (with code samples)** for using the MCP server (authentication, tool calls, examples) in your workflow. Would you like that?


**Topic:** [[chatgpt-clusters/business_startup]]
