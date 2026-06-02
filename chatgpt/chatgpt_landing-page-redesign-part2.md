
Mr. White, yes.  
Use this. I’d paste the image in with it.

**Small note:** I assumed you meant **The Orchard** and **AWAL**. If you literally want **AWOL**, swap that line.

```text
You are a senior product designer + frontend engineer working inside the Jovie codebase.

Your task is to polish and ship the landing page hero and trust/logo bar only.

Use browser/designer view, Chrome MCP, screenshots, and iterative refinement loops until the result feels incredibly polished, premium, and high-end.

You should work like a taste-driven design engineer, not just a coder.

CONTEXT
- Jovie is an AI workspace for artists and music teams.
- The current direction is dark mode, premium, minimal, quiet, and expensive.
- The attached image is the current north-star direction. Use it as the main visual reference for structure, mood, and layout.
- Quality bar: Linear, Apple, Frame.io, ChatGPT, and premium modern SaaS.
- Avoid cyberpunk, fake terminal UI, gamer aesthetics, crypto vibes, cheesy glow spam, or over-designed devtool chrome.

PRIMARY GOAL
Get the hero + trust/logo bar to a world-class state.

Do not move on until it feels like a polished premium homepage from a top-tier software company.

SCOPE
Only work on:
1. Hero section
2. Trust/logo bar directly below the hero

Do not redesign the rest of the page yet.

HERO REQUIREMENTS

Overall structure:
- Full-screen hero
- Very dark black / near-black base
- Subtle center glow
- Faint perspective grid in the lower area
- Hero should have rounded bottom corners so that when the page scrolls, it reveals the trust bar beneath in a way that feels similar in spirit to Linear’s rounded section transition
- The hero should feel like a contained premium surface, not just a flat page

Navigation:
- Left: Jovie logo
- Center/right nav links: Product, Solutions, Pricing, Resources
- Right: white pill “Sign in” button
- Nav should be clean, restrained, and expensive
- Good spacing and typography
- No clutter

Hero copy:
Headline:
“Your AI Artist Manager.”

Subheadline:
“Plan releases, create assets, pitch playlists, and promote every drop from one AI workspace.”

Typography:
- Clean, flat, premium
- No 3D text, no bevels, no metallic effects
- Strong hierarchy
- Large headline but restrained
- Perfect optical alignment and spacing
- No clipping, ever

Input/composer:
- Centered under the copy
- Single-line, full pill composer since it is a single-line input
- Feels inspired by the premium simplicity of Linear / ChatGPT
- Placeholder text:
“Ask Jovie…”
- Circular send button on the right
- No extra icons unless they clearly improve the interface
- No terminal metadata
- No command-K hints
- No fake productivity chrome
- Very subtle border and depth
- Quiet, premium, minimal

Workflow pills:
- Tucked directly below the input
- More muted than the input
- Tight spacing
- Carousel-like row with subtle fade masks at the left and right edges
- Pills:
  - Plan a release
  - Generate album art
  - Pitch playlists
  - Build artist profile
  - Analyze momentum
- Pills should feel secondary, polished, and elegant
- Optional subtle hover/focus states
- If implemented as a carousel, make it smooth and refined, not gimmicky

TRUST / LOGO BAR REQUIREMENTS

Section copy:
“Trusted by artists”

Logos/wordmarks to include:
- Universal Music Group
- Armada Music
- The Orchard
- AWAL
- Black Hole Recordings
- disco:wax

Styling:
- White logos/wordmarks on black
- Clean, crisp, premium
- Consistent visual weight across the row
- Balanced spacing
- No muddy gray
- No distorted or hallucinated logos

Important:
- Use official brand assets / SVGs / wordmarks if available
- If exact official logos cannot be used or fetched cleanly, use clean monochrome text lockups instead
- Never invent sloppy fake logos
- Preserve professionalism and legibility

SCROLL / TRANSITION BEHAVIOR
- The trust bar should feel like the next premium section immediately beneath the hero
- The transition from hero to trust bar should feel deliberate and elegant
- The rounded-bottom hero treatment should help create that premium reveal
- The page should feel designed in motion, not just statically composed

DESIGN SYSTEM / VISUAL DIRECTION
Aim for:
- Premium black surfaces
- Soft contrast
- Tight typography
- Refined spacing
- Strong restraint
- Minimal but expensive
- Quiet confidence

Avoid:
- Over-decoration
- Loud gradients
- Too much blur/glow
- Cluttered controls
- Anything that feels cheap or template-like

IMPLEMENTATION STANDARDS
- Desktop first, but ensure mobile also looks excellent
- Use production-quality spacing and typography
- Validate responsiveness
- Ensure nothing clips
- Ensure pill wrapping / overflow behavior is elegant
- Keep code clean and maintainable
- Reuse existing design tokens/components where sensible, but improve them if needed

ITERATION LOOP
You must iterate visually, not just code once.

Loop like this:
1. Inspect current implementation
2. Make improvements
3. Open in browser/designer view
4. Take screenshots
5. Critique the design like a top-tier product designer
6. Fix anything that feels off
7. Repeat until it looks genuinely polished and premium

Critique against this rubric each pass:
- Does it feel expensive?
- Does it feel clean and restrained?
- Is the typography excellent?
- Is the input the clear hero object?
- Does the trust bar feel premium?
- Do the logos look clean and consistent?
- Does the transition feel intentional?
- Does it hold up against Linear-level polish?

Do at least 3 visual refinement passes, more if needed.

DELIVERABLES
Ship the improved hero + trust/logo bar in code.

When done, provide:
1. Short summary of changes made
2. Screenshots of final desktop state
3. Screenshots of scroll transition into trust bar
4. Any notes on logo asset sourcing or substitutions used

SUCCESS CRITERIA
The final result should feel like a homepage for a premium AI software product that serious artists and music teams would trust.

If there is any doubt between “more” and “less,” choose less.
Restraint wins.
```

