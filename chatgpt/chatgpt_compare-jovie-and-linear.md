---
conversation_id: 69436d66-f4c0-8327-9ae6-b87543e4781c
created: 2025-12-18
links:
- '[[chatgpt-clusters/jovie_product_strategy]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Compare Jovie and Linear
type: guide
updated: 2025-12-18
---

# Compare Jovie and Linear

**Related:** [[jovie_music]]

> Conversation ID: 69436d66-f4c0-8327-9ae6-b87543e4781c
> Created: 2025-12-18T02:56:42Z
> Updated: 2025-12-18T03:10:10Z
> Messages: 4

---

## User

{'asset_pointer': 'sediment://file_000000003a2871fd93fc7a23edd0d40d', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 787, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 821416, 'width': 1403}
Whats the differences between these two. I want the jovie auth screen to look like the linear auth screen (left)

---

## Assistant

Mr. White — here’s what’s different, and what to change to make **Jovie match Linear**.

## Key differences (what your eye is picking up)
- **Primary CTA styling**
  - Linear: *brand-colored filled* button (strong hierarchy).
  - Jovie: *light/white* primary button (feels “secondary” vs the page).

- **Secondary button treatment**
  - Linear: dark **filled** buttons (no obvious outline).
  - Jovie: dark buttons with a **visible border/outline**, which makes them feel lighter/less “solid”.

- **Vertical rhythm**
  - Linear: tighter grouping; helper text sits close to the primary button; consistent gaps between options.
  - Jovie: more empty space between helper text and the next buttons; the whole stack feels more “floated”.

- **Footer/link placement**
  - Linear: “Don’t have an account?” sits *lower* and reads like a footer.
  - Jovie: “Join the waitlist” sits *mid-stack*, so the layout feels unfinished / too airy.

- **Width + alignment consistency**
  - Linear: buttons feel like one unified block (same width, same corner radius, consistent padding/icon spacing).
  - Jovie: widths/padding feel slightly less unified (especially the outlined buttons).

## What to change in Jovie (in order)
1. **Make the primary button a filled brand color** (Linear-style).  
   If Spotify is “last used”, you can still keep it first—just don’t use a white button.

2. **Remove outlines on secondary buttons** and use a filled dark surface (subtle elevation), matching Linear.

3. **Normalize spacing**
   - Helper text: closer to the primary button (e.g. `margin-top: 8px`)
   - Gap between buttons: consistent (e.g. `gap: 12px`)
   - Bigger gap between “last used” block and the rest (e.g. `margin-top: 18–24px`)

4. **Push “Join the waitlist” to a true footer position** (below the auth methods, with more top margin).

5. **Lock the stack to a fixed max width** (so it reads like a single “module”), e.g. `max-width: 420px; width: 100%`.

## Quick CSS recipe (gets you ~90% of the Linear feel)
```css
.authPage{
  min-height:100vh;
  display:flex;
  justify-content:center;
  align-items:center;
  padding:48px 24px;
}

.authStack{
  width:100%;
  max-width:420px;
  display:flex;
  flex-direction:column;
  align-items:center;
}

.buttons{
  width:100%;
  display:flex;
  flex-direction:column;
  gap:12px;
  margin-top:18px;
}

.btn{
  width:100%;
  height:48px;
  border-radius:12px;
  display:flex;
  align-items:center;
  justify-content:center;
  gap:10px;
  font-weight:500;
}

.btnPrimary{
  background:#5B5CE2; /* use your brand accent */
  color:#fff;
  border:0;
  box-shadow:0 10px 24px rgba(0,0,0,.35);
}

.btnSecondary{
  background:rgba(255,255,255,.08);
  color:#fff;
  border:0; /* remove outline */
}

.helper{
  margin-top:8px;
  font-size:13px;
  opacity:.65;
}

.footerLink{
  margin-top:28px;
  font-size:13px;
  opacity:.7;
  text-align:center;
}
.footerLink a{ opacity:1; }
```

If you tell me what stack you’re using (Next.js + Tailwind? Radix? plain CSS?), I’ll translate this into your exact components/classes.

---

## User

{'asset_pointer': 'sediment://file_000000001f2471f89bb54598e03e97c9', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 732, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 391397, 'width': 1470}
What makes their footer link fonts look so good compared to ours

---

## Assistant

Mr. White — it’s not one magic font; it’s a few typography decisions Linear nails that your footer doesn’t yet.

## Why Linear’s footer links look “cleaner”
- **Better contrast tuning on dark UI**
  - Linear’s link color is brighter (higher alpha), so strokes don’t “wash out.”
  - Your links look a bit too low-contrast/gray, which makes edges feel softer.

- **More precise size/weight pairing**
  - Linear: small-ish links + true *regular* weight + slightly tighter tracking → crisp.
  - Yours: a touch larger with more leading/air + lighter-looking rendering → feels less dense/sharp.

- **Font rendering choices**
  - If you’re forcing `-webkit-font-smoothing: antialiased;` (grayscale AA), small gray text on dark backgrounds can look thinner/blurrier than Linear’s.
  - Subpixel/default rendering often reads sharper for small UI text.

- **Hierarchy is clearer**
  - Linear headings are brighter and a bit heavier; links are slightly dimmer but still readable. Your headings/links are closer in tone, so everything feels flatter.

## Fixes to try (fast, high impact)
1. **Bump link contrast** (don’t rely on very low opacity):
```css
.footer a { color: rgba(255,255,255,.72); }
.footer h4 { color: rgba(255,255,255,.92); font-weight: 600; }
```

2. **Dial in font metrics** (this alone often makes it “Linear-like”):
```css
.footer a{
  font-size: 14px;
  line-height: 22px;
  letter-spacing: -0.01em;
  font-weight: 450; /* if using variable font (Inter) */
}
```

3. **Check font smoothing** (try removing it first):
```css
/* Try NOT setting this globally */
html { /* -webkit-font-smoothing: antialiased; */ }
```

4. **Use a high-quality UI font + optical sizing**
```css
html{
  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  font-optical-sizing: auto;
}
```

If you paste your current footer CSS (or Tailwind classes), I’ll mark exactly what to change to match Linear’s look.


**Topic:** [[chatgpt-clusters/jovie_music]]
