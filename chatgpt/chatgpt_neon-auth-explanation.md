---
title: "Neon Auth Explanation"
type: note
created: 2026-01-04
updated: 2026-01-04
source: chatgpt-export
conversation_id: 695acf27-fda0-832d-b758-8bd9d7dc395b
message_count: 2
tags: [chatgpt, import]
---
# Neon Auth Explanation

> Conversation ID: 695acf27-fda0-832d-b758-8bd9d7dc395b
> Created: 2026-01-04T20:35:52Z
> Updated: 2026-01-04T20:36:31Z
> Messages: 2

---

## User

neon ock auth

---

## Assistant

**Neon Auth** is a managed authentication service from **Neon** that ties user identity directly to your database. It’s not “Neon OCK Auth” — likely you meant **Neon Auth** (sometimes powered by *Better Auth*).citeturn0search0turn0search2

**What it is**
- A **managed auth service** that handles user accounts, sessions, OAuth providers, and auth config. All auth data lives in your Neon Postgres database under a special schema (`neon_auth`).citeturn0search0
- Runs as a REST API service (no server infra you manage).citeturn0search6
- Built on **Better Auth**, giving you out-of-the-box sign-up/sign-in flows and session/JWT handling.citeturn0search0

**Key points**
- Auth data (users, sessions, configs) **branches with your database**, so preview/dev branches get separate auth states.citeturn0search0
- You *can* query auth tables directly with SQL (e.g., list users), since they live inside the database.citeturn0search0
- It supports standard email/password and social OAuth providers.citeturn0search6
- You integrate via Neon’s SDK or REST API: client calls go to the Neon Auth service and return tokens/sessions for your app.citeturn0search6

**Distinction from API Key Auth**
- Separately, Neon’s core API (for managing projects, resources, etc.) uses **Bearer API keys** for authentication in requests. That’s *not* the same as Neon Auth user auth — that’s for Neon’s platform API.citeturn0search1

If you meant something more specific with “OCK” (e.g., a particular auth flow or acronym), clarify and I can drill into that.


## See Also
- [[chatgpt/chatgpt_clerk-auth-vs-neon-auth]]
- [[chatgpt/chatgpt_neon-auth-and-clerk]]
- [[chatgpt/chatgpt_neon-auth-blog-mock]]
- [[chatgpt/chatgpt_neon-auth-overview]]
- [[chatgpt/chatgpt_neon-auth-pricing-2]]
