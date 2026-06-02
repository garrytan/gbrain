---
conversation_id: 69cdc251-77d0-83e8-81f9-55c66fb3d336
created: 2026-04-02
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 5
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Link-in-Bio Design for Musicians
type: guide
updated: 2026-04-02
---

# Link-in-Bio Design for Musicians

**Related:** [[design_ux]]

> Conversation ID: 69cdc251-77d0-83e8-81f9-55c66fb3d336
> Created: 2026-04-02T01:12:11Z
> Updated: 2026-04-02T07:05:25Z
> Messages: 5

---

## User

Alright, you're building a world-class link-in-bio product specifically for musicians. Now we want to follow the general Apple principles here where the platform is agnostic to design. It's opinionated, but it's effectively agnostic, right? You have light mode and dark mode, and they don't have any opinionated color to them. They're effectively just grays and blacks, light grays, and whites, and they create a nice, clean visual hierarchy, and it's well designed.
- You've got the artist name.
- You've got a play button. The play button opens up a drawer, native iOS style, that has all of the different social media platforms they belong to, scrollable using Versal Edge, with your pre-sorting for who's which ones first.
- There's very simple navigation for sending money.
- The tip screen has the toast-style three predefined values: $3, $5, and $7, a little tiny custom button that then opens up an input for you to enter a custom amount, and a "Continue with Venmo" button or "Continue with Apple Pay" button that can be stacked on top of each other, both enabled, or just solo, one is enabled. That can pop up maybe as a drawer or be integrated into the page, and it effectively lets you know that person sent money the clean way.
- There are tour dates that display in a scrollable drawer format as well.
- There's a clean, pill-shaped input that lets you turn on notifications, which is basically an email subscription, but we're framing it as platform notifications. You put in your email or your phone, with one button toggle on the left side of the input to change that.
- There's a clean animation that takes you to the next step, where it asks for your name: "What should we call you?" and then enter your first name, your last name, your birthday, and "What's your?" "Let's just: Where do you listen to music?"
- It then walks through all the screens: "How do I have music?" "Pick your favorite DSP" so that way we can customize what new platform we send them links to.
- There's a contact button, a drop-down that they can scroll through, that has been a booking manager for America, your booking agent from Canada for Spin Artists Agency, your booking agent for Europe for the David Lewis productions, and your Oceanic booking agent, which is going to be CAA, and then your manager, which is going to be Lucas Milk and Honey, and then you've got your fan contact.
- You've got a big hero image that's your profile image that we've ingested now. We can't make it too big, because we're getting them from Spotify, so they might not be great quality. We don't want to blow up too big. It's got to be mobile-first looking for one mobile, but then also on the top, and it should be very Apple-native design. Maybe it's using liquid glass-inspired design, but it should look incredibly modern, incredibly clean, and minimal, with as few distractions as possible.
The core focus here is to capture people's info and get them on the list so that true fans always get notifications when new music comes out. The second priority is to be able to then send them to a music platform to check out music now. If there's a new release out, we want a little pin in the slot where you have a rectangular item. On the left is a square image with rounded corners, and on the right is a call-to-action button, and then there's a little bit of title and a little bit of description. That can just be "Latest Release" and what the release album work is, and then it's now. It could be a tour date based on their location, because we'll have that from Versal Edge and it gives them the close location, and it just says "Get Tickets". It could be a merch item from Shopify, and it's like "Shop Now". Those can be pinned, and then the system can dynamically show or hide them.
That's it. We need a super clean, incredible one sports verified state, and it should say "Artist" on them. It shouldn't include any other descriptors, just "Artist". There is just one dark mode design and one light mode design for mobile, and the desktop design should look incredible too, but it's secondary to the mobile one.

give me a prompt optimized for google stitch to buidl this with gemini pro 3.1

---

## Assistant

I’m checking the current Google Stitch positioning and any prompt-format specifics so the prompt matches the tool well.

---

## Assistant

Mr. White,

Stitch is currently positioned as a natural-language UI design tool for creating high-fidelity interfaces, and Gemini 3.1 Pro is positioned by Google for more complex, reasoning-heavy tasks. That means the prompt should be highly structured, explicit about hierarchy, states, and screen behavior. citeturn954072search0turn954072search1

