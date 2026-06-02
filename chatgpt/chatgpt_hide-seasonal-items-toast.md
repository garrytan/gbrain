---
title: "Hide seasonal items Toast"
type: note
created: 2025-09-22
updated: 2025-09-22
source: chatgpt-export
conversation_id: 68d0b6ea-48d0-832d-8924-d306a5c7665c
message_count: 2
tags: [chatgpt, import]
---
# Hide seasonal items Toast

> Conversation ID: 68d0b6ea-48d0-832d-8924-d306a5c7665c
> Created: 2025-09-22T02:40:03Z
> Updated: 2025-09-22T02:40:10Z
> Messages: 2

---

## User

Yo dawg, in Toast, is there a good way to deal with, um, seasonal items that I want to, like, hide from our menus, but not delete entirely, so that I can bring them back later? Like, I don't want to mark them out of stock, because then they still show up in the system.

---

## Assistant

Yeah, Toast can do that cleanly:

**Menu-group method (best)**  
- Go to **Menus → Menu Management → Menus**.  
- Put the seasonal items in their own **Menu Group** (or a dedicated modifier group if that fits).  
- When the season’s over, **unpublish** that group or the entire menu from your locations/channels.  
- The items stay in your database—pricing, recipes, reports all intact—but they vanish from POS, Kiosk, and Online Ordering until you republish.

**Item-level method**  
- Edit each item → **Visibility** → turn off every **Order Channel** (POS, Online, Kiosk, etc.).  
- Or set the **Active Date Range** to the season dates, then just extend or reactivate next year.

Both hide them completely without marking them “out of stock,” so guests never see them and you can bring them back with one toggle.


## See Also
- [[chatgpt/chatgpt_hide-tips-on-toast]]
- [[chatgpt/chatgpt_hide-album-art-image]]
- [[chatgpt/chatgpt_hide-div-with-custom-css]]
- [[chatgpt/chatgpt_hide-navbar-on-homepage]]
- [[chatgpt/chatgpt_hide-screenshots-in-photos]]