### My recommendation for the next section
While that agent works, the next section should be:

## **Meet Jovie**
Two-column section:
- **Left:** product conversation / UI mockup
- **Right:** copy about starting with an idea and letting Jovie handle the rest

That fits your existing **meetjovi.com** angle cleanly and gives the page a natural flow:

1. Hero  
2. Trusted by artists  
3. Meet Jovie  
4. Workflow / capabilities  
5. Outcomes / proof  
6. Final CTA

If you want, I can write the **exact prompt for the Meet Jovie section next**.


meetjovie.com not jovi 

analyze our ops repo and recent prs etc so you see where the product is gong and propse the sections for the homepage. 

audit it as an apple marketing director and then as a team of yc group partners. loop til both give you 10/10


Mr. White, corrected: **meetjovie.com**, and the repo already uses **@meetjovie** in homepage Twitter metadata. I analyzed the public `JovieInc/Jovie` repo and recent public PRs I could reach. A separate private “ops” repo was not available through this chat, so this is based on the public repo and PR activity.

## Product readout

The current repo still describes Jovie as a **modern artist profile and link-in-bio platform**, with key features around artist profiles, link-in-bio, tipping/payments, analytics, mobile optimization, dark mode, and feature flags. The current homepage V2 copy is also still anchored around “artist profiles, smart links, fan capture, and reactivation.” citeturn317806view0turn305771view0

Recent PRs show the product moving toward a broader **AI workspace / operating system for artists**: chat-driven profile edits and actions, command palette navigation, release planning, release-page workflows, vertical teaser reel generation, profile view conversion architecture, audience capture/reactivation, and GTM/outreach machinery. The release/reels PR explicitly ties to a “release-plan roadmap” and adds a flag-gated 9:16 teaser MP4 generator for releases; the chat PR fixes deterministic assistant replies for bio, display name, links, avatar, and feedback; the command palette PR exposes Profile, Releases, Tasks, Audience, recent threads, and actions through global ⌘K. citeturn704952view1turn758333view0turn704952view2

**Conclusion:** the homepage should stop feeling like “link in bio for musicians” and become **“AI Artist Manager” as the command layer**, with profiles, release pages, fan capture, reels, and analytics as proof of substance.

# Final homepage structure

## 1. Hero

**Headline:**  
**Your AI Artist Manager.**

**Subtitle:**  
Plan releases, create assets, pitch playlists, and promote every drop from one AI workspace.

**Input placeholder:**  
Ask Jovie…

**Workflow pills:**  
Plan a release · Generate album art · Pitch playlists · Build artist profile · Analyze momentum

**Purpose:**  
This makes the product feel bigger than smart links. It sells the command layer.

**Design:**  
Keep the current premium black hero, full viewport, white Sign in pill, rounded-bottom hero panel, faint grid, subtle centered glow, no eyebrow, no terminal chrome.

