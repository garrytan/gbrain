---
title: "Toast KDS runner ticket solution"
type: note
created: 2025-09-28
updated: 2025-09-28
source: chatgpt-export
conversation_id: 68d9614c-481c-8323-865d-a45142ecdfe5
message_count: 2
tags: [chatgpt, import]
---
# Toast KDS runner ticket solution

> Conversation ID: 68d9614c-481c-8323-865d-a45142ecdfe5
> Created: 2025-09-28T16:26:14Z
> Updated: 2025-09-28T16:26:26Z
> Messages: 2

---

## User

We have our kitchen use a toast KDS. They tap items and it prints a ticket. 

We want runner tickets printed separately per item but toast doesn’t do this unless we separate our items on the KDS which fucks over our bar because every drink is on a separate ticket. 

Is there a solution?

---

## Assistant

Toast KDS can’t natively split a single kitchen item into multiple *runner* tickets without also splitting all other tickets—including bar drinks—because their print logic is tied to how items are grouped.

Here are your real-world options:

**1. Create a second KDS/Printer route just for runners**  
• Duplicate each menu item with a “runner” tag and route those to a dedicated printer.  
• The kitchen taps the normal item, and the runner item prints separately.  
• Downside: doubles menu maintenance and requires staff training.

**2. Use “Prep Stations” with conditional routing**  
• Toast allows multiple prep stations per item.  
• You can set one station to send to the bar/kitchen and another to a runner printer.  
• Configure the runner station to print *per modifier* or *per quantity* so each fires as a separate chit.  
• Test carefully—modifier-based routing can get messy.

**3. Third-party middleware**  
• Integrate a print-server tool (e.g., Fresh KDS, ItsaCheckmate, or a custom web-hook service) that listens to Toast’s order webhooks and generates runner tickets however you like.  
• Keeps the bar untouched but adds cost and some dev work.

**4. Operational workaround**  
• Keep Toast as-is and have the expo/expediter print “duplicate single-item tickets” from the KDS on demand.  
• Simple and cheap, but manual.

Toast support will confirm there’s no hidden setting for “per-item runner prints” without separate routing. If you want true automation without menu duplication, option 3 (middleware using Toast API/webhooks) is the only clean technical fix.
