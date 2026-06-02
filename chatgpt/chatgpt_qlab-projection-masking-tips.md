---
title: "QLab projection masking tips"
type: note
created: 2025-10-07
updated: 2025-10-07
source: chatgpt-export
conversation_id: 68e58354-3fe4-8325-b126-58f6c251712e
message_count: 6
tags: [chatgpt, import, long-form]
---
# QLab projection masking tips

> Conversation ID: 68e58354-3fe4-8325-b126-58f6c251712e
> Created: 2025-10-07T21:17:09Z
> Updated: 2025-10-07T21:31:34Z
> Messages: 6

---

## User

Hey, so I'm doing some projection mapping in QLab. I've used MadMapper, Resolume, and a billion others in professional projection maps for years. First time doing it in QLab, but I'm trying to figure out what's the best way for me to do masking in QLab on top of all of my content. I want to be able to mask out things like smoke detectors, exit signs, frames, light switches, so we can just hit the actual walls. What would be the best location for those masks to live? I want to draw them in and adjust them manually in QLab, and then corner pin the masks into place. What's the best way to do that?

---

## Assistant

Good question — this is one of those “QLab can do it, but not elegantly” situations.  

Here’s how pros usually handle projection **masking directly inside QLab**, and where those masks should “live.”  

---

### 🎭 1. Where the Masks Should Live
Keep your masks as **separate video cues** at the very top of your cue list or grouped above your content layers.  
Each mask cue should:
- Be **full-screen**, same resolution as your projector output.
- Be **black with transparent holes** for the projection areas.
- Have **blend mode = Destination In / Destination Out / Multiply**, depending on what you’re masking (QLab uses CoreImage filters under the hood).

This way, the masks act as a “matte” on top of your other cues and you can toggle or adjust them without touching content cues.

---

### 🧩 2. Creating the Masks
Since QLab doesn’t have a drawing tool:
- Create a **.PNG with alpha** in an external app (Affinity, Photoshop, or Krita) for rough shapes.
- If you need to tweak geometry onsite, add a **Video Effect → CI Warp / Perspective Transform** to corner-pin inside QLab.
- You can **stack multiple masks** — e.g. one for walls, one for signage, one for floor bleed.

If you really need to *draw* inside QLab:
- You can import a **white PNG** and use **Chroma Key filter** to punch holes, but this is hacky.
- QLab has no bezier or brush tool for drawing masks natively.

---

### 🧠 3. Workflow for Projection Mapping in QLab
A clean structure looks like this:
1. **Group cue for projection surface**  
   - Your actual media cues, each with perspective correction.
2. **Group cue for masks (on top)**  
   - Each mask PNG with transparency.  
   - “Always show video” turned on, set to full screen.  
   - Use **corner pin effect** to align.

If you’re mapping multiple projectors, give each output its own mask set and video surface.  

---

### 🪞 4. Alternative Hybrid Setup
If you want full manual masking flexibility:
- Run QLab as content player → output to **Syphon** → receive in **MadMapper**.  
- Do all masking / soft-edge blending there.  
That’s the cleanest, professional-grade approach — but it sounds like you want to stay all-QLab, so treat masks as top-layer PNGs.

---

### ✅ TL;DR
- Keep masks as **separate PNG video cues** layered above your media.  
- Corner-pin each mask via **Video Effects** inside QLab.  
- Adjust manually onsite.  
- For more control, Syphon into MadMapper and mask there.

Would you like me to outline the exact cue list structure (group hierarchy, surface setup, blend modes) for a 2-projector wall map example?

---

## User

I would need to build a frame for a set piece. Basically, imagine four squares in a row forming a rectangle, but each one of those squares has a bevel. So, I would need to create those bevels as masks. The way I'm thinking about doing it is importing a singular rectangular black rectangle, corner pinning it in for each bar of the bevel vertically, and then one that I just corner pin and stretch extra wide for the tops and bottom. Do I have the capability to then smash that together or export that mask out of QLab and then re-import it as a set mask or something? Or is that even worth doing? Should I leave them separate to keep control performance overhead as a consideration? Or would there be a more efficient way to do that? Also, would it be worth doing this directly in something else to get those masks generated? Thank you.

---

## Assistant

Excellent line of thought — you’re thinking like a show engineer here. Let’s go step-by-step.  

---

