---
title: "UI/UX upgrades for GLP-1"
type: note
created: 2025-11-24
updated: 2025-11-24
source: chatgpt-export
conversation_id: 6923ad21-87f8-832d-8c0d-4c7468fa8890
message_count: 2
tags: [chatgpt, import]
---
# UI/UX upgrades for GLP-1

> Conversation ID: 6923ad21-87f8-832d-8c0d-4c7468fa8890
> Created: 2025-11-24T00:56:20Z
> Updated: 2025-11-24T00:57:17Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_00000000d210720c9b9f6460b75f52fb', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 108965, 'width': 708}
{'asset_pointer': 'sediment://file_00000000fd08720c93700d0b2a6a7e17', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 93565, 'width': 708}
How do we improve this 

---

## Assistant

Mr. White, here are concrete UI/UX upgrades for this GLP-1 chooser, based on what’s on screen:

**1) Make the list scannable**
- **Group by type/indication** with headers, e.g.  
  **Newest / most common** (Wegovy, Zepbound, Ozempic, Mounjaro)  
  **Other branded GLP-1s** (Trulicity, Saxenda, Victoza…)  
  **Oral** (Rybelsus)  
  **Compounded (not FDA-approved)**  
- Add subtle section dividers and tighter vertical rhythm so users can “chunk” options.

**2) Add search + quick filters**
- A search bar at top (“Search brand or generic”).  
- Filter chips: **Weight loss**, **Diabetes**, **Injectable**, **Oral**, **Weekly**, **Daily**.  
This reduces scroll and wrong picks.

**3) Clarify what matters clinically**
Each row should show the key decision info in a consistent pattern:
- **Brand name (big)**  
- **Generic (small)**  
- **Use case tag(s)**: *Weight loss*, *T2D*  
- **Route + frequency**: *Injection • weekly* / *Oral • daily*  
Optional: pen vs vial icon.  
Right now “liraglutide/semaglutide/tirzepatide” + frequency is good, but use-case is missing.

**4) Show selection state + explicit CTA**
- Tap row → **checkmark + highlight**.  
- Sticky bottom bar: **“Save medication”** (primary) and **“Cancel”** (secondary).  
Avoid auto-save on tap; your current error suggests save is happening implicitly and failing.

**5) Fix error handling**
- Replace the red toast with a clearer, recoverable message:
  - “Couldn’t save. Check connection and try again.”  
  - Buttons: **Try again** / **Discard**.  
- Keep it inside the sheet and above safe area so it doesn’t feel detached.

**6) Handle compounded meds safely**
- Put them in their own section at bottom with a short warning line:  
  “Compounded versions aren’t FDA-approved; quality may vary.”  
- Require a confirmation tap if selected. This reduces liability and misclicks.

**7) Improve hierarchy/spacing**
- The sheet header area is crowded by the big Cancel pill. Make Cancel a simple text button or an “x” in the corner.  
- Add a short helper line under title: “Select the medication you’re currently using.”

**8) Small polish**
- Ensure scroll indicator is within the modal bounds.  
- Increase contrast a bit on secondary text for dark mode accessibility.  
- Consider adding tiny brand icons for top meds to speed recognition.

If you want, I can sketch a revised layout description (or a quick Figma-style spec) following those points.
