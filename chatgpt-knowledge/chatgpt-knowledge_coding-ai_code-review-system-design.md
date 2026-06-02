---
title: "Code review system design"
type: essay
created: 2025-09-06
updated: 2025-09-06
source: chatgpt-export
topic: coding-ai
message_count: 16
tags: [chatgpt, knowledge, coding-ai]
---
# Code review system design

> **Source:** ChatGPT conversation
> **Date:** 2025-09-06T19:35:47Z
> **Messages:** 16
> **Topic:** coding-ai

## Question

So we're using Claude code to occasionally monitor all of our open issues and our open PRs and what it's doing is we're having it go through and say Look at all the open PRs and look at the code reviews that have been done or comments that that are there From co-pilot, from Claude, from me, from other team members And if anyone brings up anything on the PR that is like a an issue We are having Claude go through and then assign an AI agent to address those issues What I'd like to do is kind of formalize this as a system So what I'd like to do is have it so that if a code review or any comment brings up something that's like So problematic that it's blocking Where like Claude code review's verdict is like don't approve this PR We should comment and address it and get it to be a non-blocking issue or get it completely corrected But in a situation where it's like A minor like a bunch of minor fixes or something that would improve the performance And would make for a better product and user

## Answer

Mr. White — here’s a tight, battle-tested system you can drop in.

# 1) Decision policy (what blocks vs merges)
**Severity rubric** (attach as PR label + bot-read JSON):
- **P0 – Blocker**: failing checks, type errors, security/secret/regression risk, data loss/migration risk, broken UX flows, flaky tests added, performance >2× regression on hot paths.  
  → **Action**: comment with concrete fixes, **disable Merge-When-Ready**, assign fix agent, re-review required.
- **P1 – Risky/near-blocker**: correctness edge cases, unclear requirements, missing tests/docs for new surfaces.  
  → **Action**: if fix is <30m, **fix-in-PR**; else **convert to follow-up** and keep **Merge-When-Ready off** until owner acks with “safe to ship”.
- **P2 – Non-blocking quality**: nits, style, small perf wins, refactors, DX polish.  
  → **Action**: **enable Merge-When-Ready**, auto-open follow-ups, do not hold the PR.
- **P3 – Chore**: comments, typos, dead code notes.  
  → **Action**: convert to follow-ups; do not hold the PR.

**Single-page decision tree**
1) Any P0? → **Block**.  
2) No P0, but any P1?  
   - If fix <30m → **fix-in-PR** then **Merge-When-Ready**.  
   - Else → **follow-up issue(s)** + **Merge-When-Ready after owner “safe to ship”**.  
3) Only P2/P3 → **Merge-When-Ready now** + follow-ups.

# 2) What the AI reviewer must output (machine-readable)
Have your primary reviewer (Claude Code) always add a small JSON block at the end of its review so automation can act deterministically:

```json
{
  "ai_review_verdict": "block|merge_with_followups|fix_in_pr",
  "severity_counts": {"P0":1,"P1":0,"P2":3,"P3":1},
  "required_checks": ["build","typecheck","unit","e2e","preview"],
  "followups": [
    {"title":"Debounce error toast in Settings > Billing",
     "severity":"P2",
     "component":"dashboard/billing",
     "estimate":"30m",
     "suggested_agent":"copilot",
     "notes":"Converge to unified toaster and dedupe"}
  ]
}
```

Your GitHub Action (below) parses this block to (a) toggle Merge-When-Ready, (b) open issues in Linear, (c) dispatch the right agent.

# 3) GitHub rules (guardrails + velocity)
- **Enable Merge Queue** with a minimal set of **required checks**: build, typecheck, unit, e2e smoke, preview deploy.  
- **Branch protection**: 1 human review OR “AI-lead + human ack” for risky areas (migrations, auth, payments).  
- **Required status** from “AI Review Gate” (the Action that parses the JSON). If missing → blocks.  
- **PR template** includes the rubric + “Risk surfaces” checklist (migrations, secrets, auth, perf-critical).  
- **Labels** used by automations: `sev:P0..P3`, `ai:fix-in-pr`, `ai:followup`, `ai:blocked`, `ai:merge-ready`.

# 4) Orchestration layer (how agents get invoked)
Create a tiny “**Agent Orchestrator**” (Cloudflare Worker / small server) that listens to:
- **GitHub webhooks**: `pull_request_review`, `issue_comment`, `pull_request`, `check_suite`.
- **Linear webhooks**: issue created/updated.
- Optional: cron “sweeper” 

