---
title: "Disney Plus Bug"
type: note
created: 2026-05-14
updated: 2026-05-14
source: chatgpt-export
conversation_id: 6a055399-1b54-83e8-a9c7-ab07e54fe95a
message_count: 3
tags: [chatgpt, import]
---
# Disney Plus Bug

> Conversation ID: 6a055399-1b54-83e8-a9c7-ab07e54fe95a
> Created: 2026-05-14T04:46:17Z
> Updated: 2026-05-14T04:48:13Z
> Messages: 3

---

## User

Weird bug on Disney plus with black shutter every 10 seconds or so

---

## Assistant

I’ll treat this as a recurring Disney+ playback flicker, likely tied to display/DRM behavior, and check current guidance before giving fast device-agnostic fixes.

---

## Assistant

Mr. White, that pattern usually points to a **video handshake problem**: HDR/Dolby Vision, frame-rate matching, HDMI/HDCP, or the Disney+ app cache. It is especially likely if **audio keeps playing while the picture briefly blacks out**.

Try this order:

1. **Force-quit Disney+**, reopen it, then test the same scene. Disney’s own troubleshooting starts with fully closing/restarting the app and power-cycling the device. citeturn713655search0turn713655search7

2. **Power-cycle the chain**: unplug TV + streaming box/console + receiver/soundbar for 60 seconds, then restart.

3. **If using Apple TV / Roku / Fire Stick / console via HDMI:**
   - Reseat both ends of the HDMI cable.
   - Try a different HDMI port, preferably HDMI 1.
   - Try a certified Premium/Ultra High Speed HDMI cable.
   - Temporarily bypass receiver/soundbar/HDMI switch and connect directly to the TV. Apple specifically recommends checking HDMI cabling, trying another HDMI port/cable, and bypassing AV receivers/switches for black-screen issues. citeturn437258search1

4. **Disable HDR/Dolby Vision as a test.**
   - Apple TV: Settings → Video and Audio → set **Format: 4K SDR**, then test Disney+.
   - Also test with **Match Dynamic Range** and **Match Frame Rate** turned off. Apple notes these settings can cause blank/flickering screens while the TV switches video formats. citeturn437258search1turn437258search10
   - Roku/Fire/TV app: set output to **1080p SDR** or disable HDR/Dolby Vision temporarily. If the black flashes stop, the issue is almost certainly HDR/HDCP/HDMI handling.

5. **Clear Disney+ cache or reinstall the app.** Disney has a specific cache/data clearing step for app issues, especially on Android-based devices. citeturn713655search5

6. **If it only happens in 4K/HDR:** treat it as an HDCP 2.2/HDMI chain issue. Roku’s HDCP guidance says every HDMI link in the chain needs appropriate Premium High Speed cabling, and a weak link can cause HDCP 2.2 failures. citeturn437258search4

Most likely fix: **turn off Dolby Vision/HDR or Match Frame Rate, then swap HDMI cable/port**.  

Tell me what device you’re watching on — Apple TV, Roku TV, Fire Stick, PS5, Xbox, smart TV app, or browser — and I’ll give the exact setting path.


## See Also
- [[chatgpt/chatgpt_disney-plus-and-hulu-comparison]]
- [[chatgpt/chatgpt_disney-plus-servers-operational]]
- [[chatgpt/chatgpt_coffee-art-plus-price]]
- [[chatgpt/chatgpt_disney-parks-sync-music]]
- [[chatgpt/chatgpt_disney-world-existed]]
