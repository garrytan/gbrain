---
title: "Cursor API Key Guide"
type: note
created: 2025-12-29
updated: 2025-12-29
source: chatgpt-export
conversation_id: 6951de2f-e1b4-8330-8bd4-05ec8a8d9254
message_count: 2
tags: [chatgpt, import, code]
---
# Cursor API Key Guide

> Conversation ID: 6951de2f-e1b4-8330-8bd4-05ec8a8d9254
> Created: 2025-12-29T01:49:37Z
> Updated: 2025-12-29T01:49:44Z
> Messages: 2

---

## User

cursor api key

---

## Assistant

Here’s how Cursor **API keys** work and how to get one, Mr. White:

**What a Cursor API key is**  
An API key for Cursor is a secret token that lets you authenticate against certain Cursor APIs — like the **Background Agent API** or the **Admin API** — to interact programmatically (e.g., via CLI or automation). citeturn0search11

**Types of keys**  
- **Cursor User API Key**: Used for the headless Cursor Agent CLI and Background Agent API. citeturn0search11  
- **Cursor Admin API Key**: Lets you access team data, usage metrics, and other admin-level APIs. citeturn0search5

**How to create/get a Cursor API key**  
1. Go to your Cursor dashboard: **cursor.com/dashboard**. citeturn0search1  
2. Open **Settings**. citeturn0search1  
3. Find **Advanced → Admin API Keys** (or similar). citeturn0search1  
4. Click **Create New API Key**. You’ll be prompted to name it (e.g., “Automation”). citeturn0search1  
5. **Copy and store the key immediately** — you may not see it again. citeturn0search13

*Note:* Admin API keys may only be available on certain plans (e.g., Business). citeturn0search4

**Using your API key**  
- For authenticated API requests (like Background Agent endpoints), include it in the Authorization header:  
  ```
  Authorization: Bearer <your_cursor_api_key>
  ```  
  citeturn0search12

**Separate from LLM provider keys**  
If you want Cursor to use your **OpenAI/Anthropic/Google/Azure** API keys (so you pay the provider directly), add those under **Settings → Models → API Keys** in Cursor. citeturn0search10

If you want step-by-step guidance on where those settings appear in the UI, I can walk you through it.