## 2. Trust bar

**Label:**  
Trusted by artists

**Logo row:**  
Universal Music Group · Armada Music · The Orchard · AWAL · Black Hole Recordings · disco:wax

**Design:**  
White logos on black, monochrome, consistent optical weight, Linear-style spacing, subtle dividers only if needed.

**Important:**  
Use these logos only if there is a legitimate artist/user/customer/partner basis. Apple and YC would both punish fake trust. If usage is informal, make the label softer: **“Used by artists connected to”** or **“Built with workflows from artists across”**.

## 3. Meet Jovie

This should be the first real section after the logo bar.

**Section badge:**  
A small premium pill: `Meet Jovie`

**Headline:**  
**Start with an idea. Let Jovie handle the release.**

**Body:**  
Tell Jovie what you’re dropping. It turns the idea into a plan, assets, pitches, profile updates, and next steps.

**Visual:**  
Two-column layout.

Left: a polished dark product mock showing a chat thread:

User:  
“Help me plan my next release.”

Jovie response card:
- Release timeline
- Artwork direction
- Playlist pitch
- Smart link / profile update
- Momentum checklist

Right: concise copy and 4 bullets:
- Plan the rollout
- Create campaign assets
- Update your artist profile
- Track what moves

**Why this section:**  
It explains the whole product without making users parse a feature grid.

## 4. The release workflow section

**Headline:**  
**One release. Every move mapped.**

**Body:**  
Jovie turns a song, date, and goal into the operating plan around the drop.

**Visual:**  
A horizontal timeline with premium cards:

1. **Plan**  
Release date, rollout calendar, task list.

2. **Create**  
Album art direction, captions, teaser assets.

3. **Pitch**  
Playlist pitch, press angle, partner outreach.

4. **Launch**  
Release page, smart links, fan capture.

5. **Learn**  
Momentum, clicks, fans, next move.

**Repo tie-in:**  
This maps directly to current release pages, release planning, fan capture/reactivation, and the new reel-generation direction. The recent reel PR adds release-page teaser generation with a `Generate Reel` flow, background processing, and downloadable MP4 output. citeturn704952view1

## 5. Artist profile section

**Headline:**  
**A profile built around conversion.**

**Body:**  
Every tap should move a fan closer to listening, subscribing, paying, contacting, buying tickets, or coming back for the next release.

**Visual:**  
Large premium artist profile preview with a right-side vertical menu.

Use the actual conversion-first sequence from the profile registry:

Listen · Subscribe · Pay · Contact · Tour · Releases · About · Share

The profile registry PR says that order was locked during design review and centralizes metadata, visibility predicates, analytics events, and menu order. citeturn330957view0

**Why this section:**  
This grounds the AI story in a real surface you already have. It shows that Jovie is more than a chatbot.

## 6. Creative assets section

**Headline:**  
**Create the campaign around the song.**

**Body:**  
Generate the assets that make a release feel ready: cover directions, visual treatments, playlist pitches, captions, and teaser reels.

**Visual:**  
A dark editorial grid with 3 cards:

- **Album art direction**  
Moodboard, palette, visual brief.

- **Playlist pitch**  
Short pitch, genre notes, audience angle.

- **Teaser reel**  
9:16 release teaser preview.

**Why this section:**  
This validates the “generate album art” and “pitch playlists” hero pills. It also aligns with the 9:16 teaser reel roadmap. citeturn704952view1

## 7. Momentum section

**Headline:**  
**Know what to do next.**

**Body:**  
Jovie turns profile activity, release behavior, and fan capture into the next best move.

**Visual:**  
A clean analytics panel:
- Release momentum score
- Top fan actions
- Best-performing links
- Geo / audience signals
- Recommended next action

**Copy examples inside UI:**
- “Playlist pitch is outperforming social links.”
- “Fans in Berlin are clicking tour links.”
- “Convert repeat visitors into subscribers.”
- “Run a second-week push.”

**Why this section:**  
This is where the product starts feeling expensive. Artists do not only want content. They want judgment.

## 8. Team command center section

**Headline:**  
**Built for artists, managers, and teams.**

**Body:**  
Jovie keeps the release, profile, audience, and creative work in one place.

**Visual:**  
Show a command-center interface:
- Sidebar: Profile, Releases, Tasks, Audience
- Chat thread
- ⌘K command palette overlay
- Recent release tasks

