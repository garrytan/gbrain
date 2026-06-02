---
title: "Design Improvement Guidelines"
type: guide
created: 2026-04-02
updated: 2026-04-02
source: chatgpt-export
topic: design-ux
message_count: 9
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# Design Improvement Guidelines

> **Source:** ChatGPT conversation
> **Date:** 2026-04-02T00:22:43Z
> **Messages:** 9
> **Topic:** design-ux

## Question

do 20 more passes and really actually use your eyes and analyze the screenshots of the dev server, because most of these screenshots are cropped horribly. They're cropped to the point that they crop in the middle of content. The overall layout you have has oversized images that are pushing things out of view and are incredibly off screen. You've got literal photos that are just random crops of onboarding screens that don't show anything useful. You have an audience visibility screen that has a fucked up crop and then the text "audience visibility" on it, which is not useful, and then a fake Chrome or browser window, but it's cut off. They all suck.

There's not enough spacing in the footer CTA; it's cramped. Everything's really cramped. There's no spacing between sections. The stack section is not designed in any way. A lot of this shit is just really poorly designed and cropped and spaced, even though you mentioned fixing it. The hero text in the hero section is still on four lines, e

## Answer

I’m going to inspect the current project, run it locally, and review the layout against actual screenshots so I can tighten spacing, hierarchy, cropping, and typography instead of guessing. Then I’ll revise the page and re-check the result across breakpoints and both themes.

## Question

give it detterminism in its output and force it to loop continuously actually inspecting and checking visuals on references and output til they math.

## Question

i just want a prompt

## Answer

Mr. White, use this:

```text
You are a senior product designer + frontend engineer doing a world-class landing page polish pass. Your job is to keep iterating on the live dev server until the page looks intentional, premium, and visually coherent across breakpoints and themes.

Mode:
- Deterministic output only.
- Set temperature to 0 if supported.
- Set a fixed seed if supported.
- Avoid random image choices, random font choices, or ad hoc styling.
- Make decisions from a strict priority order: layout/hierarchy first, spacing second, cropping/media third, typography fourth, decorative details last.

Non-negotiable workflow:
1. Launch the dev server.
2. Use browser inspection and screenshots of the actual rendered page.
3. Analyze the screenshots with your eyes. Do not rely on code review alone.
4. Make changes.
5. Re-screenshot and compare.
6. Repeat for at least 20 passes or until every acceptance criterion is satisfied.
7. After every pass, inspect light mode and dark mode at every breakpoint.
8. Do not stop after “mostly better.” Keep going until it looks genuinely world-class.

Breakpoints to check every pass:
- 375px mobile
- 430px large mobile
- 768px tablet
- 1024px laptop
- 1440px desktop

Reference behavior:
- Study Frame.io carefully for visual hierarchy, section pacing, off-screen media treatment, typography scale, and CTA composition.
- Borrow structural ideas, not branding.
- Push media partially off-screen where it improves composition, especially in the hero.
- Use stronger visual hierarchy so the eye knows exactly where to go first, second, and third.

Core design goals:
- Clear visual hierarchy
- Strong section rhythm
- Intentional negative space
- Premium typography
- Controlled media cropping
- Consistent card/image treatment
- Distinct section identities
- Calm, confident composition

Specific issues to fix:
- Most screenshots are badly cropped. Some crops cut through the middle of meaningful UI. Fix all of them.
- Oversized images are pushing content off screen in a clumsy way. Rebalance scale and placement.
- Remove useless random crops of onboarding screens that do not communicate anything.
- The “audience visibility” image treatment is bad. Replace it with a crop that shows a complete, legible, useful UI moment.
- Fake browser or Chrome frames must be fully intentional and fully visible if used. No cut-off fake windows.
- Footer CTA needs much more breathing room.
- The whole page feels cramped. Add real spacing between sections and inside sections.
- The stack section currently has no design. Redesign it so it feels authored and premium.
- The hero text is wrapping poorly. It is two short sentences and should fit in a cleaner line structure. Get it to roughly two lines on desktop.
- Push the hero screenshot off screen in a sophisticated way, similar to premium SaaS marketing sites.
- Reduce the feeling that everything has the same weight. Introduce hierarchy through type scale, spacing, contrast, and composition.

Rules

*(Answer truncated — 5832 chars total)*

## Question

{'asset_pointer': 'sediment://file_00000000e80071f5af285c3c3f97e206', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 910015, 'width': 337}
{'asset_pointer': 'sediment://file_000000000f4871f58da711197bbad2fe', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sa

## Answer

Mr. White, yes — this result missed badly. It optimized for a polished-sounding changelog instead of ruthless visual QA.

The screenshots show obvious failures:
- hero headline still wraps badly and loses hierarchy
- hero media overwhelms the left column instead of composing with it
- text contrast is weak in multiple places, especially light mode
- the proof screenshot is still a giant dead slab with poor narrative value
- the stack section still looks like a quick table, not a designed section
- the onboarding crop is still awkward and clipped
- the lower feature pair has mismatched weights and bad balance
- the final CTA is still weak and under-designed
- section rhythm is inconsistent: some areas are cramped internally while the page also has random dead vertical gaps

Use this stricter prompt instead:

```text
You are a ruthless staff-level product designer and frontend engineer. Your task is to keep editing the live landing page until the rendered result passes a hard visual review. You must judge the page from screenshots of the actual browser output, not from the code and not from your intentions.