Use this:

```text
Design a world-class mobile-first link-in-bio product for musicians.

Platform:
- iPhone-first responsive web app with an Apple-native feel.
- Create 2 primary visual themes only: Light Mode and Dark Mode.
- Desktop should also look premium and polished, but mobile is the priority.
- Output high-fidelity product UI, not a marketing site.

Product goal:
- Primary goal: capture fan contact info so true fans always get notifications about new music.
- Secondary goal: send fans to the artist’s preferred music platforms immediately.
- Tertiary goals: tips, tour dates, merch, and contact access.

Design direction:
- Apple-inspired visual system.
- Design-agnostic platform: neutral grayscale base, no brand-heavy color system.
- Clean visual hierarchy using whites, light grays, dark grays, blacks, subtle translucency, soft depth, and modern glass-like layering.
- Minimal, premium, modern, calm, highly legible.
- Use liquid-glass-inspired surfaces sparingly.
- Avoid clutter, noisy gradients, loud shadows, playful illustrations, or consumer-social styling.
- The product should feel trusted, elegant, and native to iOS.
- Rounded corners, refined spacing, crisp typography, smooth micro-interactions.
- Everything should feel fast and frictionless.

Core page:
Create the artist profile page with these elements in priority order:

1. Header
- Small verified state.
- Label should only say: “Artist”
- No other descriptors.
- Artist name is the main title.
- Hero image is a profile image sourced from Spotify quality assets, so keep it visually prominent but not oversized.
- The image should feel premium without exposing low resolution.

2. Primary music action
- A play button near the artist name.
- Tapping the play button opens a native iOS-style bottom drawer.
- The drawer contains the artist’s music and social platforms in a vertically scrollable list.
- Use smart default sorting so the most important platforms appear first.
- Assume platform order can be dynamically configured.

3. Dynamic pinned card slot
- A single prominent rectangular pinned module below the header.
- Left side: square thumbnail with rounded corners.
- Right side: title, short description, and one CTA button.
- This slot can dynamically show one of the following:
  a) Latest Release → CTA: “Listen Now”
  b) Nearby Tour Date → CTA: “Get Tickets”
  c) Merch Item → CTA: “Shop Now”
- Design the component so content can be shown or hidden automatically.
- The component should feel system-level, premium, and reusable.

4. Notifications capture
- A clean pill-shaped input for “platform notifications”.
- This is effectively email/SMS collection, but framed as notifications.
- Include a small left-side toggle to switch between email and phone.
- Keep the UI extremely simple and trusted.
- This should be one of the most important interactions on the page.

5. Fan onboarding flow
Create a smooth stepped flow after notification signup with elegant transitions.
Flow screens:
- Screen 1: “What should we call you?”
  Inputs: first name, last name, birthday
- Screen 2: “Where do you listen to music?”
  Prompt the user to pick their favorite DSP / music platform
- The flow should feel native, progressive, light, and low-friction.
- Use simple card-like forms, large tap targets, strong clarity, and subtle forward motion.

6. Tips / send money
- Add a simple navigation/action for sending money.
- Tapping opens a clean drawer or integrated panel.
- Show 3 predefined amounts as toast-style pill buttons: $3, $5, $7
- Include a small “Custom” option that reveals an input for another amount.
- Include payment CTAs:
  - Continue with Venmo
  - Continue with Apple Pay
- Show either both stacked, or only one if the artist has only one enabled.
- The experience should feel tasteful, trusted, and frictionless.

7. Tour dates
- Add a tour dates section that opens in a scrollable native-style drawer.
- Make it feel easy to browse on mobile.
- Prioritize nearby location context if available.

8. Contact drawer
- Add a contact button that opens a scrollable dropdown or drawer with:
  - Booking Manager — America
  - Booking Agent — Canada — Spin Artists Agency
  - Booking Agent — Europe — David Lewis Productions
  - Booking Agent — Oceania — CAA
  - Manager — Lucas, Milk and Honey
  - Fan Contact
- This should be well organized, calm, and easy to scan.

Interaction principles:
- Use native-feeling bottom drawers, pill controls, segmented toggles, and tasteful transitions.
- Every interaction should feel iOS-native, premium, and modern.
- Prioritize thumb reach, one-handed use, and smooth state changes.
- Use subtle motion and blur to reinforce hierarchy.
- Keep transitions polished and minimal.

Component behavior:
- Support dynamic show/hide for pinned cards, payment options, tour data, and platform ordering.
- Build reusable components and consistent spacing rules.
- Maintain strong hierarchy across all states.
- Make the verified artist identity feel premium and trusted.

Visual system:
- Neutral palette only.
- No bright accent colors unless absolutely necessary for state clarity.
- Typography should feel modern, premium, and restrained.
- High contrast where needed, soft surfaces where appropriate.
- Use a lot of breathing room.
- Use refined pill shapes and rounded rectangles.
- Strong emphasis on cleanliness and luxury.

Responsive requirement:
- Deliver the main mobile layouts first:
  1. Light mode mobile
  2. Dark mode mobile
- Then adapt the same system into a beautiful desktop layout that preserves the same hierarchy and restraint.

Output requirements:
- Generate a complete high-fidelity UI concept with the main artist profile page, onboarding steps, tip flow, social/music drawer, tour drawer, and contact drawer.
- Show key interaction states.
- Keep the experience extremely minimal and world-class.
- Optimize for conversion to fan signup first, music listening second.
- The final result should feel like an Apple-quality product for musicians.
```

