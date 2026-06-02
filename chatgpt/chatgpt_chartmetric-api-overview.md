---
title: "Chartmetric API overview"
type: note
created: 2025-12-18
updated: 2025-12-18
source: chatgpt-export
conversation_id: 69444188-384c-832e-b290-c0f13695851e
message_count: 2
tags: [chatgpt, import]
---
# Chartmetric API overview

> Conversation ID: 69444188-384c-832e-b290-c0f13695851e
> Created: 2025-12-18T18:01:45Z
> Updated: 2025-12-18T18:02:39Z
> Messages: 2

---

## User

chartmetric api

---

## Assistant

Here’s a concise overview of **Chartmetric’s API** and how it works:

**What it is**  
- Chartmetric provides a **REST-based Developer API** that lets you programmatically access its music-industry data — artist analytics, charts, playlists, radio airplay, social metrics, etc. — in JSON format. citeturn0search0turn0search5

**Access & Authentication**  
- You must **request API access** through your Chartmetric account settings; it’s a separate subscription from a standard Chartmetric login. citeturn0search8  
- Once approved, you’re issued a **refresh token** tied to your subscription and use that to obtain short-lived **access tokens** that you include with each request. citeturn0search17

**Docs & Endpoints**  
- Official API documentation and a complete list of endpoints are at:  
  **https://api.chartmetric.com/apidoc/**. citeturn0search4  
- Endpoints cover things like **artist metadata, track and playlist data, charts, and more** — all via predictable REST URLs returning JSON. citeturn0search0

**Rate Limits & Plans**  
- Trial access typically allows limited requests (e.g., ~1,000/day), with paid subscription plans offering higher rate limits depending on your tier. citeturn0search8

**Extras**  
- Community tools like the **Chartmetric CLI** exist to query the API from the terminal using your refresh token. citeturn0search16

If you want an example of calling a specific endpoint (like artist metadata) or how to authenticate in code (Python or JS), tell me your language of choice.
