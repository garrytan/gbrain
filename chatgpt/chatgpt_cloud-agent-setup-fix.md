---
title: "Cloud agent setup fix"
type: note
created: 2025-12-20
updated: 2025-12-20
source: chatgpt-export
conversation_id: 694726cd-bab0-8329-944f-41c6f82efc7f
message_count: 4
tags: [chatgpt, import]
---
# Cloud agent setup fix

> Conversation ID: 694726cd-bab0-8329-944f-41c6f82efc7f
> Created: 2025-12-20T22:45:38Z
> Updated: 2025-12-20T22:57:50Z
> Messages: 4

---

## User

{'asset_pointer': 'sediment://file_00000000964071f8a60fbc04b3ebfdd6', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 90, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 6548, 'width': 574}
{'asset_pointer': 'sediment://file_000000007c0471fd897408425455d584', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 785, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 64348, 'width': 1536}
{'asset_pointer': 'sediment://file_000000001d8871fd9a5abd976f778dab', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 323, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 23276, 'width': 619}
Cloud agent setup is not working on my Mac in cursor. I need guidance on resolving based on their support forums and stuff.

---

## Assistant

Mr. White — your screenshot error:

> `Failed to connect to the remote extension host server (Error: [internal] Pod exists but exec-daemon is unreachable after 8 retries)`

matches a **known Cursor Cloud Agent infrastructure issue** (pod gets created, but the daemon inside isn’t reachable). Cursor staff have explicitly said this is **not your config** and is being investigated. citeturn1view0turn1view1

Here’s the best “do-this-now” checklist pulled from their forum guidance/workarounds:

### 1) Rule out local network/proxy interference (most common)
- **Turn off VPN/proxy entirely**, then retry. citeturn1view0turn1view1  
- In Cursor: **Settings → Network → Run Diagnostics** (and click “Show logs” if available). citeturn5search0turn6view2  
- If you’re on a corporate network (Zscaler/SSL inspection etc.), try a **phone hotspot** and/or add exceptions for Cursor domains (Cursor staff list examples like `cursor-cdn.com`, `marketplace.cursorapi.com`, `authenticate.cursor.sh`, `authenticator.cursor.sh`). citeturn6view3  

### 2) Toggle the HTTP/2 workaround (surprisingly effective for Cursor connectivity)
- Cursor Settings (`Cmd+,`) → search **HTTP/2** → enable **Disable HTTP/2** → restart Cursor. citeturn6view0turn6view1turn6view3  

### 3) Force a clean Cloud Agent environment setup
- Command Palette: **“Cursor: Start Cloud Agent Setup”** / restart the setup flow, and/or create a **new snapshot**. citeturn1view1turn6view1  
- If you have `.cursor/environment.json`, try **deleting it** and re-running setup (Cursor staff suggested this as a troubleshooting step). citeturn1view0  
- If Manual Snapshot is failing, try **Dockerfile-based setup** instead (staff suggested it can be more reliable). citeturn1view0turn1view2  

### 4) If you need to report it (to get unblocked faster)
- Copy your **Request ID** from the failing run and add it to a support ticket / forum thread; Cursor staff asked for these to pass to engineers. citeturn1view1turn1view0  
- Also grab: Network Diagnostics output + timestamp of the attempt. citeturn6view1  

### 5) Check if it’s actively degraded on their side
- Cursor staff say they have a status page: `status.cursor.com` citeturn7search0  

If you tell me whether you’re on a corporate network (Zscaler/SSL inspection) or a normal home connection, I’ll prioritize the shortest path (HTTP/2 toggle vs. network exceptions vs. just waiting for infra recovery).

---

## User

Normal home connection ive tried the http toggle

---

## Assistant

Mr. White — if you’re on a normal home connection and the HTTP/2 toggle didn’t help, this specific error is **almost always on Cursor’s side** right now:

- Cursor staff: **“Pod exists but exec-daemon is unreachable” is a confirmed Cloud Agent infrastructure issue (pod creates, daemon isn’t reachable), not your config.** citeturn1view0turn1view1

What you *can* do that’s actually useful:

### 1) Check whether it’s an active incident
- Cursor’s official status page is **status.cursor.com**. citeturn4view2

### 2) Capture the info Cursor support asks for
- Copy the **Request ID** from the failure screen/thread (Cursor staff explicitly ask for it). citeturn1view1turn1view0  
- Turn on debug logs and retry:
  - **Settings → Application → Log Level → Debug**, reproduce, then copy logs. citeturn1view1

### 3) “Force a fresh cloud session” resets (sometimes helps even when backend is flaky)
- **Sign out / sign back in**, then retry. citeturn4view0  
- **Developer: Reload Window** or fully restart Cursor. citeturn4view0  
- **Update Cursor to the latest build** and retry. citeturn4view0turn1view0  

### 4) Environment reset steps (only if you’re in the setup flow)
- If you have `.cursor/environment.json`, delete it and retry a basic setup. citeturn1view0  
- If you’re using “Manual Snapshot”, try the **Dockerfile** approach instead. citeturn1view0  

### 5) Last-resort local cache reset (only if Cursor UI is acting corrupted/stuck)
This won’t fix a dead backend daemon, but it can fix local state weirdness:
- Close Cursor → consider backing up then clearing:
  - `~/Library/Application Support/Cursor/User/workspaceStorage` citeturn6view0turn6view1

If you paste your **Request ID** (and your Cursor version from **About Cursor**), I’ll tell you which forum thread to append it to so it lands with the right engineers.
