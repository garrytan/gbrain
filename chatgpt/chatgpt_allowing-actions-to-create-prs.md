---
title: "Allowing actions to create PRs"
type: note
created: 2025-09-01
updated: 2025-09-01
source: chatgpt-export
conversation_id: 68b4edc6-9cc4-8321-8031-9a8e317beb54
message_count: 4
tags: [chatgpt, import]
---
# Allowing actions to create PRs

> Conversation ID: 68b4edc6-9cc4-8321-8031-9a8e317beb54
> Created: 2025-09-01T00:50:35Z
> Updated: 2025-09-01T00:51:12Z
> Messages: 4

---

## User

{'asset_pointer': 'file-service://file-YHrsxSS2iRkb1RPD8Ymgcd', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 241, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 100192, 'width': 909}
Why cant i allow actions to create prs

---

## Assistant

You can’t enable **“Allow GitHub Actions to create and approve pull requests”** because you currently have repository-level workflow permissions set to **Read repository contents and packages permissions**.  

That checkbox only unlocks if you give Actions **write access**. In other words:  

1. Go to **Repository → Settings → Actions → General → Workflow permissions**.  
2. Switch from **Read repository contents and packages permissions** to **Read and write permissions**.  
3. Once that is selected, the checkbox for **Allow GitHub Actions to create and approve pull requests** becomes available.  

👉 Right now your workflows only have read access, so they can’t push commits or open PRs. That’s why it’s grayed out.  

Do you want me to walk you through the exact steps to safely grant write access without opening up too much risk?

---

## User

{'asset_pointer': 'file-service://file-7FQ4Q7SjP9AB1wYFB89Noa', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 368, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 254410, 'width': 968}

---

## Assistant

Got it — I see what’s happening.  

The **“Read and write permissions”** option is greyed out, which is why you can’t enable Actions to create PRs. That’s not normal for a standard repo setting — it usually means one of these is true:  

1. **Org-level policy is locking it down**  
   – If this repo belongs to an organization, the org admin may have restricted workflow permissions globally. In that case, you won’t be able to toggle it unless the org owner changes the org-wide Actions settings.  

2. **Enterprise policy enforcement**  
   – If your org is part of a GitHub Enterprise account, enterprise admins can enforce “read-only” tokens across all repos.  

3. **Repo doesn’t allow write perms for GITHUB_TOKEN**  
   – Some forks or special repos default to read-only to prevent workflows from pushing back changes.  

---

✅ To fix:  
- If you own the org: go to **Organization Settings → Actions → General → Workflow permissions**, and enable **Read and write permissions** there.  
- If you’re on Enterprise: you’ll need an enterprise admin to allow it.  
- If it’s just your personal repo: this option should not be greyed out — check if the repo is a fork, or if Actions are restricted under **Actions → General → Policies**.  

---

Do you want me to give you the exact navigation steps for both **org-level** and **enterprise-level** fixes so you can check which one applies to your repo?


## See Also
- [[chatgpt/chatgpt_create-account-page-setup-part1]]
- [[chatgpt/chatgpt_create-account-page-setup-part2]]
- [[chatgpt/chatgpt_create-anime-characters]]
- [[chatgpt/chatgpt_create-body-recomp-spreadsheet]]
- [[chatgpt/chatgpt_create-calendar-event]]
