---
title: "Black Screen YouTube Fix"
type: note
created: 2026-02-15
updated: 2026-02-15
source: chatgpt-export
conversation_id: 699251d1-c4d0-8326-9955-6de2487d6e14
message_count: 4
tags: [chatgpt, import, long-form]
---
# Black Screen YouTube Fix

**Related:** [[coding_troubleshoot]]

> Conversation ID: 699251d1-c4d0-8326-9955-6de2487d6e14
> Created: 2026-02-15T23:08:25Z
> Updated: 2026-02-15T23:10:16Z
> Messages: 4

---

## User

Yo, homie, I got this TV that's using YouTube Live, and anytime I put on any programming, all the menus and thumbnails show up fine, and then when I put on an actual programming, it just shows a black screen with the controls on it, and it shows that it's playing and the time changes, but there's no content on the screen.

---

## Assistant

Alright Mr. White — black video **with the player controls/time moving** usually means the TV/app is playing *something*, but the **video layer isn’t rendering** (or it’s being blocked by a display/codec/HDCP issue). Here’s the fastest way to isolate and fix it.

## 1) Quick “is it only Live?” checks (1 minute)
- Try **regular YouTube (non-Live)** video.
- Try a **different live channel**.
- If **only Live** is black → likely a **YouTube app bug / stream format issue** on that TV model.
- If **everything** is black → more general video rendering problem.

## 2) Power-cycle the right way (fixes a ton of these)
1. **Unplug the TV from power** (not just remote off).
2. Wait **60 seconds**.
3. Plug back in and open YouTube again.

If you’re using an external streaming box/stick, do the same to that device too.

## 3) Toggle video/display settings that commonly cause “black video”
On the TV (or external device):
- **Disable HDR** temporarily (or set “HDR: Off / Always Off”).
- Change output to **1080p** (instead of 4K/Auto).
- If there’s a “Match frame rate” or “Film mode” type setting, turn it **off**.
- If it’s an HDMI device: try a **different HDMI port** and/or **different HDMI cable** (HDCP handshake glitches can produce black video with UI still visible).

## 4) Clear cache / data and update the app
Depending on TV brand:
- Go to **Settings → Apps → YouTube (or YouTube TV/YouTube Live)**
  - **Force stop**
  - **Clear cache**
  - If still broken: **Clear data** (you’ll sign in again)
- Then check for:
  - **YouTube app update**
  - **TV firmware/system update**

## 5) Network sanity check (less likely, but quick)
- Test on **another network** (phone hotspot) if possible.
- If hotspot works and home Wi-Fi doesn’t:
  - Reboot router/modem
  - Disable any router “ad blocking / DNS filtering”
  - Try DNS **8.8.8.8** or **1.1.1.1**

## 6) If it’s a casting / AirPlay situation
- If you’re casting from a phone: stop casting, **reboot phone + TV**, then recast.
- Try casting to a **different receiver** (Roku/Chromecast) to confirm the TV app is the issue.

## The 3 questions that let me give the exact fix
1) What TV brand/model (Samsung/LG/Sony/Hisense/TCL/etc.) and about how old?  
2) Are you watching via the **built-in YouTube app**, **YouTube TV**, or an **external device** (Roku/Fire TV/Apple TV/Chromecast)?  
3) Does **regular YouTube (non-Live)** play video normally?

Answer those and I’ll tell you the most likely root cause + the shortest path to the fix for your exact setup.

---

## User

On pre-recorded live content, when you scrub, the scrub thumbnail shows content, but the actual screen is black.

---

## Assistant

Got it, Mr. White — that detail is super diagnostic.

If the **scrub preview thumbnails show the video**, but the **main playback stays black** while time/controls move, then the stream is decoding *somewhere* (the app can fetch frames for previews), but the **actual playback video plane isn’t rendering**. On TVs this is usually one of:

- **HDR / color format mismatch** (app outputs a mode your TV/video pipeline glitches on)
- **Hardware decoder bug** (specific codec/profile for that “live DVR” content)
- **Overlay/video plane conflict** (menus render, video plane black)
- **HDMI/HDCP** if you’re on an external box (less likely if UI is fine, but still possible)

Here’s the tightest fix path:

## 1) Force SDR / kill HDR (most common)
**If you’re using an external device (Apple TV / Roku / Fire TV / Chromecast):**
- Set video output to **1080p SDR** (not 4K, not HDR, not “Match range”).
  - Apple TV: Settings → Video and Audio → Format → **1080p SDR**; turn **Match Dynamic Range OFF** (temporarily).
  - Fire TV: Settings → Display & Sounds → Display → **Dynamic Range: SDR** (or disable HDR), Resolution **1080p**.
  - Roku: Settings → Display type → **1080p TV** (or “Auto (1080p)”).
  - Chromecast/Google TV: Settings → Display & Sound → Dynamic range & color format → disable HDR / set SDR; Resolution **1080p**.

**If it’s the built-in TV app:**
- Turn off TV picture features that trigger HDR pipelines:
  - “HDMI UHD Color / Deep Color” (LG/Samsung naming varies) **OFF** (if relevant)
  - Any **HDR+ / Dynamic Tone Mapping**: OFF
- Also try switching picture mode to something basic (Standard) and disable “motion smoothing” just for the test.

## 2) Cold reboot (not standby)
- Unplug TV power for **60 seconds**, plug back in.

## 3) Clear YouTube (or YouTube TV) app cache/data
- Settings → Apps → YouTube / YouTube TV → **Force stop**
- **Clear cache**
- If still black: **Clear data** (you’ll sign in again)

## 4) Update firmware + app
- Update **TV OS/firmware**
- Update the **YouTube app**
(Decoder bugs often get fixed in either place.)

## 5) If external device: HDMI sanity
- Try **different HDMI port**
- Try a **different cable**
- If your TV has “Enhanced/4K” mode per HDMI input, temporarily set that input to **Standard** (forces simpler signaling)

## 6) Quick isolation test
Try **the same content** on:
- Your phone/tablet (same account)
- Another app/device on the same TV (e.g., Netflix)
If other apps show video fine, it’s almost certainly **YouTube app + HDR/codec path** on that TV/device.

---

### Tell me which setup you’re on and I’ll give the exact menu clicks
1) Is this the **built-in TV YouTube/YouTube TV app**, or a **Roku/Fire/Apple TV/Chromecast**?  
2) TV brand/model?

With those two, I can point you to the precise HDR/SDR toggle that fixes this on your hardware.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]


## See Also
- [[chatgpt/chatgpt_adjust-off-screen-menu]]
- [[chatgpt/chatgpt_app-automation-for-youtube]]
- [[chatgpt/chatgpt_automate-youtube-shorts-urls]]
- [[chatgpt/chatgpt_automating-screen-clicks]]
- [[chatgpt/chatgpt_black-backslash-logo]]
