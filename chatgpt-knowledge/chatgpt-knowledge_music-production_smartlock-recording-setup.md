---
title: "SmartLock recording setup"
type: guide
created: 2025-07-31
updated: 2025-07-31
source: chatgpt-export
topic: music-production
message_count: 6
tags: [chatgpt, knowledge, music-production]
---
# SmartLock recording setup

> **Source:** ChatGPT conversation
> **Date:** 2025-07-31T18:51:16Z
> **Messages:** 6
> **Topic:** music-production

## Question

{'asset_pointer': 'file-service://file-1tb6P7ck7SX1tL6TYG1huJ', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 2335985, 'width': 1152}
{'asset_pointer': 'file-service://file-EEoEhz7HAweqHv97M9g21s', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': 

## Answer

Mr. White, based on your images, you have a **Schlage BE469** smart lock (specifically BE469NX or BE469ZP depending on the communication protocol—Z-Wave or Zigbee).

### Regarding "recording on it":
If you're asking how to **record activity** (like entries, code uses, etc.), here's what you need to know:

---

### 🔍 What This Lock Can Do:
The **BE469** does **not have a microphone or camera** — so it cannot record audio or video. However, it can:

- Log **user code entries** (who unlocked the door and when).
- Be connected to a **smart home hub** (like Samsung SmartThings, Alarm.com, Ring Alarm, etc.) that can **log events and notify you.**

---

### 📲 How to Enable Logging / Notifications:
You need a **compatible smart home hub**:

#### Option 1: **SmartThings (Z-Wave model)**
1. Pair the lock via SmartThings app.
2. Go to Devices → Your Lock → History.
3. It will log user code usage (e.g., “User Code 1 unlocked the door”).

#### Option 2: **Ring Alarm (Z-Wave)**
1. Add lock to Ring app via “Set up a device” > “Locks”.
2. Once connected, Ring will track all lock/unlock events.

#### Option 3: **Alarm.com (typically via security company)**
- Offers full logging and integration into security workflows.

---

### ⚠️ If you want **video/audio recording**, you'd need:
- A separate **camera or video doorbell** (e.g., Ring or Nest).
- Then link that to your smart home system to correlate footage with lock events.

---

If you're trying to **reset or program codes**, let me know — I see your programming code (573502) in the image and can walk you through it.

## Question

It doesn't have a QR code to scan for the Ring app. It's a Z-Wave device. So I either need to reprogram the code... ...or I need to remove it from... ...or I need to be able to add it to the Ring app.

## Answer

Thanks for the clarification, Mr. White. Since your Schlage BE469 is a **Z-Wave** model and doesn’t have a QR code, here’s exactly how to either **reprogram it** or **add it to the Ring app** (even without the QR):

---

### ✅ Option 1: Add to Ring App (Z-Wave, No QR Code)

1. **Factory Reset (optional but recommended):**
   - Disconnect the battery.
   - Press and hold the **Schlage button** (the top button on the keypad).
   - While holding the Schlage button, reconnect the battery.
   - Keep holding until the lock beeps and the light flashes green (~10 seconds).
   - It’s now reset.

2. **Put Ring into Inclusion Mode:**
   - Open **Ring app** → Tap menu (☰) → “**Devices**”
   - Tap “**Set Up a Device**” → “**Locks**” → Choose Schlage → “**Works With Ring**”
   - Choose your base station (Ring Alarm required).
   - Tap **“Add Manually”** → Select **Z-Wave**.
   - It’ll now search for Z-Wave devices.

3. **Put Lock into Pairing Mode:**
   - Enter your **6-digit programming code** on the keypad (you have: `573502`).
   - Press `0`.
   - The lock should enter inclusion mode and pair with Ring.
   - Ring app will confirm when it’s added.

---

### 🛠️ Option 2: Reprogram/Add User Code Without App

1. Enter the **programming code** on the keypad: `573502`
2. Press `1` (to add a new code)
3. Enter your new **4–8 digit access code**
4. Re-enter the new code to confirm

You’ll get a green checkmark or long beep to confirm success.

---

### 🧼 Option 3: Remove from a Previous Network

If Ring says it **can’t add the device**, it might still be paired to an old network.

To **exclude** it (Ring can do this even if it wasn’t the original controller):

1. Open Ring App → Devices → Base Station → Z-Wave Settings → “Remove Z-Wave Device”
2. On the lock, enter the **programming code**, then press `0`
3. Ring will confirm that it was successfully excluded
4. Now go back and **add the lock again** using steps above

---

Let me know which path you're going with, and I’ll walk you through the next step.

## Question

Remove user code

## Answer

To **remove a user code** from your Schlage BE469, use this exact sequence on the keypad:

---

### 🔒 Remove User Code A (e.g., 9731)
1. Enter your 6-digit **programming code**: `573502`  
2. Press `2`  
3. Enter the **4-digit code to delete** (e.g., `9731`)  
4. Re-enter the same 4-digit code to confirm  

---

### ✅ Success indicators:
- Green checkmark light or a long beep = removed  
- Red X or short beep = failure (usually means the code doesn’t exist)

Let me know if you want to wipe **all user codes** or reassign new ones.
