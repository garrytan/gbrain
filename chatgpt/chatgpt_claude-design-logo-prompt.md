---
conversation_id: 69eaa8b7-431c-83e8-9ad7-8e3f850d540a
created: 2026-04-23
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 5
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Claude Design Logo Prompt
type: guide
updated: 2026-04-23
---

# Claude Design Logo Prompt

**Related:** [[coding_ai]]

> Conversation ID: 69eaa8b7-431c-83e8-9ad7-8e3f850d540a
> Created: 2026-04-23T23:18:15Z
> Updated: 2026-04-23T23:59:42Z
> Messages: 5

---

## User

I’m going to try Claude’s new design tool. Claude Design was released last week to design a logo for Jovie, and I really love the linear logo. It works in dark mode, in light mode, and it makes a nice app icon. They offer flat versions as well as 3D versions. It’s really simple and concise.

I’m going to attach the current Jovie logo. What I like about it is that it kind of conveys a flywheel-like motion, which fits the idea of faster iteration cycles from musicians. It’s like a flywheel because we capture all the fans from release pages, they link in bio, and all these emails and other elements that we control in this whole traffic journey. If you buy tickets, merch, listen to music, or watch music videos for an artist, you go through the Jovie link; then we notify those fans about different things. Those fans come back through more Jovie links; we gain more data on them; we notify them about more specific things, and it creates this flywheel. It’s also like a growth flywheel, you know what I mean?

That was the inspiration, too, a single, singular stroke circle icon, plus the wordmark Jovie icon. But they don’t really go together. I’d like to see some design options for a better version of it. Can you give me a great Claude design prompt? Actually, look at the best prompt instructions from Anthropic right now for Claude Design, and then make sure you specify to put a large number of options on a canvas that we can iterate through. Don’t just give me one. Make it Apple-type in aesthetic, where it’s incredibly simple and works no matter what color background you put it on; it should invert easily from white to black for dark mode and light mode, etc.

---

## Assistant

Mr. White, I’ll verify Anthropic’s current design guidance, inspect the attached Jovie logo/SVG structure, then give you a Claude-ready prompt for many simple, invertible logo directions on one canvas.

---

## Assistant

Mr. White, I checked Anthropic’s current Claude Design launch notes and prompting docs. Claude Design is explicitly built for broad design exploration, starting from prompts/uploads/web capture, then refining through conversation, comments, direct edits, and controls; Anthropic’s prompt guidance favors clear success criteria, structured sections/XML-style tags, explicit output instructions, and self-checks. citeturn573408view0turn527095search0turn527095search1

I also inspected the attached SVGs: the current Jovie icon is a solid circular flywheel mark in `#635AFF` with a central negative-space counter and a top inlet/swoosh; the wordmark is a heavy custom path wordmark. The prompt below pushes Claude to preserve the flywheel/growth-loop idea while forcing many clean, invertible, Apple-grade logo explorations on one canvas.

Paste this into Claude Design **after attaching the current Jovie SVG logo files**:

