---
title: "KDS menu issue troubleshooting"
type: note
created: 2025-09-26
updated: 2025-09-26
source: chatgpt-export
conversation_id: 68d5eba8-cc30-832d-b631-c72533192d1f
message_count: 4
tags: [chatgpt, import]
---
# KDS menu issue troubleshooting

**Related:** [[coding_troubleshoot]]

> Conversation ID: 68d5eba8-cc30-832d-b631-c72533192d1f
> Created: 2025-09-26T01:26:40Z
> Updated: 2025-09-26T01:29:17Z
> Messages: 4

---

## User

Did Toast recently change our KDS systems work? Because I'm logged into our systems and I'm not seeing the KDS option anywhere in our menus. And I just logged in with our KDS login on the KDS, which auto-opened the KDS app. And then when I went to one of the main menus, I saw that there was no KDS app listed like there used to be. And now I can't get the KDS app back up, even on the KDS login.

---

## Assistant

Mr. White — yes, it’s possible something changed (software update, permissions, or settings), but I can’t confirm for sure from public sources that Toast *globally removed* the KDS menu.

Here are steps & diagnostics you can run to isolate and hopefully restore access:

---

### Possible causes & checks

1. **Permissions changed / module disabled**  
   - The KDS functionality in Toast is controlled via permissions and feature toggles. citeturn0search0turn0search3turn0search7  
   - If your role/account no longer has the “Kitchen / Dining Room Setup” or “Device Setup” access permission, the KDS option might vanish from your menus. citeturn0search3turn0search0turn0search13  

2. **KDS mode not enabled on that terminal / device**  
   - Even on a KDS login, if that device is not configured as a KDS (or KDS mode is disabled), the menu option might not appear. citeturn0search8turn0search13turn0search1turn0search0  
   - There is an overflow menu (“⋮”) on KDS devices that lets you access Device Setup, switch view, etc. citeturn0search8  

3. **Software update / change**  
   - It’s possible Toast pushed an update or restructured menus, moving where the KDS option is shown or hiding it by default. I didn’t find a public Toast note confirming a removal of the menu item, but their documentation suggests KDS is still part of their system. citeturn0search1turn0search8turn0search3  
   - If app data was cleared or the Toast KDS app was reinstalled, it might reset configurations (grid view settings, etc.). citeturn0search8  

4. **KDS configuration turned off at the site level**  
   - In the Toast Web admin (Kitchen > Printers, tickets & KDS > Kitchen and ticket setup), KDS might have been disabled or its display options changed. citeturn0search7turn0search3turn0search0turn0search5  
   - If KDS is disabled or printers/ticket routing was changed, orders might default to printing rather than showing on KDS. citeturn0search7turn0search3  

---

### What to try next (troubleshooting)

- Log into the **admin / web dashboard** and check **Kitchen / Dining Room Setup** or **Device Setup** to see if the KDS module is still enabled.
- On your POS / KDS device:
  - Tap the overflow menu (⋮) and look for “Device Setup,” “Switch to KDS / Kitchen Display,” or “Change Mode.”
  - If the app was reset, reconfigure the device as a KDS device.
- Verify that your user account has proper permissions for KDS / kitchen-setup roles.
- Reach out to your internal POS admin or to Toast support to confirm whether they pushed a change or update at your location.

If you like, I can try to see if there’s a recent Toast release note or conference update that mentions removal or alteration of KDS menus at your account level. Do you want me to dig that?

---

## User

Yeah, I want you to dig for a recent change log, release note, or something about KDS. I mean, we've been dark since December 31st, so we haven't used our Toast system since then. But I've turned on all of our hardware across the venue, and it's all operating just fine. It's just that KDS menu that seems to be giving me issues.

---

## Assistant

Got it, Mr. White. Here’s what’s changed—and what to check—based on Toast’s latest KDS notes.

# What changed recently (official)
- **Release notes moved**: Toast now publishes product updates at updates.toasttab.com (since POS v2.88). citeturn0search6  
- **Sep 23, 2025**: KDS ticket size behavior unified for Grid + All-Day views (POS v2.93). citeturn0search2  
- **Aug 2025**: Multiple KDS fixes/enhancements for Grid View and Expediter flows (POS v2.86–2.90). citeturn0search7turn1search15  
- **Docs updated Sep 9–11, 2025**: Grid View overview + how to switch to KDS mode live in Toast Central. citeturn1search2turn1search1

Nothing in these notes says Toast removed the **KDS app** entirely—KDS is still a **mode** you switch to on a Toast device (not a separate “app” tile in some menus). citeturn1search4

# Likely cause of what you’re seeing
After a long downtime (since Dec 31), devices often need **Device Setup** and the **KDS mode** re-selected, and your user must have the **Kitchen/Dining Room Setup** permission—otherwise the KDS option won’t appear. citeturn1search19turn0search10

# Fast restore checklist (onsite)
1. **Power cycle** the KDS screen → log into Toast → tap the **⋮** (top right) on the passcode screen. citeturn1search0  
2. From the POS home screen: **Mode → Kitchen Display System**. If missing, open **⋮ → Device Setup** and re-assign this device as a KDS. citeturn1search4  
3. In **Toast Web**: **Kitchen → Printers, tickets & KDS devices → Kitchen and ticket setup**. Confirm **Ticket Screens / KDS** are enabled and routing is correct. Requires **Web Setup 6.2** permission. citeturn0search10  
4. If using **Grid View**, set ticket size (affects Grid + All-Day after the Sep update). citeturn0search2  
5. If tickets aren’t appearing, run the Toast Central KDS troubleshooting steps (common fixes + “No Print”/prep-station misroutes). citeturn0search3

If you want, I can walk you through which permission set your **KDS login** needs and a minimal routing config to get a screen live in under 5 minutes.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]


## See Also
- [[chatgpt/chatgpt_qnap-issue-troubleshooting]]
- [[chatgpt/chatgpt_ac-crackling-troubleshooting]]
- [[chatgpt/chatgpt_ac-not-working-troubleshooting]]
- [[chatgpt/chatgpt_accessing-faq-content-issue]]
- [[chatgpt/chatgpt_adjust-off-screen-menu]]