*(Answer truncated — 8795 chars total)*

## Question

{'asset_pointer': 'file-service://file-HZRw2biBopvYyBpuHxQxdt', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 696, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 344111, 'width': 891}
Ux audit

## Answer

Here’s a focused **UX audit** for the “Manage Links” screen you shared:

---

## Strengths
- **Clear structure**: Links are grouped into Social, Music, Custom — logical and easy to parse.  
- **Auto-save feedback**: The “Changes save automatically” message with timestamp builds user trust.  
- **Inline controls**: Hide/Remove buttons are right next to each item, minimizing clicks.

---

## Issues & Opportunities

### 1. Labeling / Consistency
- **Website link misclassified**: It shows as `https://instagram.com/timwhite` but is labeled “Website.” Could confuse users.  
- **Social names vs domains**: Social links use platform name (Instagram, TikTok, Twitter), but “Website” is ambiguous. Better to display “Website (Instagram)” or allow custom naming.  

**Recommendation**: Standardize labels by platform (auto-detect domain), with an option for custom labels.

---

### 2. Action Buttons
- **Hide vs Remove**: Both buttons are same size/weight. Users might click the wrong one. “Hide” feels ambiguous (does it hide on the public page only? or remove visibility here?).  

**Recommendation**:  
- Make “Remove” destructive-styled (red).  
- Add tooltips/hover text: *“Hide: keeps link but not visible publicly”* vs *“Remove: deletes link entirely”*.  

---

### 3. Entry Field UX
- Current placeholder: *“Paste any link (Spotify, Instagram, TikTok, etc.)”*.  
- Users may not know it auto-detects type. No visible error state for invalid URLs.  

**Recommendation**:  
- Add validation and immediate feedback (✓ valid / ✗ invalid).  
- Show detected type inline (“This will be added as TikTok”).

---

### 4. Empty States
- Music and Custom sections just say *“No links yet”* in low-contrast text. Missed opportunity to encourage engagement.  

**Recommendation**:  
- Use call-to-action placeholders: *“Add your Spotify, Apple Music, or SoundCloud link here to showcase your music.”*  
- Add a plus button or inline “Add link” to guide users.

---

### 5. Visual Hierarchy
- Social list items are visually heavy blocks with no separation between platform and URL.  
- URLs are redundant; users care more about platform identity than the raw link.  

**Recommendation**:  
- Display platform logo + name prominently.  
- Relegate URL to tooltip, expand-on-hover, or secondary text.  
- Consider lighter background cards or dividers to make scanning easier.

---

### 6. Scalability
- With many links, the vertical list could get unwieldy.  

**Recommendation**:  
- Add drag-and-drop reordering.  
- Collapse sections with counts (e.g., “Social (4) ▼”).  

---

## Priority Fixes
1. **Clarify Hide vs Remove** (tooltips, styling, destructive button for Remove).  
2. **Auto-detect and label platforms correctly** (fix misclassified “Website”).  
3. **Improve empty states with CTAs** to encourage link-adding.  
4. **Add logos/visual identity** for faster scanning.  
5. **Validation on add-link field** to prevent wrong entries.  

---

Would you like me to also **mock up a redesigned versi

*(Answer truncated — 3140 chars total)*

## Question

{'asset_pointer': 'file-service://file-JbjaoGdQhffdy4fyWdWmKm', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 630, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 349301, 'width': 926}

## Answer

Got it, Mr. White. The updated screen already looks tighter with the **platform logos** added — nice jump in scanability. Here’s the next round of UX audit notes:

---

## What’s Improved
- **Logos/icons**: Social platforms are instantly recognizable, reducing cognitive load.  
- **Collapsed sections (Music, Custom)**: Cleaner when empty, scales better.  
- **Consistent styling**: Card-like blocks read more balanced.

---

## Remaining Issues

### 1. Website Misclassification  
Still shows *Instagram link* under **Website** with a globe icon. This looks like a parsing bug.  
**Fix**: Auto-detect actual domain and assign correctly. If domain ≠ recognized platform, then default to “Website (custom)” with editable label.

---

### 2. Hide vs Remove Ambiguity  
Both buttons remain same weight. Potential for misclick.  
**Fix**:  
- Make **Remove** destructive (red, outlined).  
- Add hover tooltips clarifying:  
  - Hide → “Keep link but don’t display it publicly.”  
  - Remove → “Delete link from your profile.”  

