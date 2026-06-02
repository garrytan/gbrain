---
title: "Messenger Ad Set Error"
type: note
created: 2024-06-21
updated: 2024-06-21
source: chatgpt-export
conversation_id: 841227b6-9b16-4cba-82fb-42f5d1ea6405
message_count: 2
tags: [chatgpt, import]
---
# Messenger Ad Set Error

**Related:** [[coding_troubleshoot]]

> Conversation ID: 841227b6-9b16-4cba-82fb-42f5d1ea6405
> Created: 2024-06-21T18:55:14Z
> Updated: 2024-06-21T18:55:25Z
> Messages: 2

---

## User

{'asset_pointer': 'file-service://file-yUGdIwrHc62MYjDe7Kq57McS', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 98785, 'width': 708}

---

## Assistant

The error message indicates that your ad set is configured with a Messenger destination type, but the ad itself is not a Messenger ad. To fix this issue, you need to either change the destination type of the ad set or create a Messenger-specific ad.

Here are the steps to resolve this:

1. **Change the Destination Type of the Ad Set:**
   - Go to the "Ad Set" level.
   - Find the option where you can set the destination type.
   - Change it from "Messenger" to a different destination that matches your ad type, such as "Website" or "App".

2. **Create a Messenger Ad:**
   - Go to the "Ad" level.
   - Ensure that your ad format and content are suitable for a Messenger ad.
   - Follow the guidelines for creating Messenger ads, which typically involve specific call-to-action buttons and creative formats designed for Messenger interaction.

After making these adjustments, you should be able to proceed without errors.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
