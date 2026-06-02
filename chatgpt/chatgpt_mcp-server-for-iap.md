---
title: "MCP server for IAP"
type: note
created: 2025-11-12
updated: 2025-11-12
source: chatgpt-export
conversation_id: 6914f1be-4a38-832f-9c9a-fdc5ca631513
message_count: 2
tags: [chatgpt, import]
---
# MCP server for IAP

> Conversation ID: 6914f1be-4a38-832f-9c9a-fdc5ca631513
> Created: 2025-11-12T20:44:58Z
> Updated: 2025-11-12T20:45:47Z
> Messages: 2

---

## User

Does App Store Connect or apple developer offer an mcp server to set up in app purchases etc

---

## Assistant

Short answer: no.

Apple doesn’t publish an official **MCP (Model Context Protocol) server** for App Store Connect or In-App Purchases. MCP is an Anthropic-originated protocol; Apple’s tooling doesn’t use it. citeturn0news52

What Apple does provide (and what teams actually use for IAP setup/ops):
- **App Store Connect API** — includes endpoints to **create and manage in-app purchases** (e.g., `POST /v2/inAppPurchases`). citeturn1search1turn1search0turn1search2  
- **App Store Server API & Server Notifications** — for validating transactions, refunds, status changes, etc.; plus Apple’s **Server Library** to simplify auth and signed data verification. citeturn1search6turn1search12  
- **Keys you’ll need** — an **In-App Purchase key** and/or **App Store Connect API key** (Issuer ID, Key ID, `.p8`), created in App Store Connect → Users and Access → Integrations. citeturn2search0turn2search2turn2search6

If you specifically want MCP-based workflows, there are **community MCP servers** that wrap Apple’s official APIs (not Apple-hosted/endorsed), for example the open-source **App Store Connect MCP Server**. Evaluate security and scope before using. citeturn0search1turn0search19

If you’d like, Mr. White, I can sketch the minimal flow (keys → JWT → `POST /v2/inAppPurchases`) or provide a ready-to-run curl/Node snippet using Apple’s docs.
