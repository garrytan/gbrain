---
conversation_id: 692640d0-e244-8327-bcfe-b6ef21354785
created: 2025-11-25
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Sentry for SwiftUI app
type: note
updated: 2025-11-25
---

# Sentry for SwiftUI app

**Related:** [[coding_mobile]]

> Conversation ID: 692640d0-e244-8327-bcfe-b6ef21354785
> Created: 2025-11-25T23:51:10Z
> Updated: 2025-11-25T23:51:25Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_0000000039c871f5883fbab34d5d981e', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 370, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 287428, 'width': 862}
Which option for our logyourbody app? We have swift ui

---

## Assistant

Pick **`Sentry`**, Mr. White.

For a normal iOS app using **SwiftUI**, you want the standard UIKit-enabled library:

- `Sentry` → ✅ correct choice for iOS / SwiftUI apps  
- `Sentry-WithoutUIKitOrAppKit` → for pure libs with no UI frameworks  
- `*-Dynamic` / `*-WithARM64e` → special linking/arch cases you don’t need

After picking `Sentry`, set **Add to Target** to your `logyourbody` app target and add the package.


**Topic:** [[chatgpt-clusters/coding_mobile]]


## See Also
- [[chatgpt/chatgpt_auto-assign-sentry-issues]]
- [[chatgpt/chatgpt_auto-fix-sentry-crashes]]
- [[chatgpt/chatgpt_automating-sentry-fixes]]
- [[chatgpt/chatgpt_github-sentry-bot]]
- [[chatgpt/chatgpt_ios-mvp-sentry-setup]]