---

### 3. Visual Hierarchy in List Items  
- Platform name + icon is good, but **URL clutters the row**.  
- Long URLs repeat domain (e.g., twitter.com/itstimwhite).  

**Fix**:  
- Make URL secondary (lighter text or truncation with hover expand).  
- Add “Copy” button or icon for quick grab.  

---

### 4. Add Flow / Error States  
Still no obvious validation or feedback when pasting a link. Right now, it’s fire-and-forget.  
**Fix**:  
- Inline feedback: green check (valid), red x (invalid).  
- Show platform detected: *“This will be added as TikTok”*.  

---

### 5. Scalability / Usability  
- With >10 links, this list will get tall and clunky.  
**Fix**:  
- Add **drag-and-drop reordering**.  
- Option to **collapse sections individually** with arrow toggle.  
- Show count on collapsed sections (already there, but tiny `? 0` isn’t clear). Use `Music (0)` instead.  

---

## Priority Recommendations
1. **Fix domain parsing** for “Website” mislabels.  
2. **Differentiate Hide vs Remove** (color, tooltip, destructive styling).  
3. **Demote URLs visually** (make secondary, add copy button).  
4. **Add validation/detection on paste** (shows platform or error).  
5. **Improve section collapses** (clearer counts, drag-and-drop ordering).  

---

Do you want me to also give you a **Figma-ready component spec** (with layout, typography tokens, button states, and icon treatment) so your devs/designers can just drop it in?

## Question

{'asset_pointer': 'file-service://file-JnBfH3UrX8ZWxWaLNKnaJ5', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 711, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 416668, 'width': 925}
We prioritize links based on the user and refers and network popularity to make a guess as to which link will be most likely to get clicked per user per site visit. So the user can't do that ordering. We allow darg between categories for youth because it's a DSP and a social network but we disable for others that aren't both.
Music is for DSPs only and we detect that. 
If they add a venmo we turn on tip featur and that's separate too

## Answer

Perfect context, Mr. White — thanks. Since you’re handling **ordering with algorithmic ranking (popularity, referral context, DSP priority)** instead of manual reordering, the UX needs to make that system clear so users don’t fight it. Here’s the focused audit for this flow:

---

## Strengths in Current UI
- **Platform detection** is working (YouTube is correctly recognized, icon + label).  
- **Inline add preview** is strong (user pastes link → system instantly shows what will be added).  
- **Section rules enforced** (Music auto-buckets DSPs, Social for social, Venmo triggers Tips). Keeps the taxonomy tight.  

---

## Issues & Opportunities

### 1. Ordering Transparency  
Right now, users may assume they can reorder but then be frustrated when they can’t. “Website” and “Social” all look draggable, but only DSP/social duals allow drag.  

**Fix**:  
- Disable drag handles for non-movable items (remove the dots).  
- Add a small info tooltip: *“Links are ordered automatically based on popularity. Some links (like YouTube) can appear in both Music & Social.”*  

---

### 2. Add Link CTA  
The red “Add YouTube” button is very heavy compared to the rest of the UI. It draws attention, but maybe too aggressively.  

**Fix**:  
- Use primary brand accent (instead of full red) unless there’s an error.  
- Keep red reserved for destructive actions (Remove).  

---

### 3. Misclassified “Website”  
Still a major bug: Instagram link showing under Website. Undermines trust in detection.  

**Fix**:  
- Tighten domain detection rules (if `instagram.com`, always → Instagram).  
- Only bucket as “Website” if domain not recognized and not DSP/social.  

---

### 4. Network Popularity Ordering  
If you’re algorithmically prioritizing by **click likelihood**, users need light affordances so they understand why Instagram appears above Twitter, for example.  

**Fix**:  
- Subtle microcopy: *“Links ordered by popularity”* at the top of each section.  
- Optional toggle in settings: *“Order links: Popularity / Manual”*. Even if manual is disabled, this reduces confusion.  

---

### 5. Venmo / Tips  
Good that you’re auto-triggering Tips when Venmo is added — but right now that’s invisible. Users won’t know why a new feature turned on.  

**Fix**:  
- Show a confirmation banner after adding Venmo: *“We’ve enabled Tips for you. Fans can now send payments.”*  
- Inline badge next to Venmo link: **[Tip Enabled]**.  

