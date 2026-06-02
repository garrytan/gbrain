---
title: "Auto highlight next show"
type: guide
created: 2025-10-06
updated: 2025-10-06
source: chatgpt-export
conversation_id: 68e4549c-9ad8-8331-9d8e-087490dab756
message_count: 6
tags: [chatgpt, import, code]
---
# Auto highlight next show

> Conversation ID: 68e4549c-9ad8-8331-9d8e-087490dab756
> Created: 2025-10-06T23:45:48Z
> Updated: 2025-10-06T23:55:22Z
> Messages: 6

---

## User

{'asset_pointer': 'sediment://file_00000000187c61f7a2fdcd54fe41918b', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 785, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 265099, 'width': 788}
Look at our schedule. Is there a way to auto highlight the next show based on todays date?

---

## Assistant

Mr. White — yes. Do it with one helper cell + a conditional format.

**Assumptions**
- Row 2 has real dates in the headers (e.g., P2:U2).
- Rows 4:100 hold show times (e.g., P4:U100) as real times.

**1) Find the next show (helper cell, e.g., Z1)**
Paste in Z1:
```
=MIN(FILTER(P$2:U$2 + P$4:U$100,
            P$4:U$100<>"",
            P$2:U$2 + P$4:U$100 >= NOW()))
```
This builds full datetimes (date header + time), filters to future-or-now, and returns the soonest.

**2) Highlight it**
- Select the time grid P4:U100 → Format → Conditional formatting.
- “Custom formula is”:
```
=(P$2 + P4) = $Z$1
```
- Pick a highlight color and apply.

That will auto-highlight the single cell for the next upcoming show based on today/now. If you only care about the *next calendar day* instead of exact time, replace `NOW()` with `TODAY()`.

---

## User

Or even better highlight the current week of shows?


---

## Assistant

Yes, Mr. White—highlight the whole **current week** by keying off the date in each column header.

**Steps (Google Sheets):**
1. Select the range to shade (e.g., `P2:U100`).
2. Format → **Conditional formatting** → “Custom formula is”.
3. Use this formula (week starts **Monday**):
```
=(P$2 - WEEKDAY(P$2,2) + 1) = (TODAY() - WEEKDAY(TODAY(),2) + 1)
```
4. Pick a fill color → **Done**.

This compares each column’s header date (`P$2`, `Q$2`, …) to the Monday of **today’s** week; matching columns get highlighted.

**If your week starts Sunday**, use:
```
=(P$2 - WEEKDAY(P$2,1) + 1) = (TODAY() - WEEKDAY(TODAY(),1) + 1)
```

(Adjust the apply range and the anchor cell `P$2` to match your leftmost date column.)

---

## User

Can you conditionally freeze column headers in Google Sheets?

---

## Assistant

No, Mr. White — **you can’t conditionally freeze columns or rows in Google Sheets** (there’s no formula-based or automatic trigger for the “Freeze” feature). Freezing is a *manual view setting*, not something Sheets can dynamically change based on logic or dates.

**However, here are two practical alternatives:**

1. **Conditional Highlighting (visual freeze substitute)**  
   You can highlight the current week’s column headers (as we did earlier). This visually mimics “freezing” attention on active dates.

2. **Apps Script workaround (semi-automatic)**  
   You can attach a script to your Sheet that runs on open or daily:
   ```js
   function onOpen() {
     const sheet = SpreadsheetApp.getActiveSheet();
     const today = new Date();
     const headers = sheet.getRange("P2:U2").getValues()[0];
     for (let i = 0; i < headers.length; i++) {
       const date = new Date(headers[i]);
       if (today >= startOfWeek(date) && today <= endOfWeek(date)) {
         sheet.setFrozenColumns(i + 1);
         break;
       }
     }
   }

   function startOfWeek(d) {
     const day = d.getDay();
     const diff = d.getDate() - day + (day === 0 ? -6 : 1);
     return new Date(d.setDate(diff));
   }

   function endOfWeek(d) {
     const result = startOfWeek(new Date(d));
     result.setDate(result.getDate() + 6);
     return result;
   }
   ```
   This script automatically freezes up to the current week’s column when you open the Sheet.

Would you like me to format that Apps Script for your exact column layout (so it works directly)?


## See Also
- [[chatgpt/chatgpt_auto-advance-date-tracking]]
- [[chatgpt/chatgpt_auto-assign-linear-agents]]
- [[chatgpt/chatgpt_auto-assign-sentry-issues]]
- [[chatgpt/chatgpt_auto-body-shop-suggestion]]
- [[chatgpt/chatgpt_auto-claude-overview]]