Execution mode:
- Deterministic only.
- temperature: 0
- fixed seed if supported
- no random image choices
- no random font exploration
- no “looks better to me” decisions without screenshot evidence

Primary rule:
Do not write a success summary unless the screenshots actually satisfy every acceptance test below.
Do not praise the work.
Do not describe effort.
Do not say “world-class” unless the screenshots clearly support it.

Required workflow:
1. Run the dev server.
2. Capture full-page screenshots in light and dark mode at:
   - 375
   - 430
   - 768
   - 1024
   - 1440
3. Before changing code, produce a ruthless visual audit from the screenshots only.
4. List the 10 worst problems, ordered by severity.
5. Fix the top 3 only.
6. Rebuild, re-screenshot, and compare.
7. Repeat for at least 20 passes or until all acceptance tests pass.
8. After each pass, explicitly check whether each acceptance test passes or fails.
9. If a test fails, continue looping.

Hard review standard:
Assume the current page is bad until proven otherwise.
Assume every screenshot crop is guilty until verified useful.
Assume every section lacks hierarchy until it is obvious where the eye goes first.
Assume every spacing decision is wrong until it creates rhythm.

What to inspect with your eyes on every pass:
- hierarchy
- line breaks
- media cropping
- contrast
- alignment
- section spacing
- internal padding
- visual rhythm
- card balance
- CTA strength
- light mode quality
- dark mode quality

Non-negotiable design direction:
- premium SaaS editorial feel
- Frame.io-inspired hierarchy and off-canvas composition
- restrained text blocks
- deliberate negative space
- large but controlled product imagery
- fewer, stronger focal points
- no filler screenshots
- no placeholder-looking comparison tables
- no accidental crops
- no tiny weak labels carrying too much load

Con

*(Answer truncated — 6947 chars total)*

## Question

Refine this concept further. Reduce visual noise by 20%. Increase perceived luxury and clarity. Make spacing more disciplined, typography more premium, and interactions more natively iOS. Preserve the grayscale-only system. Improve conversion emphasis on notifications/signup without making the design feel aggressive. Make the mobile layouts feel exceptional enough to ship. this is whtat i got

## Answer

Mr. White, this current result still feels like a cleaned-up draft, not a finished product.

The main problems visible in these screenshots:
- The hero still feels muddy. The text block is too dim, too buried, and competes with the product image.
- The page is still screenshot-heavy. The giant release card dominates the story instead of supporting it.
- The stack section reads like a plain comparison table, not a premium section.
- The onboarding section is oversized and clumsy on mobile.
- The lower two-card feature area has weak balance and weak captions.
- The final CTA still looks like a footer row, not a conversion moment.
- Light mode is especially weak. Contrast and hierarchy collapse.

Use this refined prompt instead:

```text
You are refining an existing grayscale-only SaaS landing page toward a more luxurious, minimal, conversion-aware direction.

Your goal:
Reduce visual noise by roughly 20%.
Increase perceived luxury, clarity, and restraint.
Make spacing more disciplined, typography more premium, and interactions feel more natively iOS.
Preserve the grayscale-only system.
Increase emphasis on notifications/signup without making the page feel aggressive or salesy.
Make mobile layouts strong enough to ship as-is.

Design intent:
- premium grayscale editorial SaaS
- Apple / native iOS restraint in controls and motion
- Frame.io-level hierarchy and composition discipline
- fewer elements competing at once
- calmer surfaces, clearer focal points, stronger rhythm
- quiet confidence, not startup clutter

What is wrong with the current version:
- hero text has weak presence and poor contrast
- hero media still feels too large and too literal
- there is too much screenshot mass on the page
- sections do not breathe with enough discipline
- the stack section feels like a utility table rather than designed storytelling
- typography feels generic instead of premium
- the CTA for signup/notifications is too weak
- mobile feels like desktop blocks stacked down the page instead of truly designed mobile-first compositions
- light mode lacks conviction and collapses hierarchy

Your job:
Refine the page by editing the actual implementation and validating from screenshots of the real browser output.

Non-negotiable art direction:
1. Reduce visual noise by 20 percent.
   - remove weak captions
   - remove redundant labels
   - remove any screenshot that does not communicate a clear product moment
   - reduce border/shadow/decorative treatment if it adds clutter
   - simplify repeated card treatments

2. Increase luxury.
   - stronger typography hierarchy
   - tighter headline line lengths
   - more deliberate whitespace
   - cleaner section transitions
   - more restraint in interface framing
   - fewer competing edges, boxes, and dividers
   - grayscale should feel rich through tone and spacing, not through decoration

3. Make interactions feel more natively iOS.
   - controls should feel tactile, rounded, quiet, and direct
   - buttons should feel like

*(Answer truncated — 8716 chars total)*
