---
title: "Authenticated User 404 UX"
type: note
created: 2026-01-27
updated: 2026-01-27
source: chatgpt-export
conversation_id: 697918a5-8f14-8328-a095-144b129388e0
message_count: 2
tags: [chatgpt, import]
---
# Authenticated User 404 UX

> Conversation ID: 697918a5-8f14-8328-a095-144b129388e0
> Created: 2026-01-27T19:57:26Z
> Updated: 2026-01-27T19:57:39Z
> Messages: 2

---

## User

should authenticated users get a different 404

---

## Assistant

Yes—**but only if it serves a clear purpose.**

**Short answer:**  
Authenticated users should get a *context-aware* 404, not a fundamentally different one.

**Best practice (facts, not vibes):**
- **Same HTTP status (404)** for everyone. Don’t change semantics.
- **Different UX copy/actions** based on auth state.

**Why this works:**
- **Security:** Avoid leaking existence of resources. Same status prevents user or object enumeration.
- **SEO & caching:** Consistent status codes keep crawlers and CDNs sane.
- **Usability:** Authenticated users have different next-best actions.

**What should differ for authenticated users:**
- Clear paths back to **dashboard / last workspace**
- Links to **resources they actually have access to**
- Messaging like: *“This page doesn’t exist or you don’t have access.”*
- Optional: show **recent items**, **search**, or **support link**

**What should NOT differ:**
- Status code (still 404, not 403 unless you are certain the resource exists)
- Error semantics
- URL structure hints

**Rule of thumb:**
- If you *know* the resource exists but access is forbidden → **403**
- If you’re unsure or want to avoid leakage → **404 for everyone**, better UX for logged-in users

If you want, I can give you a decision matrix or sample copy for both states.


## See Also
- [[chatgpt/chatgpt_add-ffmi-to-user]]
- [[chatgpt/chatgpt_authed-user-404-handling]]
- [[chatgpt/chatgpt_check-user-fields-redirect-part1]]
- [[chatgpt/chatgpt_check-user-fields-redirect-part2]]
- [[chatgpt/chatgpt_clerk-supabase-user-profile-part1]]