```text
<role>
You are a senior brand identity designer and logo systems designer. Build the designs directly on the Claude Design canvas. Do not only describe ideas. Create a large visual exploration canvas that I can iterate through.
</role>

<context>
Brand: Jovie
Website/product context: Jovie is a music-tech growth platform for artists and music teams.

Jovie controls the fan traffic journey through release pages, link-in-bio pages, email capture, tickets, merch, music/video links, and fan re-engagement. Fans move through Jovie links, Jovie learns more about them, then artists can notify those fans about increasingly relevant drops, tours, merch, videos, and releases. The brand idea is an owned fan-data growth flywheel: faster iteration cycles, more fan insight, more targeted reactivation, more traffic back through Jovie.

Current attached logo:
- Keep the useful idea: circular/flywheel motion, simple singular mark, strong app-icon potential.
- Improve the weak point: the icon and wordmark currently feel like separate systems.
- The current icon uses a circular flywheel-like shape with inner negative space and a top motion cut/inlet.
- The current wordmark is heavy and custom; explore a wordmark that shares the icon’s geometry, stroke logic, curves, spacing, and terminal style.
</context>

<creative_direction>
Create a logo system that feels:
- Apple-grade in restraint, polish, and simplicity.
- Premium, minimal, precise, and timeless.
- Simple enough to work in one color.
- Strong as an app icon.
- Strong as a horizontal lockup.
- Strong in dark mode and light mode.
- Easy to invert from black to white.
- Clean enough to work on any background: white, black, neutral gray, purple, and busy/photo-like backgrounds.
- Modern music-tech, without obvious music clichés.

Primary conceptual cues:
- Growth flywheel.
- Iteration loop.
- Circular motion.
- Owned traffic journey.
- Smart link / return path.
- Fan feedback loop.
- Data loop.
- Fast cycles.
- Optional subtle hint of “J” or “Jovie,” but keep the mark abstract and ownable.

Avoid:
- Music notes, guitars, headphones, vinyl records, equalizer bars, generic play buttons.
- Generic loading spinners.
- Generic power-button marks.
- Overly complex gradients.
- Fragile thin details that fail at small sizes.
- Logos that only work because of color.
- Anything that copies Apple or another existing logo.
</creative_direction>

<output_required>
Create one large canvas titled: “Jovie Logo Exploration — Round 1”.

On the canvas, create these sections:

1. CURRENT LOGO REFERENCE
Place the attached current icon and wordmark at the top-left as reference only.
Add 3 concise notes:
- what to preserve
- what to fix
- what the new system must prove

2. LARGE OPTION GRID
Generate at least 64 distinct logo mark options in a clean thumbnail grid.
Organize them into 8 families with 8 variants each:

Family A — Pure monoline flywheel marks
A1–A8: single-line or near-single-line circular motion marks.

Family B — Solid-to-linear evolution
B1–B8: cleaner evolutions of the current filled circular icon, with better negative space and more precise geometry.

Family C — J-as-loop marks
C1–C8: subtle “J” embedded into a circular flywheel or return-path mark.

Family D — Link/fan journey marks
D1–D8: abstract link, loop, funnel, or traffic-path marks that imply fans cycling through Jovie links.

Family E — Negative-space Jovie marks
E1–E8: marks where the inner counter, aperture, or terminal creates a subtle J, O, or “jo” relationship.

Family F — App-icon-first marks
F1–F8: extremely simple marks designed to be recognizable at iOS app-icon scale.

Family G — Wordmark-integrated marks
G1–G8: marks that directly harmonize with a redesigned “Jovie” wordmark, including versions where the icon geometry informs the J, o, i dot, or e.

Family H — Frontier/minimal 3D-ready marks
H1–H8: flat vector marks that could become subtle 3D/material icons later, while still working perfectly as flat one-color logos.

For every option:
- Label it clearly, e.g. A1, A2, B1.
- Show the mark in black on white.
- Show the inverted mark in white on black.
- Use only vector-like forms.
- Keep each mark simple enough to describe in one sentence.
- Add a one-line rationale under each family, not under every mark.

3. WORDMARK EXPLORATIONS
Create at least 16 “Jovie” wordmark options.
Use Title Case “Jovie” as the main brand form.
Also include a small lowercase “jovie” exploration row.
Explore:
- rounded geometric sans
- custom optical curves
- friendly premium tech
- tighter Apple-like precision
- wordmarks where the “o” or “J” subtly echoes the flywheel icon
- wordmarks that feel visually related to the mark

4. LOCKUP TESTS
Select the strongest 16 icon candidates from the grid.
For each, create:
- icon only
- horizontal lockup: icon + Jovie
- stacked lockup
- app icon crop
- favicon-size test

Use consistent spacing rules:
- Icon-to-wordmark spacing: test 0.5x, 0.75x, and 1x of icon width.
- Wordmark optical baseline aligned to icon center.
- Stroke/weight relationship between icon and wordmark must feel intentional.

5. BACKGROUND / INVERSION STRESS TEST
For the top 16 candidates, show each on:
- white background
- black background
- light gray background
- Jovie purple `#635AFF`
- dark charcoal
- noisy/photo-like placeholder background

Each candidate must remain legible and premium in pure black and pure white.
Purple is optional accent, not required for recognition.

6. SCALE STRESS TEST
For the top 16 candidates, show:
- 16 px
- 24 px
- 32 px
- 64 px
- 128 px

Eliminate or flag candidates that lose recognizability at small sizes.

7. FLAT + 3D PREVIEW
For the best 8 candidates only:
- Create the primary flat vector version.
- Create a subtle 3D/material preview version.
- Keep the 3D treatment restrained: soft depth, simple lighting, no decorative excess.
- The flat version is the source of truth.

