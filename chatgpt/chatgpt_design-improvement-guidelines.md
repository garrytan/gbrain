---
conversation_id: 69cdb6c3-26d4-83e8-8257-17605756a5cf
created: 2026-04-02
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 9
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Design Improvement Guidelines
type: essay
updated: 2026-04-02
---

# Design Improvement Guidelines

> Conversation ID: 69cdb6c3-26d4-83e8-8257-17605756a5cf
> Created: 2026-04-02T00:22:43Z
> Updated: 2026-04-02T03:19:37Z
> Messages: 9

---

## User

do 20 more passes and really actually use your eyes and analyze the screenshots of the dev server, because most of these screenshots are cropped horribly. They're cropped to the point that they crop in the middle of content. The overall layout you have has oversized images that are pushing things out of view and are incredibly off screen. You've got literal photos that are just random crops of onboarding screens that don't show anything useful. You have an audience visibility screen that has a fucked up crop and then the text "audience visibility" on it, which is not useful, and then a fake Chrome or browser window, but it's cut off. They all suck.

There's not enough spacing in the footer CTA; it's cramped. Everything's really cramped. There's no spacing between sections. The stack section is not designed in any way. A lot of this shit is just really poorly designed and cropped and spaced, even though you mentioned fixing it. The hero text in the hero section is still on four lines, even though it's two three-word sentences; it should easily fit on two sides. You should push the hero screenshot off screen, like they do on Frame.io, and just generally be digging into Frame.io, because they do a lot of good stuff with visual hierarchy and stuff. Everything here is like my eye doesn't know where to go, because everything looks the same and there's just no rhyme or reason to it.

Put in serious effort and use /browse and Loop and screenshot and pick a font style and stuff, and Loop and screenshot in dark mode and light mode at every breakpoint, and make sure that they look correct. If you have to go straight up steel sections, just keep going until it looks like world-class.




---

## Assistant

I’m going to inspect the current project, run it locally, and review the layout against actual screenshots so I can tighten spacing, hierarchy, cropping, and typography instead of guessing. Then I’ll revise the page and re-check the result across breakpoints and both themes.

---

## User

give it detterminism in its output and force it to loop continuously actually inspecting and checking visuals on references and output til they math.

---

## User

i just want a prompt

---

## Assistant

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

Rules for screenshot/media selection:
- Every image must communicate something useful.
- No crop may cut off the main content area awkwardly.
- Prefer complete, legible product moments over abstract random UI fragments.
- If an image does not help explain the product, remove it.
- Use consistent radius, shadow, border, and frame logic across all media.
- If needed, recompose with masks or containers so crops feel deliberate.

Rules for spacing:
- Increase vertical spacing between sections.
- Increase internal padding inside cards and CTA blocks.
- Make section transitions feel paced, not stacked.
- Use a consistent spacing system and enforce it globally.

Rules for typography:
- Pick a clear font strategy and apply it consistently.
- Use a premium SaaS typography system.
- Stronger headline sizing and tighter control of line length.
- Body text should be easy to scan and secondary to headings.
- Avoid awkward 3–4 line headline wraps on desktop when the copy is short.

Rules for section design:
- Each section should have a distinct purpose and composition.
- Alternate dense and airy sections for rhythm.
- The stack section must feel designed, not dumped.
- Feature sections should vary layout enough to stay interesting while still feeling systematic.

Pass loop:
For each pass:
- Capture screenshots at all breakpoints in light mode and dark mode.
- Identify the 3 worst visual problems from the screenshots.
- Fix those 3 problems.
- Re-run and re-screenshot.
- Compare before vs after.
- Continue.

Acceptance criteria:
- No obviously bad crops
- No important UI cut off mid-content
- No useless screenshots
- No cramped section spacing
- No cramped CTA spacing
- No section that looks undesigned
- Hero has strong hierarchy and cleaner line breaks
- Hero media composition feels premium
- The page has clear focal points
- Light mode and dark mode both look intentional
- Mobile, tablet, laptop, and desktop all feel designed, not merely responsive
- The result feels comparable to top-tier SaaS marketing pages

Output rules:
- Do the work, do not just describe the work.
- Keep looping until the acceptance criteria are met.
- After finishing, provide:
  1. a concise summary of what changed,
  2. the final screenshots for all breakpoints in light and dark mode,
  3. a short note on what reference patterns from Frame.io influenced the final result.

