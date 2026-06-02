---
title: "iOS Automations and Shortcuts"
type: note
created: 2025-05-23
updated: 2025-05-23
source: chatgpt-export
conversation_id: 68310581-5004-8007-a24b-7ecda7189302
message_count: 4
tags: [chatgpt, import]
---
# iOS Automations and Shortcuts

> Conversation ID: 68310581-5004-8007-a24b-7ecda7189302
> Created: 2025-05-23T23:32:17Z
> Updated: 2025-05-23T23:36:36Z
> Messages: 4

---

## User

Yo dawg, based on everything you know about me, suggest shortcuts or automations that I could create using either built-in tasks on iOS or a built-in software on iOS or macOS or a custom software that I can write. That would make my life easier.

---

## Assistant

Mr. White, here are some tailored automation ideas to save you time and mental bandwidth:

- **Trader Joe’s grocery launch**  
  • iOS Shortcut: “When I arrive at Trader Joe’s,” open your “Grocery” list in Reminders (or in a dedicated grocery app).  
  • Setup: In Shortcuts → Automation → Location → choose your Trader Joe’s, then “Open App” or “Show Reminders List.”

- **Twice-weekly meal-prep reminder**  
  • iOS Automation: Every Monday at 7 PM and Thursday at 7 PM, ping you “Time to meal-prep” with your standard recipe list.  
  • Setup: Shortcuts → Automation → Time of Day → Mon/Thu → add “Show Reminder” action.

- **Car audio toggle**  
  • iOS Automation: When your iPhone connects to your Mazda’s Bluetooth, disable Bose Centerpoint (via a HomeKit switch or scriptable Shortcut) and launch your car-mixing playlist.  
  • Setup: Shortcuts → Automation → Bluetooth → select your car → add “Set Focus Off” or “Run Script” actions.

- **Show-time Focus mode**  
  • iOS Automation: 1 hour before any “America’s Secrets” call-time (W/F/Sa at 4:30 PM, W/Th/Su at 5 PM), turn on a custom “Showtime” Focus to mute distractions and open Uber.  
  • Setup: Shortcuts → Automation → Time → custom schedule → “Set Focus” + “Open App → Uber.”

- **Gym session launcher**  
  • iOS Shortcut: On tap of a “Gym” widget, start a 45-minute timer, open RP Hypertrophy app, and begin “Strength Training” playlist.  
  • Setup: Shortcuts → Widget → Add timer + “Open App” actions.

- **TikTok influencer tracker**  
  • Custom script (Python on Mac): every day at 8 AM, scrape TikTok for videos using “Never Say A Word,” append usernames+links to a CSV, then email you the summary.  
  • Setup: Write a small Python script using TikTok-scraper, schedule via cron or launchd on macOS.

- **Monthly budget sweep**  
  • iOS Shortcut: On the first of each month, pull transaction data from your finance app (via its URL scheme or a banking API), calculate surplus, then trigger a transfer to your investment account.  
  • Setup: Shortcuts → Automation → Date → first day → “Get Contents of URL” + “Run Script” + “Show Result” or “Open Banking App.”

- **Contact-poster rotator**  
  • iOS Shortcut: Daily at 9 AM, pick a random image from your “Contact Posters” album and assign it to a VIP contact (or yourself) via Contacts actions.  
  • Setup: Shortcuts → Automation → Time of Day → daily → “Find Photos” (album filter, random) → “Update Contact Photo.”

- **Car-bag restock reminder**  
  • iOS Automation: Every 2 weeks on Saturday morning, remind you to check your car bag inventory (first-aid, wipes, blanket, etc.) and auto-generate a checklist in Reminders.  
  • Setup: Shortcuts → Automation → Weekly → add “Show Reminder” with checklist template.

Each of these can be built with the native Shortcuts app, Automator/AppleScript on macOS, or a lightweight Python/Scriptable tool for more complex data pulls. Pick the ones that hit highest ROI and tweak timings to your life.

---

## User

{'asset_pointer': 'file-service://file-4oJnyx1pN23r6bTvxzdQeg', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 75550, 'width': 708}
Will this work

---

## Assistant

Mr. White, that won’t auto-run as is—you’ve built a regular Shortcut (location as an action), not a location-triggered Automation. 

To make it fire when you pull into Trader Joe’s:

1. In Shortcuts, tap **Automation** → **+** → **Create Personal Automation**.  
2. Choose **Arrive**, pick your Trader Joe’s location.  
3. In **Actions**, add **Open Reminders List** → select **Grocery List**.  
4. Turn **Off** “Ask Before Running.”  
5. Done.

Now, when you arrive, your Grocery List will open automatically.


**Topic:** [[chatgpt-clusters/coding_mobile]]