---

### 6. Validation & Error Handling  
YouTube add flow shows a second entry of “YouTube” — duplication risk looks confusing.  

**Fix**:  
- Detect duplicates and either:  
  - Block with feedback (*“YouTube link already exists”*), or  
  - Merge into one canonical entry.  

---

## Priority Recommendations
1. **Clarify ordering system** (remove drag handles for static, add “ordered by popularity” note).  
2. **Fix domain misclassification** (Instagram shouldn’t appear under Website).  
3. **Tame Add button styling** (primary accent, not destructive 

*(Answer truncated — 3335 chars total)*

## Question

{'asset_pointer': 'file-service://file-2qUpWX7bVdxJB2xpzzbjJA', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 135, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 97788, 'width': 711}
How do you fix this tooltip looking like 2 shapes rather than one

## Answer

What’s happening here, Mr. White, is that your tooltip body and its pointer/arrow are being rendered as **two separate shapes** — so you’re getting that diamond gap look instead of a continuous “speech bubble.”  

### How to Fix It

#### Option 1: Use `::after` (preferred)
Instead of placing the arrow as a separate DOM element, generate it with CSS on the tooltip itself:

```css
.tooltip {
  position: relative;
  background: #fff;
  color: #000;
  padding: 8px 12px;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.tooltip::after {
  content: "";
  position: absolute;
  bottom: -6px; /* adjust based on placement */
  left: 50%;
  transform: translateX(-50%) rotate(45deg);
  width: 12px;
  height: 12px;
  background: inherit;
  border-radius: 2px; /* optional for smoother corners */
  box-shadow: inherit; /* keeps same shadow */
}
```

Here the `::after` element inherits the tooltip background and shadow → so arrow and body look like **one continuous bubble.**

---

#### Option 2: SVG bubble
Draw the entire tooltip (rectangle + pointer) as one SVG shape. Gives perfect control but heavier to maintain. CSS pseudo-element is simpler.

---

#### Option 3: Clip-path / mask
Use `clip-path: polygon(...)` to create a speech bubble shape in a single div. Clean, but less flexible for resizing.

---

### Extra Polish
- Match `border-radius` of the box with the arrow’s corner radius.  
- If you have a border (e.g., light gray), apply it to both box and arrow (inherit with `border: inherit;`).  
- Keep the arrow size small (8–12px) so it blends rather than looking diamond-shaped.  

---

Would you like me to give you a **ready-to-drop Tailwind class version** of this tooltip (with the arrow) so it slots right into your stack without raw CSS?

## Question

Whats the recommended approach

## Answer

The recommended approach, Mr. White, is **CSS pseudo-elements (`::before`/`::after`) on the tooltip container**.  

Here’s why it’s considered best practice:  

### ✅ Advantages
- **One element, one background** → arrow and body look like a single continuous bubble (fixes your “two shapes” issue).  
- **Lightweight** → no extra DOM nodes, no inline SVGs.  
- **Scales automatically** → if you change tooltip background, border, or shadow, the arrow inherits it.  
- **Cross-browser safe** → widely supported, unlike some `clip-path` hacks.  
- **Maintainable** → consistent styling, easy to tweak size/position.

### ⚠️ Alternatives
- **SVG bubble** → pixel-perfect but overkill for tooltips; harder to maintain.  
- **Clip-path** → clean shape, but shadows/borders don’t play nicely.  
- **Separate DOM node for arrow** → causes the exact double-shape issue you’re seeing.

### 🔑 Rule of Thumb
> If your tooltip is a simple rectangle with a pointer, use **pseudo-elements**.  
> Only reach for **SVG or clip-path** if you’re doing highly custom shapes (curved arrows, callouts with multiple tails, etc.).

---

Do you want me to give you the **Tailwind-ready snippet** that uses `::after` so you can drop it straight into your tooltip component?

## Question

In tailwind 4?

## Answer

Yes, Mr. White — in **Tailwind 4** the recommended way is still to use a **pseudo-element (`::after`)** for the arrow, but now you can do it entirely with utilities (no custom CSS file).  

Here’s a ready-to-drop example:

```html
<div class="relative inline-block">
  <div
    class="relative bg-white text-black text-sm px-3 py-2 rounded-lg shadow-md
            after:content-[''] after:absolute after:left-1/2 after:bottom-[-6px]
            after:w-3 after:h-3 after:bg-white after:shadow-md
            after:rotate-45 after:-translate-x-1/2">
    Links are ordered automatically based on popularity. Some links (like YouTube) can appear in both Music & Social.
  </div>
</div>
```

### Key points:
- `after:content-['']` → creates the arrow.  
- `after:w-3 after:h-3` → 12px square, rotated 45°.  
- `after:bg-white` → inherits tooltip background.  
- `after:shadow-md` → keeps shadow continuous.  
- `after:rotate-45` → diamond → triangle-looking pointer.  
- `after:left-1/2 after:-translate-x-1/2` → centers arrow horizontally.  
- `after:bottom-[-6px]` → nudges arrow just outside the box so it looks attached.  

That gives you a **single-shape bubble**, not two pieces.  

---

👉 Do you want me to also show you the **dark mode variant** (so the arrow auto-switches to match background)?

## Question

Give me a clean UI prompt with dark mode variant i can give to cascase to build it

## Answer

Got you, Mr. White. Paste this straight into Cascade.

---

# Task: Build unified Tooltip (Tailwind v4) with dark-mode variant

## Goal
Create a reusable tooltip UI that renders as a single “speech-bubble” (body + arrow via pseudo-element), supports light/dark themes, and works in any placement (top/bottom/left/right).

## Constraints
- Tailwind v4 utilities only (no external CSS files).
- One DOM node for the bubble; arrow via `::after`.
- Framework-agnostic markup (works in Vue/Nuxt or React), but ship a small example snippet.
- Accessible (WAI-ARIA), keyboard + screen reader friendly.
- No FOUC; positions with pure CSS + data attributes.

## Component API (data attributes)
- `data-tooltip` — the trigger wrapper.
- `data-tip` — the tooltip bubble element.
- Optional attributes:
  - `data-placement="top|bottom|left|right"` (default: `top`)
  - `data-state="open|closed"` (for controlled visibility; default: closed)
- Tooltip content comes from child text/HTML.

## Visual spec
- Radius: `rounded-lg` (10–12px look).
- Padding: `px-3 py-2`.
- Font: `text-sm/5` (tight leading).
- Max width: `max-w-[42ch]`.
- Shadow: `shadow-md` (match brand token).
- Border: subtle 1px (transparent in light, visible in dark at 10% white).
- Arrow: 12px square, rotated 45°, same bg/border/shadow as bubble, positioned via `::after`.
- Motion: fade+scale 95% → 100%, 120ms, `ease-out`; reverse on close (80ms, `ease-in`).

## Theme tokens (Tailwind classes)
- Light: `bg-white text-neutral-900 shadow-md border border-black/5`
- Dark: `dark:bg-neutral-900 dark:text-neutral-100 dark:shadow-lg/40 dark:border-white/10`

## Placement rules (arrow offsets)
- Top: arrow at bottom `after:bottom-[-6px]`
- Bottom: arrow at top `after:top-[-6px]`
- Left: arrow at right `after:right-[-6px]`
- Right: arrow at left `after:left-[-6px]`
- Center along the opposite axis (`after:left-1/2 after:-translate-x-1/2`, etc.)

## Interaction
- Show on `hover` and `focus-visible` of trigger, hide on `blur`/`mouseleave`.
- Trap nothing; tooltips are non-modal.
- Respect `prefers-reduced-motion` → disable scale, keep minimal fade.

## Accessibility
- Trigger: `aria-describedby="<ID>"`, `tabindex="0"` if not naturally focusable.
- Bubble: `role="tooltip" id="<ID>"` and `aria-hidden="true|false"` synced with state.
- Ensure contrast ≥ 4.5:1 (provided colors meet this).

## Example markup (framework-agnostic)
```html
<!-- Trigger -->
<button data-tooltip aria-describedby="tt1" class="inline-flex items-center gap-1">
  ?
</button>

<!-- Tooltip -->
<div id="tt1" role="tooltip" data-tip data-placement="top" data-state="closed"
  class="pointer-events-none absolute z-50
         bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100
         border border-black/5 dark:border-white/10
         text-sm px-3 py-2 rounded-lg shadow-md dark:shadow-lg/40
         max-w-[42ch]
         opacity-0 scale-95 transition
         [data-state=open]:opacity-100 [data-state=open]:scale-100
         after:conte

*(Answer truncated — 5193 chars total)*