8. SCORING MATRIX
Create a compact score table for the best 16 candidates.
Score 1–5 on:
- Simplicity
- Flywheel/growth-loop meaning
- App icon strength
- Wordmark cohesion
- Distinctiveness
- Small-size legibility
- One-color robustness
- Premium/Apple-grade feel

Then identify the top 8 candidates for iteration.
For each top candidate, provide one sentence:
- why it works
- what should be refined next
</output_required>

<style_constraints>
Use this design language:
- Clean geometry.
- Rounded terminals where appropriate.
- Optical balance over mathematical symmetry.
- Minimal curves.
- No extra decoration.
- No reliance on gradients.
- No heavy shadows in the flat set.
- Simple enough to work as SVG.
- Memorable silhouette.
- Works as black/white first, color second.
- Primary accent color: `#635AFF`, used sparingly.
</style_constraints>

<process>
First, analyze the attached current logo files visually.
Then create the canvas with all requested sections.
Prioritize producing the broad option set before choosing favorites.
Do not ask clarifying questions before creating Round 1; make reasonable design assumptions and proceed.
Keep written explanations concise so the canvas stays primarily visual.
</process>

<final_check>
Before finishing, verify:
- There are at least 64 logo mark options.
- There are at least 16 wordmark options.
- Each top candidate is tested in black, white, dark mode, light mode, and app icon form.
- The best candidates feel like one coherent brand system, not an icon pasted next to a mismatched wordmark.
- The final canvas gives me many directions to choose from, not a single finished answer.
</final_check>
```

Use this follow-up after Claude generates the first canvas:

```text
Take candidates [insert labels] and create Round 2. Keep their core geometry, then produce 8 tighter refinements per candidate. Focus on optical balance, wordmark cohesion, small-size legibility, and black/white inversion. Add one final row showing the strongest candidate as: app icon, website nav logo, release page header, link-in-bio header, email footer, and social avatar.
```

---

## User

i just thought of maybe it like a linear logo but rotated so its gin up to the right like a speaker? almost spotify but not green but made dicint so its not spotify

---

## Assistant

Yes, Mr. White. That’s a strong direction.

The idea is:

- **up-and-to-the-right energy**
- **clean like Linear**
- **resonant like a speaker / signal**
- **flywheel motion**
- **simple enough for app icon**
- **clearly its own mark, not Spotify**

Here’s the updated direction to add to the Claude Design prompt:

```text
Add this additional concept direction:

PRIMARY NEW DIRECTION
Explore a logo family inspired by the emotional feel of the Linear logo’s simplicity and confidence, but for Jovie.

The mark should feel:
- tilted or rotated upward to the right
- energetic and progressive
- like motion, momentum, resonance, or a speaker emitting signal
- like a growth loop or flywheel
- compact and iconic
- highly legible at app-icon scale

Visual idea:
A concise abstract mark that suggests a rising circular or semi-circular motion, angled up to the right, with a sense of signal, resonance, or rotation. It can feel adjacent to a speaker cone, orbit, pulse, or accelerating flywheel.

Important:
The mark must be clearly distinct from Spotify.
Do not create:
- three parallel curved bands
- a direct sound-wave-in-circle symbol
- a generic broadcast icon
- a clone of the Linear logo
- anything that reads as Spotify at first glance

Distinctiveness goals:
- one singular memorable silhouette
- ownable negative space
- asymmetrical geometry
- one decisive motion gesture
- subtle hint of a “J” is welcome if elegant
- feels premium and intelligent
- works in one color
- easy black/white inversion
- strong as a favicon and iOS app icon

Add a new exploration family:

Family I — Rising Resonance Marks
I1–I12:
Create 12 logo mark options based on this idea:
- rotated upward-right
- abstract speaker / resonance / flywheel feel
- simple, geometric, modern
- distinct from Spotify and Linear
- elegant enough to feel Apple-grade

For each of these 12 options:
- show black on white
- show white on black
- show tiny app-icon preview
- show one sentence on what makes it distinctive

Then select the best 6 from Family I and pair each with 4 wordmark directions that feel unified with the mark.
```

And if you want a tighter one-line concept for Claude, use this:

**“Design Jovie as a minimal upward-right flywheel/resonance mark — clean like Linear, suggestive of a speaker or signal, app-icon strong, black/white first, and clearly distinct from Spotify.”**

If you want, I can also rewrite the **entire full Claude Design prompt** with this new direction baked in so you can paste one clean version.


**Topic:** [[chatgpt-clusters/coding_ai]]
