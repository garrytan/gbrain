---
title: "Hide tips on Toast"
type: note
created: 2025-10-28
updated: 2025-10-28
source: chatgpt-export
conversation_id: 6900f607-2d98-832a-b87c-2e02d6fabfec
message_count: 2
tags: [chatgpt, import]
---
# Hide tips on Toast

> Conversation ID: 6900f607-2d98-832a-b87c-2e02d6fabfec
> Created: 2025-10-28T16:57:57Z
> Updated: 2025-10-28T16:59:24Z
> Messages: 2

---

## User

How do I stop my servers from seeing the tips for the night on toast?

---

## Assistant

Mr. White — short version: hide the Z-report/Sales Summary from servers and strip tip sections from Shift Review.

**Do this:**
1) **Pull “Z report / Sales Summary” from server roles.**  
   In Toast Web: Employees → Employee management → **Jobs** → (Server) → uncheck:  
   - **Close Out Day** (shows the Z-report sales summary). citeturn8view0  
   - **Sales Reports** (lets users open Reports > Sales on POS and Web, and enables “Full Sales Report” from Z-report). citeturn8view0

2) **Remove the “My Account > Sales Report” shortcut.**  
   In the same role, uncheck **My Reports** (it gives access to *My Account > Sales Report* on the POS). citeturn8view1

3) **Strip tips from the Shift Review screen.**  
   Toast Web: Employees → **POS report configurations** → **Shift review report** → disable sections that expose totals, e.g. **Tips & Fees Earned** and **Credit Tip Audit** (and any other tip rows you don’t want visible). Publish. citeturn11view0

4) **(Optional) Trim what the Z-report shows on devices.**  
   Toast lets you configure what appears on POS reports (used in Close Out Day/Z-report). Go to Employees → **POS report configurations** and remove tip fields there as well. citeturn7search4

**Notes**
- Servers will still see *their own* numbers during Shift Review if you leave those sections enabled; the steps above stop them from seeing the **restaurant-wide** nightly tips. The permissions that surface the Z-report and Sales Summary are the key levers. citeturn8view0turn11view0

If you tell me the exact job name your servers use, I’ll map the precise boxes to uncheck for that role.


## See Also
- [[chatgpt/chatgpt_hide-seasonal-items-toast]]
- [[chatgpt/chatgpt_hide-album-art-image]]
- [[chatgpt/chatgpt_hide-div-with-custom-css]]
- [[chatgpt/chatgpt_hide-navbar-on-homepage]]
- [[chatgpt/chatgpt_hide-screenshots-in-photos]]