For a stronger second pass in Stitch, append this after the first generation:

```text
Refine this concept further. Reduce visual noise by 20%. Increase perceived luxury and clarity. Make spacing more disciplined, typography more premium, and interactions more natively iOS. Preserve the grayscale-only system. Improve conversion emphasis on notifications/signup without making the design feel aggressive. Make the mobile layouts feel exceptional enough to ship.
```

---

## User

{'asset_pointer': 'sediment://file_00000000942471f7b30b638c7dcc23a0', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 4308160, 'width': 501}
 this is what i got

---

## Assistant

Mr. White,

This is well executed visually, but it is the wrong output.

It gave you:
- a dark SaaS marketing homepage
- desktop-first dashboard storytelling
- release workflow software positioning
- multiple feature sections instead of a fan-facing profile product
- almost no mobile-first link-in-bio behavior

It missed the core brief:
- fan capture first
- music destination second
- artist profile as the main object
- bottom drawers and native iOS interaction patterns
- light mode and dark mode product UI
- mobile-first states
- pinned release / tour / merch module
- notifications capture and onboarding flow

The main problem is that Stitch interpreted your brief as “design a startup homepage for a music release platform” instead of “design the actual artist-facing fan destination product.”

Use a much harder prompt with explicit exclusions.

Paste this into Stitch:

