---
title: "Add gbrain as MCP"
type: note
created: 2026-05-08
updated: 2026-05-08
source: chatgpt-export
conversation_id: 69fd648c-f200-83e8-b3e9-93dcea0609e9
message_count: 3
tags: [chatgpt, import, code]
---
# Add gbrain as MCP

> Conversation ID: 69fd648c-f200-83e8-b3e9-93dcea0609e9
> Created: 2026-05-08T04:20:29Z
> Updated: 2026-05-08T04:23:41Z
> Messages: 3

---

## User

can we add gbrain to this enviroment as an mcp?

---

## Assistant

Mr. White, I’ll verify what “gbrain” refers to, whether a GBrain MCP/server exists or is exposed here, and whether this environment can add it directly.

---

## Assistant

Mr. White, **yes — GBrain can be added as an MCP**, but **I can’t add it directly to this chat runtime from inside the conversation**. The currently exposed tool/MCP space here does not include GBrain. You would need to add it through ChatGPT’s Developer Mode / Apps / Connectors settings, or configure it in another MCP client.

The key constraint: **ChatGPT requires a remote MCP server**. OpenAI’s help docs say local MCP servers are not currently supported, and only remote servers are supported. citeturn338586view2 OpenAI’s developer docs also say Developer Mode supports MCP over **SSE and streaming HTTP**, with OAuth / no-auth / mixed auth options. citeturn338586view5

For GBrain specifically, the GBrain docs say v0.26.0+ supports `gbrain serve --http` with **OAuth 2.1 + PKCE**, which is the path that works with ChatGPT. They also state ChatGPT does not support bearer-token MCP servers, so you need the OAuth HTTP server. citeturn826387view0

### Minimal setup

```bash
gbrain serve --http --port 3131
```

Then expose it publicly, for example:

```bash
ngrok http 3131 --url your-brain.ngrok.app
```

GBrain’s recommended remote command is:

```bash
gbrain serve --http --port 3131 --public-url https://your-brain.ngrok.app
```

GBrain says the ChatGPT MCP URL should be:

```text
https://your-brain.ngrok.app/mcp
```

and ChatGPT auto-discovers the OAuth metadata endpoint. citeturn826387view0

### ChatGPT-side steps

1. Open **ChatGPT → Settings → Apps / Connectors → Advanced settings**.
2. Enable **Developer Mode**.
3. Create a new custom app / MCP connector.
4. Use the GBrain MCP URL:

```text
https://your-brain.ngrok.app/mcp
```

5. Use OAuth. Register a `chatgpt` client in the GBrain admin dashboard with:
   - Grant type: `authorization_code`
   - Scopes: `read write`
   - Redirect URI copied from ChatGPT’s connector setup screen
   - Leave `admin` scope unchecked for ChatGPT

GBrain’s docs recommend `read write` for ChatGPT and reserving `admin` for local CLI / admin dashboard use. citeturn826387view0

### Availability caveat

OpenAI’s Help Center says full MCP support with write/modify actions is currently rolling out for Business, Enterprise, and Edu plans, while Pro users can connect MCPs with read/fetch permissions in developer mode. citeturn338586view3 OpenAI’s developer docs also list Developer Mode eligibility across Pro, Plus, Business, Enterprise, and Education on the web, so the exact capabilities may depend on your plan and workspace settings. citeturn338586view5

So: **yes for your ChatGPT account/workspace if Developer Mode/custom apps are available; no for me to install it into this current runtime directly.**


## See Also
- [[chatgpt/chatgpt_connect-gbrain-to-chatgpt]]
- [[chatgpt/chatgpt_cost-for-gbrain]]
- [[chatgpt/chatgpt_gbrain-embedding-explanation]]
- [[chatgpt/chatgpt_gbrain-for-jovie-integration]]
- [[chatgpt/chatgpt_gbrain-wikilink-query]]