Failure conditions:
- Claiming a fix without validating it in screenshots
- Leaving awkward crops in place
- Leaving sections cramped
- Leaving the stack section visually raw
- Stopping after superficial cleanup
- Treating screenshot review as optional

Standard:
This should look like a page a strong Series A or Series B product company would confidently ship.
```

If you want, I can also turn this into a version optimized for Claude Code, Cursor, or Codex.

---

## User

{'asset_pointer': 'sediment://file_00000000e80071f5af285c3c3f97e206', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 910015, 'width': 337}
{'asset_pointer': 'sediment://file_000000000f4871f58da711197bbad2fe', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1407627, 'width': 370}
this is the result i got and its clerly not good **What Changed**
- Reworked the hero in [HomePageNarrative.tsx](/Users/timwhite/Jovie/apps/web/components/features/home/HomePageNarrative.tsx) and [home.css](/Users/timwhite/Jovie/apps/web/app/(home)/home.css) so the headline has cleaner line control, the text column is calmer, and the product shot sits more like an off-canvas premium SaaS hero.
- Tightened the proof section so the copy is shorter, the screenshot crop is more deliberate, and the hierarchy favors the product over explanatory text.
- Redesigned the stack section into an authored comparison surface instead of two raw boxes, with clearer labels, better spacing, and stronger contrast between the manual path and the Jovie path.
- Rebuilt the system section to give each product moment a clearer role, with larger media, better caption placement, and less cramped side text.
- Opened up the final CTA so it has real breathing room and reads like a deliberate close, not a leftover footer row.
- Kept the onboarding screenshot honest by using the live shell in [DemoOnboardingShell.tsx](/Users/timwhite/Jovie/apps/web/components/features/demo/DemoOnboardingShell.tsx) and [onboarding-shell.png](/Users/timwhite/Jovie/apps/web/public/product-screenshots/onboarding-shell.png), instead of a decorative fake crop.

**Validation**
- `doppler run --project jovie-web --config dev -- pnpm --filter web exec vitest run tests/unit/home/HomePageNarrative.test.tsx`
- `doppler run --project jovie-web --config dev -- pnpm --filter web exec tsc --noEmit`

**Final Screenshots: Dark**
- 375px  
  ![375 dark](/Users/timwhite/Jovie/apps/web/.final-shots/mobile-375-dark.png)
- 430px  
  ![430 dark](/Users/timwhite/Jovie/apps/web/.final-shots/mobile-430-dark.png)
- 768px  
  ![768 dark](/Users/timwhite/Jovie/apps/web/.final-shots/tablet-768-dark.png)
- 1024px  
  ![1024 dark](/Users/timwhite/Jovie/apps/web/.final-shots/laptop-1024-dark.png)
- 1440px  
  ![1440 dark](/Users/timwhite/Jovie/apps/web/.final-shots/desktop-1440-dark.png)

**Final Screenshots: Light**
- 375px  
  ![375 light](/Users/timwhite/Jovie/apps/web/.final-shots/mobile-375-light.png)
- 430px  
  ![430 light](/Users/timwhite/Jovie/apps/web/.final-shots/mobile-430-light.png)
- 768px  
  ![768 light](/Users/timwhite/Jovie/apps/web/.final-shots/tablet-768-light.png)
- 1024px  
  ![1024 light](/Users/timwhite/Jovie/apps/web/.final-shots/laptop-1024-light.png)
- 1440px  
  ![1440 light](/Users/timwhite/Jovie/apps/web/.final-shots/desktop-1440-light.png)

**Frame.io Influence**
- Off-canvas hero media with a restrained text block instead of a centered SaaS layout.
- Stronger section pacing by alternating airy poster-like sections with denser proof moments.
- Larger, more legible product crops that feel editorial and intentional rather than like random UI fragments.
- A calmer CTA composition with more whitespace and fewer competing elements.



---

## Assistant

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

Concrete fixes you must prioritize:
- The hero headline must have clean line breaks and read as a strong dominant statement.
- The hero screenshot must feel intentionally off-canvas, not like it is covering the layout by accident.
- The hero text block must remain clearly readable and visually primary.
- Product screenshots must show useful product moments only.
- Never crop through the middle of the main content of a screen.
- Never show a fake browser frame partially cut off.
- The “stack” section must be redesigned as an actual composed section, not two plain boxes.
- The CTA section must have generous spacing and a clear visual close.
- Every major section must have a distinct composition and purpose.
- Light mode must be fully designed, not a dark design with inverted colors.

Explicit screenshot acceptance tests:
1. Hero headline line count:
   - 1440px: max 2 lines
   - 1024px: max 3 lines
   - 768px: max 3 lines
   - 375/430px: max 4 lines
2. Hero text must remain fully readable and not visually collide with the hero media.
3. No screenshot may be used if its main UI subject is cropped off, cut in half, or illegible.
4. At least 80 percent of each product image must contain useful product information, not empty chrome or dead space.
5. No section may rely on tiny low-contrast text as its main content.
6. Every section must have enough internal padding to breathe:
   - desktop: minimum 32px internal padding in cards, 96px vertical section spacing
   - tablet: minimum 24px internal padding in cards, 72px vertical section spacing
   - mobile: minimum 20px internal padding in cards, 48px vertical section spacing
7. The stack section must read as designed from 10 feet away: clear contrast, obvious comparison, strong title, strong grouping.
8. The system/onboarding section must show a complete and legible product moment, not a clipped shell.
9. The lower paired feature section must have balanced visual weight and aligned baselines.
10. The final CTA must feel intentional and premium, not like footer leftovers.
11. Light mode and dark mode must both preserve hierarchy, contrast, and spacing.
12. No section should feel like a screenshot dumped under a heading.

Required audit format before each pass:
For each of the 10 worst issues, provide:
- severity: critical / major / moderate
- screenshot and breakpoint
- exact visible problem
- why it hurts the page
- concrete fix to attempt

Required implementation behavior:
- Make actual code changes.
- Prefer changing layout, spacing, sizing, cropping containers, typography scale, and component structure before adding decoration.
- Remove weak screenshots instead of defending them.
- Replace bad crops with complete product moments.
- If a section cannot be saved quickly, simplify it.

Required output after every pass:
- before screenshots
- after screenshots
- the 3 issues addressed
- which acceptance tests now pass or fail
- next 3 issues to address

Forbidden behaviors:
- claiming improvement without screenshot evidence
- stopping after “substantially better”
- keeping obviously bad crops because they are already wired up
- shipping a section because the code is clean
- using decorative gradients or shadows to hide layout weakness
- writing a marketing-style summary of work done
- calling the page premium while it still has obvious visual failures

Final stopping condition:
Stop only when every acceptance test passes in screenshots for both light and dark mode at all required breakpoints.

Final response format:
1. Final pass number
2. Acceptance test checklist with PASS/FAIL
3. Final screenshots for all breakpoints in both themes
4. Exact files changed
5. A brief, unsentimental note explaining the last 5 meaningful visual improvements

If any acceptance test fails, do not present the work as complete. Continue iterating.
```