```text
Redesign this from scratch as a PRODUCT UI, not a marketing website.

Important:
- Do NOT design a homepage.
- Do NOT design a SaaS landing page.
- Do NOT design dashboards, analytics panels, feature sections, hero copy blocks, or multi-section website storytelling.
- Do NOT make desktop the primary view.
- Design the actual fan-facing link-in-bio product for musicians.

Product type:
A world-class mobile-first link-in-bio product for artists.

Primary goal:
Capture fan contact info for notifications about new music.

Secondary goal:
Send fans to the artist’s music platforms immediately.

Tertiary goals:
Tips, tour dates, merch, and contact access.

Design direction:
- Apple-native feel
- neutral grayscale palette only
- design-agnostic system
- refined, minimal, premium, calm
- light mode and dark mode only
- no loud brand colors
- subtle glass-like depth used sparingly
- crisp typography
- soft rounded corners
- iOS-native bottom drawers, pills, toggles, and transitions
- luxurious spacing
- mobile-first
- desktop adaptation is secondary

Generate these screens and states as a coherent product system:

1) MOBILE ARTIST PROFILE — LIGHT MODE
2) MOBILE ARTIST PROFILE — DARK MODE
3) MUSIC / SOCIAL DRAWER
4) TIP DRAWER
5) TOUR DATES DRAWER
6) CONTACT DRAWER
7) NOTIFICATION SIGNUP STATE
8) ONBOARDING STEP 1
9) ONBOARDING STEP 2
10) DESKTOP VERSION OF THE SAME PROFILE PAGE

Core mobile profile layout:
- top area with small verified state
- label should only say: “Artist”
- artist name is the main title
- medium-sized profile / hero image from Spotify-quality assets, visually premium but not oversized
- clean Apple-native hierarchy
- no extra descriptors

Main actions:
- Play button near artist name
- tapping Play opens a native iOS bottom drawer
- drawer contains all music and social platforms in a vertically scrollable list
- platforms are pre-sorted by importance
- list feels elegant and native

Pinned module:
Place one dynamic pinned card below the header.
Design it as a premium rectangular card:
- left: square artwork with rounded corners
- right: title, short description, CTA button
Possible variants:
- Latest Release → “Listen Now”
- Nearby Tour Date → “Get Tickets”
- Merch Item → “Shop Now”
This module must feel reusable and systemized.

Notifications capture:
This is the highest-priority interaction on the page.
Add a clean pill-shaped input framed as platform notifications.
- left-side toggle switches between email and phone
- simple trusted input
- clear subscribe action
- elegant, not aggressive
- should feel like the main conversion moment

Onboarding flow after signup:
Use smooth native transitions.
Step 1:
- title: “What should we call you?”
- fields: first name, last name, birthday

Step 2:
- title: “Where do you listen to music?”
- prompt to select favorite DSP / platform
- large tap targets
- very simple and polished

Tips:
Create a clean drawer or panel for sending money.
- preset pill amounts: $3, $5, $7
- small “Custom” control opens amount input
- payment CTAs:
  - Continue with Venmo
  - Continue with Apple Pay
- show both stacked if both enabled, or single if only one is enabled
- the UI should feel tasteful and frictionless

Tour dates:
- open in a scrollable native-style drawer
- easy to browse one-handed
- prioritize nearby show context

Contact drawer:
Include a scrollable contact list with:
- Booking Manager — America
- Booking Agent — Canada — Spin Artists Agency
- Booking Agent — Europe — David Lewis Productions
- Booking Agent — Oceania — CAA
- Manager — Lucas, Milk and Honey
- Fan Contact

Interaction rules:
- use bottom drawers, pill controls, segmented toggles, and smooth iOS-style motion
- everything should feel thumb-friendly and one-handed
- minimal chrome
- almost no visual noise
- no desktop admin patterns

Visual rules:
- grayscale only
- strong hierarchy through contrast, size, spacing, blur, and surface treatment
- no colorful gradients
- no dashboard tables
- no analytics charts
- no marketing copy sections
- no multiple website bands stacked vertically

Desktop adaptation:
- show the same artist profile product adapted elegantly to desktop
- centered composition
- premium whitespace
- same hierarchy as mobile
- still clearly the artist profile product, not an internal dashboard

Output requirement:
Show the screens as a high-fidelity product design system.
Focus on the actual user journey:
Artist profile → notifications capture → onboarding → music/social drawer → tips → tour dates → contact.
```

Then use this as the follow-up refinement prompt on the result it returns:

```text
This is still drifting toward a SaaS landing page. Correct it.

I need the actual product UI, not brand marketing.

Make these corrections:
- remove all homepage sections, hero marketing copy, dashboards, analytics views, and feature storytelling
- center the work on a single fan-facing artist profile product
- make mobile the dominant presentation
- show explicit screens and states for:
  1. artist profile light
  2. artist profile dark
  3. music/social bottom drawer
  4. tip drawer
  5. notifications signup
  6. onboarding step 1
  7. onboarding step 2
  8. tour dates drawer
  9. contact drawer
  10. desktop adaptation
- push the design closer to Apple native iOS
- keep the palette neutral grayscale only
- increase luxury, restraint, spacing discipline, and clarity
- make notifications capture the primary CTA
- make the play button and pinned release/tour/merch module clearly visible
- remove all admin-software energy
```

The key sentence is this one:

**“Do NOT design a homepage, SaaS landing page, dashboard, analytics panel, or feature-marketing site. Design the actual fan-facing product UI.”**

That line will do most of the work. If you want, I can also turn this into an even tighter “one-shot Stitch master prompt” optimized specifically to force iPhone screen compositions.


**Topic:** [[chatgpt-clusters/design_ux]]
