---
title: "Statsig toolbar inquiry"
type: note
created: 2026-01-24
updated: 2026-01-24
source: chatgpt-export
conversation_id: 69755512-bedc-8331-818a-ef3ba0af7526
message_count: 2
tags: [chatgpt, import]
---
# Statsig toolbar inquiry

> Conversation ID: 69755512-bedc-8331-818a-ef3ba0af7526
> Created: 2026-01-24T23:26:11Z
> Updated: 2026-01-24T23:27:32Z
> Messages: 2

---

## User

statsig have a toolbar or something?

---

## Assistant

Short answer: **Statsig itself doesn’t install a “toolbar” in your product**, but there *is* an editor/visual tool inside their platform UI, and if you integrate it with another platform you *might* get toolbar-like controls. citeturn0search1turn0search4

**What exists:**

- **Statsig Console:** The main web UI where you manage feature flags, experiments, metrics, analytics, etc. That’s the standard dashboard you log into — *not* a browser toolbar. citeturn0search1

- **Statsig Visual Editor:** A visual interface (previously called “Sidecar”) inside the Statsig console that lets you create experiments without code. It was once a Chrome extension but the new version runs inside the console UI. citeturn0search4

- **Third-party integrations (like Vercel):** Some platforms (e.g., Vercel) offer a **Flags Explorer in their toolbar** that lets you see/override feature flags (including Statsig flags) directly in the platform’s toolbar while previewing your app. That’s a toolbar experience — but it’s part of the *other* platform, not Statsig itself. citeturn0search5

So: **no built-in browser toolbar from Statsig itself**, but there *are* UI tools within the web console and toolbar experiences provided by integrations.


## See Also
- [[chatgpt/chatgpt_linear-internal-toolbar-explanation]]
- [[chatgpt/chatgpt_vercel-flags-toolbar]]
- [[chatgpt/chatgpt_vercel-toolbar-download]]
- [[chatgpt/chatgpt_vercel-toolbar-local-setup]]
- [[chatgpt/chatgpt_ai-ops-setup-inquiry]]
