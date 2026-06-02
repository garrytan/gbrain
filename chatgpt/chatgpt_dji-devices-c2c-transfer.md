---
conversation_id: 68c47e4f-2428-8321-9056-2d7f892dc8a2
created: 2025-09-12
links:
- '[[chatgpt-clusters/jovie_music_industry]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
title: DJI devices C2C transfer
type: note
updated: 2025-09-12
---

# DJI devices C2C transfer

**Related:** [[jovie_music]]

> Conversation ID: 68c47e4f-2428-8321-9056-2d7f892dc8a2
> Created: 2025-09-12T20:11:14Z
> Updated: 2025-09-12T20:12:55Z
> Messages: 6

---

## User

Any dji devices support c2c transfer 

---

## Assistant

Mr. White — depends what you mean by “C2C transfer.” If you mean *drone → phone* direct transfer (wireless) or *controller → phone*, then yes — DJI supports that in many of its newer devices via their **QuickTransfer** and **FlyShare** functions. citeturn0search1turn0search2turn0search4

Here are specifics:

---

### ✅ Devices that *do* support those transfers

**QuickTransfer** works on these drones:  
- Mavic 4 Pro citeturn0search2turn0search4  
- Flip citeturn0search2  
- Air 3S citeturn0search2  
- Neo citeturn0search2turn0search4  
- Avata 2 citeturn0search2turn0search4  
- Mini 4 Pro citeturn0search2turn0search4  
- Air 3 citeturn0search2turn0search4  
- Mavic 3 Pro, Mavic 3 Classic, Mavic 3 citeturn0search2turn0search4  
- Mini 3 Pro, Mini 3, Mini 2 citeturn0search2turn0search4  

**FlyShare** works on these controllers + drones:  
- DJI RC Pro 2 / RC 2 / RC, used with drones like Mini 4 Pro, Air 3, Air 3S, Mavic 3 series, etc. citeturn0search1  

---

### ⚠️ Caveats & limitations

- FlyShare only works from the *controller* to the phone — not always from drone directly. citeturn0search1turn0search4  
- Some videos in newer codecs (e.g. H.265) may need a computer to transfer/export. citeturn0search4  
- Firmware/app versions matter. Controllers and drones must be up-to-date. citeturn0search1  

---

If you tell me which model you have (drone + controller), I can confirm whether *that one* supports C2C transfer.

---

## User

Frame.io

---

## Assistant

Mr. White — I couldn’t find evidence that DJI cameras / drones have native support for **Frame.io Camera-to-Cloud (C2C)**.  

Here’s what I found:

- Frame.io defines C2C as a certified workflow where cameras or devices upload media directly to Frame.io as it’s captured (or immediately after stop). citeturn0search1turn0search3turn0search10turn1search0  
- DJI’s Osmo Mobile line is supported *via Filmic Pro* using the Frame.io integration, meaning that when using that app (on a phone stabilized by DJI hardware), you can upload to Frame.io. But that’s through the phone/app, not the camera or gimbal doing C2C natively. citeturn1search1  
- Hardware manufacturers explicitly listed by Frame.io as C2C partners include RED, Canon, Fujifilm, Atomos, Teradek, Sound Devices, etc. DJI is *not* listed among those as having C2C-certified devices. citeturn0search10turn1search0turn1search12  

---

If you want, I can check specific DJI models (Pocket, Air, etc.) to see whether there are third-party hacks or firmware that enable C2C, but officially, the answer is: **no DJI device (that I saw) has built-in C2C support**.

---

## User

Teradeck can?

---

## Assistant

Yes — Teradek **does** support Frame.io’s Camera-to-Cloud (C2C) workflow. citeturn0search1

Here are the details:

---

### 🔍 What Teradek devices support C2C

- **Cube 655** encoder citeturn0search1turn0search3  
- **Bond 657** encoder citeturn0search1turn0search3  

These encoders can create color-accurate H.264 proxy files from camera feeds (including SDI) and upload those directly to Frame.io using LTE, 5G, Ethernet, or WiFi. citeturn0search1turn0search0turn0search3

---

### ⚠️ Limitations / Non-compatible Teradek gear

- Teradek 700-series devices like **Cube 705 / 755**, **Bond 757 / 759 Backpack**, **Slice 756** are *not* compatible with Frame.io C2C. citeturn0search5  
- You’ll need a camera that supports passing metadata (timecode, filename etc.) via SDI or a compatible upstream setup. citeturn0search1turn0search3

---

If you tell me what camera(s) or Teradek gear you have, I can check whether *your setup* can do Frame.io C2C.


**Topic:** [[chatgpt-clusters/jovie_music]]