## 🎬 1. QLab’s Rendering Reality
QLab doesn’t have a “render to file” or “flatten group” feature.  
Even though you can visually stack multiple cues (black rectangles, alpha masks, etc.), **you can’t export that combined mask** out of QLab. It’s always computed at playback via CoreImage.  

So:  
> ❌ You can’t “smash” several mask cues together and export a single image.  
> ✅ You *can* group them visually, but QLab always processes them live.

That means **each bar or bevel cue remains a separate render pass** during playback — which adds GPU overhead, especially if you’re layering many semi-transparent or transformed PNGs.

---

## ⚙️ 2. Performance & Control Tradeoffs
Your instinct about “performance overhead vs control” is spot on.  

**If you leave masks separate:**
- ✅ Easier to tweak geometry on-site (critical for projection mapping).  
- ✅ Can quickly disable or move individual bevels.  
- ❌ Slightly higher GPU overhead — each cue = one CoreImage chain.  

**If you combine them externally:**
- ✅ Only one PNG to process = very efficient.  
- ❌ Harder to adjust live if your alignment changes (which it always does).  

In most projection-mapping workflows, control beats optimization — unless you’re driving 4K content across multiple surfaces on a laptop GPU.  

So, if your system’s reasonably powerful (M1/M2 Mac Mini or MBP), **leave them separate** for now. Combine later only if performance becomes a problem.

---

## 🧰 3. If You *Do* Want to Combine / Pre-Build the Mask
The cleanest workflow would be:
1. Use a 2D tool like **Affinity Designer, Illustrator, or Photoshop**.  
2. Create your **beveled frame as alpha mask (transparent holes)**.  
3. Export as a single **.PNG with alpha** matching your projection surface resolution.  
4. Import that as one video cue in QLab.  
5. Corner-pin it once to fit the set piece.

This is often the best route if your set geometry is known and stable.

If you want to get more visual control for tweaking:
- Use **MadMapper** or **After Effects** to visually design the mask.  
- Export the final as PNG and then just use QLab for playback & mapping.

---

## 🧱 4. Practical Hybrid Suggestion
Here’s a workflow I’ve seen used professionally:
1. **Rough in** your mask shapes in QLab (black rectangles corner-pinned).  
2. Once alignment is perfect on-site, **screenshot or screen capture** that mask output.  
3. Bring that screenshot into Photoshop, clean it up, make perfect bevel edges.  
4. Export that polished mask back as a PNG.  
5. Replace your live cue group with that single optimized file.

That gives you the precision of external design **plus** the on-site flexibility of QLab.

---

## ✅ TL;DR Recommendation
- **Don’t try to export from QLab** — it can’t flatten or render masks out.  
- **Keep individual mask cues** for now (more control, minimal GPU cost).  
- Once geometry is locked, **recreate the mask externally** and re-import a single PNG.  
- If performance ever chokes, **bake the mask** externally to lighten GPU load.

---

Would you like me to outline the **cue structure and effect chain** I’d recommend for this beveled frame mask setup (so you can drop it straight into your QLab workspace)?

---

## User

How much would a MadMapper license be that is needed in order to achieve the mapping on this?

---

## Assistant

Here’s what I found for **MadMapper licensing costs** (as of the latest publicly available info). Prices may vary with exchange rates, region, VAT, or version upgrades, so treat these as ballpark:

- A perpetual (non-subscription) license for MadMapper is ~ **€399 (excl tax)** citeturn0search0  
- You can also get a temporary/rental license (~monthly) for **€39/month (excl tax)** citeturn0search0  
- There's also a “MadBundle” (MadMapper + MadLaser) perpetual license for ~ **€519 (excl tax)** citeturn0search4  
- If you're eligible, there’s a **30% educational discount** on software (not counting upgrades) citeturn0search1  

So in USD equivalency, the perpetual license tends to hover around **$400–450 USD** depending on taxes and region.

If you like, I can check the current price for the U.S. region (with tax) and send you links where you can purchase — would you prefer I do that?


## See Also
- [[chatgpt/chatgpt_connect-qlab-to-nextjs]]
- [[chatgpt/chatgpt_synced-paparazzi-effect-with-qlab]]
- [[chatgpt/chatgpt_companies-doing-projection-mapping]]
- [[chatgpt/chatgpt_nfl-smart-glass-projection]]
- [[chatgpt/chatgpt_aaa-membership-savings-tips]]
