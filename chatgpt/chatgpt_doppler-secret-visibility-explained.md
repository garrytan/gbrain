---
title: "Doppler Secret Visibility Explained"
type: note
created: 2025-12-24
updated: 2025-12-24
source: chatgpt-export
conversation_id: 694b3d21-3df8-8332-906d-5de287c4502d
message_count: 2
tags: [chatgpt, import]
---
# Doppler Secret Visibility Explained

> Conversation ID: 694b3d21-3df8-8332-906d-5de287c4502d
> Created: 2025-12-24T01:08:50Z
> Updated: 2025-12-24T01:09:36Z
> Messages: 2

---

## User

Yo dawg, if we use Doppler for our secrets, do we have to enable sensitive secrets on first of all? Does it not matter?

---

## Assistant

Mr. White — you don’t *have* to “enable sensitive secrets” for Doppler to work.

In Doppler, what you’re probably thinking of is **Secret Visibility** (Unmasked / Masked / Restricted). It doesn’t change whether Doppler secures/encrypts the value; it changes **who can see it in the dashboard** and **which token types can retrieve it**. citeturn1view0

- **Masked**: value is hidden in the UI until a user clicks to reveal; still retrievable by tokens. citeturn1view0  
- **Restricted**: **never viewable again in the dashboard after save**, and **only retrievable via non-user tokens** (e.g., service token). If you mark secrets “restricted,” your apps/CI must use service tokens/service accounts to fetch them. citeturn1view0

If your context is **GitHub Actions**:
- If you use the **Doppler → GitHub Secrets Sync**, the secrets become native GitHub secrets and get **automatic log masking**. citeturn2view0  
- If you use **`doppler run`**, you’re responsible for making sure nothing prints secrets; GitHub recommends masking anything sensitive that isn’t already a GitHub secret (via `::add-mask::`). citeturn2view0turn0search3

So: **it only “matters” if you want to prevent humans from ever viewing certain values in Doppler’s UI and/or restrict retrieval to service tokens**. Otherwise, leave them Masked and focus on least-privilege access + log masking.


## See Also
- [[chatgpt/chatgpt_doppler-effect-explained]]
- [[chatgpt/chatgpt_bartenders-as-secret-service]]
- [[chatgpt/chatgpt_cinematic-victoria-secret-ad]]
- [[chatgpt/chatgpt_generate-shared-secret-revenuecat]]
- [[chatgpt/chatgpt_santas-secret-la-event]]