The main fix is that this prompt forces the agent to fail closed. It cannot hide behind a confident summary.

---

## User

Refine this concept further. Reduce visual noise by 20%. Increase perceived luxury and clarity. Make spacing more disciplined, typography more premium, and interactions more natively iOS. Preserve the grayscale-only system. Improve conversion emphasis on notifications/signup without making the design feel aggressive. Make the mobile layouts feel exceptional enough to ship. this is whtat i got

---

## Assistant

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
   - buttons should feel like iOS-first product controls, not generic web CTAs
   - motion should be subtle, fast, and physically plausible
   - hover/focus/press states should be understated and polished
   - avoid flashy transforms and excessive shadow theatrics

4. Improve conversion emphasis on notifications/signup.
   - make signup and notifications feel like the natural next step
   - do not use aggressive marketing styling
   - use placement, rhythm, contrast, and copy hierarchy
   - prioritize one primary action and one secondary action
   - surface trust and readiness instead of urgency tactics

5. Make mobile exceptional.
   - mobile must not feel like shrunken desktop
   - recompose sections specifically for 375 and 430 widths
   - allow content order to change on mobile if it improves clarity
   - use stronger cropping discipline
   - reduce screenshot height where it causes dead scroll
   - every mobile section should have a clean first read in one viewport

