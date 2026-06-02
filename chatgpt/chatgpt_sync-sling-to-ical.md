---
title: "Sync Sling to iCal"
type: note
created: 2025-04-30
updated: 2025-04-30
source: chatgpt-export
conversation_id: 6812979a-3070-8007-9da1-695441cafbc1
message_count: 4
tags: [chatgpt, import]
---
# Sync Sling to iCal

> Conversation ID: 6812979a-3070-8007-9da1-695441cafbc1
> Created: 2025-04-30T21:35:22Z
> Updated: 2025-04-30T21:36:04Z
> Messages: 4

---

## User

Hey fam, so Liv's work uses Sling to do their shifts. Is there a way that she can sync her shifts from Sling automatically to her iCal and then share it with me?

---

## Assistant

Yes. Sling can publish your shifts as an ICS feed that any iCal-compatible calendar can subscribe to—then she can share that calendar with you. Here’s the easiest way:

**1. Get her Sling ICS link**  
- On a desktop, Liv logs in at app.getsling.com  
- Click her avatar → **Settings** → **Calendar integrations**  
- Under “Export schedule,” copy the ICS URL  

**2. Subscribe in Apple Calendar**  
- **macOS Calendar**  
  1. File → **New Calendar Subscription…**  
  2. Paste the Sling ICS URL → **Subscribe**  
  3. Give it a name (“Liv Shifts”), set auto-refresh (e.g. every hour), click **OK**  
- **iOS Calendar**  
  1. Settings → **Calendar** → **Accounts** → **Add Account** → **Other**  
  2. **Add Subscribed Calendar** → paste ICS URL → **Next** → **Save**  

*Now Liv sees her Sling shifts in iCal automatically, and they update on whatever refresh schedule she picked.*

**3. Share that calendar with you**  
- On macOS Calendar, in the left sidebar under “iCloud,” find “Liv Shifts” → click the ⓘ  
- Under “Shared With,” click **Add Person…** and enter your Apple ID (the email you use for iCloud)  
- She sends the invite; you Accept in your Mail or Calendar app  

Once you’ve accepted, her shifts show up in your iCal too—always kept in sync automatically.

---

## User

Is there a way she can get the ICS link from her Sling iOS app?

---

## Assistant

No—Sling’s iOS app doesn’t expose the ICS URL. You have to grab it from the web interface. On an iPhone you can:

1. Open Safari (or your browser), go to app.getsling.com, and log in.  
2. Tap your avatar → **Settings** → **Calendar integrations**.  
3. Under **Export schedule**, copy the ICS feed URL.  

Once you’ve copied that link you can subscribe to it in iOS Calendar (Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar). citeturn0search0
