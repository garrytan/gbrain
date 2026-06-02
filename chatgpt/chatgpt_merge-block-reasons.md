---
title: "Merge Block Reasons"
type: note
created: 2026-02-22
updated: 2026-02-22
source: chatgpt-export
conversation_id: 699b66ab-7740-8330-85c1-f547f7282b92
message_count: 2
tags: [chatgpt, import]
---
# Merge Block Reasons

> Conversation ID: 699b66ab-7740-8330-85c1-f547f7282b92
> Created: 2026-02-22T20:27:32Z
> Updated: 2026-02-22T20:27:49Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_00000000806071fda994b112f9ea22e7', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 245038, 'width': 709}
Why can’t it merge?

---

## Assistant

Mr. White, based on the screenshot:

Your PR is set to **“Queueing when ready”** but shows:

> **Cannot merge at this time**

That typically happens for one of these reasons:

### 1️⃣ Required status checks haven’t fully passed  
Even though “Checks” shows green, GitHub may still be waiting on:
- A required CI check (e.g., Vercel preview)
- A branch protection rule requirement
- A required check that hasn’t reported yet

Expand the **Checks** section and confirm:
- All required checks are listed
- Every required check says **✔ Passed**

---

### 2️⃣ Branch protection rules block direct merge  
Your `main` (or target branch) likely has:
- “Require branches to be up to date before merging”
- “Require status checks to pass”
- “Require linear history”
- “Require merge queue”

If merge queue is enabled, GitHub won’t allow manual merging — it must go through the queue.

---

### 3️⃣ The branch is not up to date  
If `main` has new commits since you opened the PR, GitHub will block merging until you:
- Rebase or merge latest `main` into your branch
- Push updated branch
- Let CI re-run

---

### 4️⃣ Merge queue is enabled  
The wording **“Queueing when ready”** strongly suggests merge queue is turned on.

In that case:
- You can’t manually merge.
- GitHub waits for all required checks.
- It will automatically merge when conditions are satisfied.

If it stays stuck:
- Click **Cancel**
- Ensure all checks are green
- Re-enable auto-merge

---

### Quick Diagnosis  
Click:
- “Checks”
- Then expand each required check
- Confirm no pending status
- Confirm branch is up to date with base

If you send the branch protection settings screenshot, I can pinpoint the exact cause.
