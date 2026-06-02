---
title: "Design comparison tips"
type: note
created: 2025-11-13
updated: 2025-11-13
source: chatgpt-export
conversation_id: 69162ee8-5100-8326-ac87-ffb1abf6a447
message_count: 2
tags: [chatgpt, import]
---
# Design comparison tips

> Conversation ID: 69162ee8-5100-8326-ac87-ffb1abf6a447
> Created: 2025-11-13T19:18:35Z
> Updated: 2025-11-13T19:21:11Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_000000000fe071f59993078670bb741d', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 113221, 'width': 708}
{'asset_pointer': 'sediment://file_000000000060720c896b80b9d9e0e49a', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 66767, 'width': 708}
{'asset_pointer': 'sediment://file_00000000af8c720ca93ba3b5f4cabb62', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 112575, 'width': 708}
Why does apples design look so much better than mine. The dark mode one is mine and I attached light and dark mode of apples

---

## Assistant

You’re seeing the difference between “works” and “highly-polished,” Mr. White.  
Apple’s isn’t magic – it’s a bunch of small decisions stacking up. Here’s what’s going on vs your dark one (the middle screenshot) and how to fix it.

---

### 1. Layout & balance

**Apple:**
- Chart takes up a big, central chunk of the screen.
- Clear vertical rhythm: header → tabs → value/date → chart → card.
- Top and side margins are consistent.

**Yours:**
- Huge empty black area; the chart is compressed into the lower half.
- Tabs, value, and chart feel loosely stacked rather than part of a grid.
  
**Fix:**
- Make the chart taller and start it higher on the screen.
- Establish consistent side margins (e.g. 16–20pt) and vertical spacing.
- Think in rows/sections:  
  `Nav` → `Segmented control` → `Value+date` → `Chart` → `Trends`.

---

### 2. Information hierarchy

**Apple:**
- One clear focal point: the weight/average text.  
- Supporting info (date, units, axes labels) is smaller and lighter.
- “Trends” is in its own rounded card, clearly a separate section.

**Yours:**
- The big number is huge relative to everything else, so it visually overwhelms the chart.
- Date and context are visually weak / far from the graph.
- No visual grouping for a “Trends” section.

**Fix:**
- Reduce the weight font size a bit and move it closer to the chart.
- Use font weight & size to define levels:  
  Title > value > dates > axis labels > extra copy.
- Put “Trends” and similar info in a distinct card with a slightly different background.

---

### 3. Color & dark-mode treatment

**Apple (dark):**
- Background is dark gray, not pure black.
- Chart area and cards are a slightly lighter gray – subtle layers.
- Accent color is bright but thin, so it doesn’t scream.

**Yours:**
- Pure black background makes everything else look harsher.
- No separation between different regions (everything is just on black).
- Magenta line is strong and thick, so it dominates.

**Fix:**
- Use near-black (`systemBackground` in dark mode, not #000000).
- Give chart and “Trends” a very slightly lighter panel background.
- Thin the chart line a bit and consider soft gridlines in a muted gray.

---

### 4. Typography & alignment

**Apple:**
- All text uses consistent type styles from the system (SF Pro weights/sizes).
- Units (“lbs”) and date sit close to the value, aligned nicely.
- Tabs (D/W/M/6M/Y) are evenly spaced with clear selection state.

**Yours:**
- Proportions between “159.6”, “lbs”, and the date feel off.
- The chart’s x-axis numbers are very close to the bottom edge; top area feels empty.
- Segmented control looks a bit detached from the rest.

**Fix:**
- Use iOS text styles (`title2`, `headline`, `caption2`, etc.) instead of ad-hoc sizes.
- Tighten the grouping of value + units + date.
- Align the segmented control and chart to the same left/right margins and reduce dead space above the chart.

---

### 5. Data density & context

**Apple:**
- Shows axes labels (140–170 etc.), x-axis labels (days), and subtle grid lines.
- Shows context text (“Your average weight decreased…”).

**Yours:**
- Feels like “big number + tiny line.” Less context, less sense of scale.

**Fix:**
- Make sure axis labels and grid lines are clearly legible but low-contrast.
- Add one line of copy summarizing the trend; it makes the screen feel purposeful, not just decorative.

---

### If you want a concrete checklist

1. Change dark background to a dark gray; add slightly lighter gray panels for chart & Trends.
2. Increase chart height; move it higher on the screen.
3. Shrink the main number slightly; bring units/date closer.
4. Use consistent margins and type styles; align everything to a grid.
5. Thin the chart line; add soft grid lines and clearer axis labels.
6. Put “Trends” in a rounded card with its own padding.

You’re actually close — structurally it’s the same screen. You just need those last 10–20% polish details Apple is obsessive about.