The command palette PR already supports route jumping, recent threads, and actions across Profile, Releases, Tasks, and Audience, which makes this section credible. citeturn704952view2

**Why this section:**  
This is the “hundreds per month” justification. It makes Jovie feel like workspace software, not a single-purpose artist tool.

## 9. Fan capture / reactivation section

**Headline:**  
**Every release builds the next one.**

**Body:**  
Capture the fans who show up, then bring them back when the next drop, show, or campaign matters.

**Visual:**  
Split system diagram:
- Fan visits profile
- Fan opts in / clicks / supports
- Jovie remembers context
- Jovie recommends next action
- Artist reactivates the right audience

Current homepage V2 copy already emphasizes capturing fans and reactivating them for future releases or shows. citeturn305771view0

**Why this section:**  
This is the business model moat. Profiles and links are commodities; captured audience plus automated follow-through is a system.

## 10. Proof / case study strip

**Headline:**  
**Release workflows from artists in motion.**

**Body:**  
Use real examples when available. Keep this section sparse.

**Cards:**  
- Artist preparing a single
- Manager running multiple releases
- Label/team coordinating campaign assets

Each card should show:
- Input: “Upcoming single in 3 weeks”
- Output: release plan, pitch, profile update, asset list
- Result: only real metric if available

**YC note:**  
Use actual numbers here as soon as you have them. Without numbers, make this section visual proof, not fake traction.

## 11. Pricing / CTA

**Headline:**  
**Run your next release with Jovie.**

**CTA composer:**  
Repeat the hero input.

Placeholder:  
Ask Jovie…

Pills:
- Plan my next release
- Build my artist profile
- Pitch my single
- Create campaign assets

**Secondary CTA:**  
View pricing

**Why this section:**  
End where you began: command input. The homepage should train users that Jovie starts from intent.

# Final page order

1. Hero  
2. Trusted by artists logo bar  
3. Meet Jovie  
4. One release. Every move mapped.  
5. A profile built around conversion.  
6. Create the campaign around the song.  
7. Know what to do next.  
8. Built for artists, managers, and teams.  
9. Every release builds the next one.  
10. Proof / case studies  
11. Final CTA + footer  

# Apple marketing director audit

**Pass 1 score: 7/10**  
Too many raw features. The product sounded like a dashboard with AI added.

**Fix:**  
Lead with a single human story: artist has a release, Jovie manages the work around it.

**Pass 2 score: 9/10**  
The story is strong, but the page risks becoming too SaaS-grid-heavy.

**Fix:**  
Make the first three sections cinematic and editorial: Hero → Trusted by artists → Meet Jovie. Delay dense feature grids until the user understands the product.

**Final Apple score: 10/10**  
The final structure has a clear emotional arc: command, trust, meeting the product, then seeing the system. It feels premium because it shows less, with more confidence.

# YC group partner audit

**Pass 1 score: 7/10**  
“AI Artist Manager” is memorable, but investors/users need to know what it actually does.

**Fix:**  
Show concrete jobs: plan a release, create assets, pitch playlists, update profile, capture fans, analyze momentum.

**Pass 2 score: 8.5/10**  
The workflow is clear, but the moat needs to be clearer.

**Fix:**  
Frame Jovie as the system of record around an artist’s release cycle: profile, release, tasks, audience, assets, analytics.

**Final YC score: 10/10**  
The final page sells a wedge and a platform: start with release planning, expand into artist operations. The workflow pills also become GTM instrumentation because they reveal which user intent converts.

# Agent prompt for the rest of the homepage