Specific redesign instructions:
Hero:
- Increase text contrast and visual authority.
- Make the headline cleaner and more premium.
- Limit desktop headline to 2 lines if possible.
- Limit mobile headline to 3–4 lines max.
- Push the product media off-canvas with more restraint.
- The hero should sell clarity and control, not raw feature density.
- Introduce a subtle notification/signup emphasis near the hero CTA cluster without turning it into a growth hack block.

Proof / release section:
- The huge screenshot is too dominant.
- Either crop it into a more useful product moment or reduce its footprint materially.
- Pair the image with fewer, sharper proof points.
- Make the section read faster.

Stack section:
- Redesign this entirely.
- It currently feels like a simple comparison box.
- It should feel like an authored premium narrative section.
- Use one strong statement, one concise support line, and a more elegant comparison treatment.
- Make the “before vs after” contrast obvious at a glance.
- Reduce table energy. Increase editorial energy.

System / onboarding section:
- Current composition is too bulky.
- Show one complete, legible, high-value product moment.
- Use more disciplined framing and less dead area.
- On mobile, do not let this become a giant black slab.

Lower feature pair:
- Rebalance the two cards so they do not fight each other.
- Align captions, tighten copy, and normalize image treatment.
- Use one primary feature card and one supporting feature card if needed.

Final CTA:
- Make it feel intentional and premium.
- More breathing room.
- Clearer primary action.
- Better placement of signup / notification intent.
- It should feel like a calm closing invitation, not a leftover footer strip.

Typography direction:
- Use a premium sans strategy.
- Prefer SF-like rhythm, disciplined tracking, and strong optical sizing.
- Headings should feel expensive and controlled.
- Body text should be quieter and more legible.
- Reduce tiny low-contrast text.
- Remove filler microcopy.

Spacing system:
- enforce a stricter spacing scale
- more vertical rhythm between sections
- more internal padding in cards and CTA surfaces
- less random gap variance
- mobile spacing should feel compact but never cramped

Color system:
- grayscale only
- use tonal separation carefully
- no accidental muddy mid-grays
- preserve strong contrast for key text and actions
- light mode must feel designed, not inverted

Screenshot rules:
- Every screenshot must show a useful, legible product moment.
- No screenshot may be awkwardly cut through core UI.
- Avoid giant slabs of dark UI with low information density.
- Prefer fewer screenshots at larger impact.

Validation workflow:
- inspect real screenshots, not code alone
- test dark and light mode
- test 375, 430, 768, 1024, 1440
- do repeated passes until the page feels quieter, clearer, more premium, and more conversion-ready

Acceptance criteria:
- visual noise is materially reduced
- hero feels clearer and more premium
- typography feels more expensive
- signup/notification emphasis is stronger but still tasteful
- mobile feels intentionally designed, not stacked
- stack section feels designed, not tabular
- light mode holds up with clear hierarchy
- no section feels oversized, muddy, or screenshot-dumped

Output:
- implement the changes
- show before/after screenshots
- briefly explain the specific changes that improved luxury, clarity, conversion emphasis, and mobile quality
- do not claim success unless the screenshots clearly support it
```

A tighter version, if you want the model to execute with less drift:

```text
Refine this landing page toward a quieter, more luxurious grayscale aesthetic.

Priorities in order:
1. Reduce visual noise by 20%.
2. Improve hierarchy and spacing.
3. Make typography feel more premium.
4. Make interactions feel natively iOS.
5. Increase tasteful emphasis on signup / notifications.
6. Make mobile exceptional.

Current issues to fix:
- hero text is too weak and buried
- hero media is too dominant
- sections feel screenshot-heavy
- stack section feels like a plain table
- onboarding section is oversized on mobile
- lower feature cards are unbalanced
- CTA is too weak
- light mode lacks clarity

Rules:
- grayscale only
- fewer screenshots, better screenshots
- fewer words, sharper words
- more whitespace, less clutter
- stronger CTA hierarchy without aggressiveness
- mobile must be recomposed, not just resized
- validate with screenshots at 375, 430, 768, 1024, 1440 in light and dark

Deliver:
- improved implementation
- screenshot validation
- concise explanation of what changed and why
```

The first prompt is better if you want stronger art direction. The second is better if the model tends to wander.


**Topic:** [[chatgpt-clusters/design_ux]]
