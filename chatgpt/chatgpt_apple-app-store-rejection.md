---
conversation_id: 699f534f-6aa0-8332-93e6-18ac289fdd55
created: 2026-02-25
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
title: Apple App Store Rejection
type: note
updated: 2026-02-25
---

# Apple App Store Rejection

> Conversation ID: 699f534f-6aa0-8332-93e6-18ac289fdd55
> Created: 2026-02-25T19:53:57Z
> Updated: 2026-02-25T19:54:18Z
> Messages: 4

---

## User

{'asset_pointer': 'sediment://file_00000000b398720cbf192fe7a4ff8431', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 280604, 'width': 709}

---

## Assistant

Apple rejected it because the paywall does not clearly disclose that the free trial converts into a paid auto-renewing subscription.

Issues visible in the UI:

1. **No trial length stated**  
   It says “Free trial” but does not specify duration (e.g., 7 days).

2. **Automatic billing timing unclear**  
   It does not explicitly state that the user will be charged immediately after the trial ends unless canceled.

3. **Button labeling is insufficient**  
   “Start Free Trial” does not communicate that payment will begin automatically after the trial.

4. **Price presentation is ambiguous**  
   “$9.99 year” and “$0.83/mo” appear together without explicitly stating the total charged after trial.

Apple’s App Store Review Guideline 3.1.2 requires:
- Trial duration
- Exact price after trial
- Billing frequency
- Explicit statement that subscription auto-renews unless canceled

To comply, the screen must clearly state something like:

“7-day free trial. Then $9.99/year, billed annually. Subscription automatically renews unless canceled at least 24 hours before the end of the trial.”

The current design relies on inference. Apple requires explicit disclosure.

---

## User

Make a concise comment

---

## Assistant

Apple is correct. The paywall does not state the trial length or clearly disclose that billing begins automatically after the trial at $9.99/year (or $1.99/month). “Start Free Trial” without explicit post-trial pricing and renewal language fails guideline 3.1.2.