```text
You are a senior product designer and frontend engineer working in the Jovie repo.

Correction:
The domain is meetjovie.com. Do not use meetjovi.com.

Your task:
Build out the homepage below the hero and trust/logo bar using the following final section architecture:

1. Hero — already being refined separately
2. Trusted by artists logo bar — already being refined separately
3. Meet Jovie
4. One release. Every move mapped.
5. A profile built around conversion.
6. Create the campaign around the song.
7. Know what to do next.
8. Built for artists, managers, and teams.
9. Every release builds the next one.
10. Proof / case studies
11. Final CTA + footer

Design standard:
- Premium dark mode
- Linear / Apple / Frame.io level polish
- Minimal, quiet, expensive
- Dark surfaces, soft borders, subtle indigo light
- Flat typography
- No fake terminal chrome
- No cyberpunk
- No loud neon
- No generic SaaS template cards
- Restraint wins

Product story:
Jovie is Your AI Artist Manager.
It helps artists and music teams plan releases, create assets, pitch playlists, update profiles, capture fans, and understand what to do next.

Important product direction from repo:
- Jovie currently has artist profiles, smart links, fan capture, reactivation, release pages, analytics, and profile conversion flows.
- Recent product work includes chat-driven profile actions, command palette navigation, release workflows, 9:16 teaser reel generation, profile view registry, and GTM/outreach infrastructure.
- The homepage should position Jovie as the AI command layer over the artist release cycle.

Section details:

MEET JOVIE
Headline:
"Start with an idea. Let Jovie handle the release."

Body:
"Tell Jovie what you’re dropping. It turns the idea into a plan, assets, pitches, profile updates, and next steps."

Visual:
Two-column layout.
Left side: premium dark chat/product mock.
Right side: short copy with four bullets:
- Plan the rollout
- Create campaign assets
- Update your artist profile
- Track what moves

ONE RELEASE. EVERY MOVE MAPPED.
Headline:
"One release. Every move mapped."

Body:
"Jovie turns a song, date, and goal into the operating plan around the drop."

Visual:
Horizontal timeline:
Plan → Create → Pitch → Launch → Learn

A PROFILE BUILT AROUND CONVERSION.
Headline:
"A profile built around conversion."

Body:
"Every tap should move a fan closer to listening, subscribing, paying, contacting, buying tickets, or coming back for the next release."

Visual:
Large artist profile preview with conversion-first menu:
Listen, Subscribe, Pay, Contact, Tour, Releases, About, Share

CREATE THE CAMPAIGN AROUND THE SONG.
Headline:
"Create the campaign around the song."

Body:
"Generate the assets that make a release feel ready: cover directions, visual treatments, playlist pitches, captions, and teaser reels."

Visual:
Three cards:
- Album art direction
- Playlist pitch
- Teaser reel

KNOW WHAT TO DO NEXT.
Headline:
"Know what to do next."

Body:
"Jovie turns profile activity, release behavior, and fan capture into the next best move."

Visual:
Analytics/momentum panel with recommendations.

BUILT FOR ARTISTS, MANAGERS, AND TEAMS.
Headline:
"Built for artists, managers, and teams."

Body:
"Jovie keeps the release, profile, audience, and creative work in one place."

Visual:
Command center interface with sidebar, chat, recent threads, and a subtle command palette overlay.

EVERY RELEASE BUILDS THE NEXT ONE.
Headline:
"Every release builds the next one."

Body:
"Capture the fans who show up, then bring them back when the next drop, show, or campaign matters."

Visual:
System diagram:
Fan visit → opt-in/click/support → Jovie remembers → recommended action → reactivation

PROOF / CASE STUDIES
Headline:
"Release workflows from artists in motion."

Do not invent fake metrics.
Use placeholder proof cards only if real metrics are unavailable.
Design them as workflow examples, not fake traction.

FINAL CTA
Headline:
"Run your next release with Jovie."

Use the same premium input/composer pattern from the hero.
Placeholder:
"Ask Jovie…"

Pills:
- Plan my next release
- Build my artist profile
- Pitch my single
- Create campaign assets

Iteration loop:
Use browser/designer view or Chrome MCP.
After every pass, screenshot and critique the page against:
- Does it feel expensive?
- Is the story clear within 10 seconds?
- Does each section reveal one new part of the system?
- Does it avoid generic SaaS cards?
- Does the product feel worth hundreds per month?
- Does it make Jovie feel like an artist operating system, not a link-in-bio tool?

Do at least 3 visual passes before stopping.
Final output should feel like a world-class homepage for a premium AI product for serious artists and music teams.
```

My strongest recommendation: **do not let the page become a generic feature list.** The winning story is: **give Jovie the release; Jovie runs the work around it.**


{'asset_pointer': 'sediment://file_00000000680c71f7bd673cca73bb56f2', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1244, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 484076, 'width': 1599}
artist profile seciton i want like this. each card is high res iphone screen shot of like they pay drawer and the word Get Paid. next card is Sell Out with a screenshot of the tour dates mode etc for all mdoes.

make a mock up of this. 


**Topic:** [[chatgpt-clusters/design_ux]]
