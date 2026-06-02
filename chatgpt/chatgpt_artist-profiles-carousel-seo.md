---
conversation_id: 69fe377a-a184-83e8-b17c-df594e975fb5
created: 2026-05-08
links:
- '[[chatgpt-clusters/jovie_music_industry]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Artist Profiles Carousel SEO
type: essay
updated: 2026-05-08
---

# Artist Profiles Carousel SEO

**Related:** [[jovie_music]]

> Conversation ID: 69fe377a-a184-83e8-b17c-df594e975fb5
> Created: 2026-05-08T19:20:27Z
> Updated: 2026-05-08T20:43:37Z
> Messages: 6

---

## User

{'asset_pointer': 'sediment://file_0000000093c0722f8efa9e3521958912', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 722, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 987590, 'width': 1915}
for our homepage Artist Profiles seciton I want to steal this as a carosel. It would say get paid and show an artist profile with a screenshot, then Drive streams and have the releases page etc.

spec this out world in terms of seo and copywriting and conversion. use this design exactly though.
but then make it carosel component like on apple landing pages.

---

## Assistant

Mr. White — here’s the spec.

# Jovie Homepage Section Spec: Artist Profiles Carousel

## Section goal

Turn the **Artist Profiles** section into a premium, Apple/App Store-style carousel that shows what one Jovie profile can do for an artist:

**streams, payments, fan capture, release promotion, bookings, and follow-up.**

The section should feel like the screenshot: tall dark cards, oversized headlines, phone-first product visuals, glossy gradients, horizontal scroll, high restraint.

Primary conversion goal: **Claim your profile**  
Secondary goal: **View live example**

---

# 1. Section positioning

## Eyebrow

**Artist Profiles**

## Main headline

**The artist profile that works after every tap.**

## Supporting copy

One public profile for streams, drops, payments, bookings, and fan capture. Jovie keeps your music, links, and fan actions in one place so every visit has a next step.

## CTA row

Primary: **Claim your profile**  
Secondary: **View live example**

Optional handle input below or beside CTA:

**jov.ie/** `[yourname]` **Claim**

This keeps the homepage conversion tied directly to profile ownership.

---

# 2. Visual direction

Use the screenshot’s layout system almost exactly.

## Card structure

Each card should have:

- Large black rounded rectangle.
- White headline at the top.
- Product screenshot centered inside a phone mockup.
- Blue, purple, cyan, or magenta glow gradient rising from the bottom.
- No paragraph copy inside the card.
- No busy badges.
- No CTA inside the card.
- One clear product moment per card.

## Desktop layout

Carousel rail should show multiple cards at once.

Recommended sizing:

| Element | Spec |
|---|---|
| Section background | Near-black / very dark navy |
| Card width | `304–340px` |
| Card height | `620–700px` |
| Border radius | `22–28px` |
| Gap | `20–24px` |
| Card background | `#03040A` with bottom radial gradient |
| Headline size | `26–34px` |
| Headline weight | 600–700 |
| Headline line-height | Tight, around `0.95–1.05` |
| Phone size | 72–82% of card width |
| Phone placement | Bottom anchored, centered |
| Image style | Real product screenshot, no generic mockups |

## Mobile layout

One full card with a partial peek of the next card.

| Element | Spec |
|---|---|
| Card width | `calc(100vw - 40px)` |
| Card height | `560–640px` |
| Scroll behavior | Horizontal swipe |
| Snap | Center snap |
| Controls | Dots/progress below |
| Arrows | Hidden on mobile |

---

# 3. Carousel behavior

Make it feel like an Apple landing-page carousel.

## Interaction

- Horizontal scroll rail.
- Native drag/trackpad support.
- `scroll-snap-type: x mandatory`.
- Cards snap to center.
- Desktop arrows appear on hover or sit subtly at the right edge.
- Mobile uses swipe and pagination dots.
- No forced auto-rotate.
- Optional slow parallax on the phone screenshot as the card moves into focus.
- Hover state: slight lift, subtle glow, no aggressive animation.

## Accessibility

- Section uses a real `h2`.
- Each card is an `article`.
- Arrows are real buttons.
- Keyboard users can tab through cards.
- Images have specific alt text.
- Carousel has an accessible label:  
  **Artist profile outcomes carousel**

---

# 4. Card copy and screen plan

Use 5 cards, matching the screenshot’s rhythm.

## Card 1

### Visible headline

**Get paid from your profile**

### Visual

Artist profile screenshot with a payment/support drawer open.

Show:

- Artist name
- Latest release
- “Support,” “Tip,” “Request,” or “Pay” action
- Confirmation or thank-you state if possible

### SEO/supporting copy outside card or in metadata

Let fans support you, pay you, or respond to a paid request directly from your Jovie artist profile.

### Conversion intent

Monetization. This card tells artists the profile is useful beyond links.

---

## Card 2

### Visible headline

**Drive streams to the right platform**

### Visual

Release page / smart link page.

Show:

- Cover art
- Track title
- Spotify
- Apple Music
- YouTube
- SoundCloud or other music platforms
- One prominent “Listen” action

### SEO/supporting copy

Jovie routes fans to the music platform they already use, helping every release page turn more visitors into listeners.

### Conversion intent

This is the core artist promise: more listening with less friction.

---

## Card 3

### Visible headline

**Capture fans before they leave**

### Visual

Fan capture modal or alert signup screen.

Show:

- “Get notified when I drop”
- Email/SMS opt-in
- Location/device context if available
- Clean consent language

### SEO/supporting copy

Collect verified fan opt-ins from your artist profile so you can reach listeners again for the next release, show, or announcement.

### Conversion intent

This is the owned-audience wedge. It makes Jovie more valuable than a static link page.

---

## Card 4

### Visible headline

**Promote every drop in one place**

### Visual

Upcoming release or release countdown page.

Show:

- Countdown
- Cover art
- Release date
- Pre-save/listen action
- Notification signup

### SEO/supporting copy

Launch release pages, countdowns, smart links, and fan notifications from one profile that stays current as your music goes live.

### Conversion intent

This connects Artist Profiles to Jovie’s broader release operating system.

---

## Card 5

### Visible headline

**Book shows, press, and brand deals**

### Visual

Contact / booking / request screen.

Show:

- Booking
- Press
- Brand partnership
- Management contact
- Clean form or routed request drawer

### SEO/supporting copy

Route booking, press, collaboration, and brand requests through your profile without burying important opportunities in DMs.

### Conversion intent

Makes the profile feel like the artist’s commercial hub.

---

# 5. Recommended final section copy

## Top of section

**Eyebrow:**  
Artist Profiles

**Headline:**  
The artist profile that works after every tap.

**Subhead:**  
One public profile for streams, drops, payments, bookings, and fan capture. Jovie keeps your music, links, and fan actions in one place so every visit has a next step.

**Primary CTA:**  
Claim your profile

**Secondary CTA:**  
View live example

---

## Carousel headlines

1. **Get paid from your profile**
2. **Drive streams to the right platform**
3. **Capture fans before they leave**
4. **Promote every drop in one place**
5. **Book shows, press, and brand deals**

---

## Bottom CTA

After the carousel:

**Your profile should do more than point fans somewhere.**

Claim your Jovie profile and turn every visit into a stream, opt-in, payment, booking, or follow-up.

CTA: **Claim your profile**  
Secondary: **See a live profile**

---

# 6. SEO spec

The design is visually minimal, so SEO needs to live in the section structure, headings, image alt text, and concise supporting copy.

## Primary keyword target

**artist profile**

## Secondary keywords

- music smart links
- artist smart link
- fan capture
- release notifications
- music release page
- artist website
- link in bio for musicians
- music profile link
- independent artist tools

## Recommended semantic structure

```text
<section id="artist-profiles" aria-labelledby="artist-profiles-heading">
  <p>Artist Profiles</p>
  <h2 id="artist-profiles-heading">
    The artist profile that works after every tap.
  </h2>
  <p>
    One public profile for streams, drops, payments, bookings, and fan capture...
  </p>

  <div role="region" aria-label="Artist profile outcomes carousel">
    <article>
      <h3>Get paid from your profile</h3>
      <img alt="Jovie artist profile showing payment and fan support options" />
    </article>
    ...
  </div>
</section>
```

## Image alt text

Use specific alt text. Do not use generic alt text like “Jovie screenshot.”

Recommended alt text:

1. **Jovie artist profile showing payment and fan support options**
2. **Jovie release page routing fans to Spotify, Apple Music, YouTube, and other music platforms**
3. **Jovie fan capture form for release alerts and artist notifications**
4. **Jovie music release page with countdown, cover art, and listener call to action**
5. **Jovie artist profile contact page for bookings, press, and brand requests**

## SEO body copy

Keep the visible design clean, but include a real paragraph under the H2. This gives Google useful context without making the section feel heavy.

Suggested visible SEO paragraph:

**Jovie gives independent artists one public profile for music smart links, release pages, fan capture, payments, bookings, and notifications. It is built to help artists turn profile visits into streams, owned fans, and repeat engagement.**

This can replace the shorter subhead if you want stronger SEO density.

## Internal links

Add subtle links beneath or after the carousel:

- **Artist Profiles** → `/artist-profiles`
- **Release Pages** → `/release-pages`
- **Fan Capture** → `/fan-capture`
- **Pricing** → `/pricing`

Keep these small and footer-like. The card design should stay pure.

---

# 7. Conversion spec

## Primary conversion path

Visitor sees outcome cards → identifies their use case → clicks **Claim your profile** → enters handle → authenticates → connects Spotify → Jovie builds profile.

## CTA placement

Use three CTA moments:

1. Above carousel: immediate action.
2. After carousel: action after value is shown.
3. Sticky mobile CTA: appears after the user scrolls through 2+ cards.

## CTA copy

Best primary CTA:

**Claim your profile**

Best secondary CTA:

**View live example**

Avoid softer CTAs like “Learn more.” This section should convert.

## Handle claim module

Best version:

```text
jov.ie/ [yourname]  Claim
```

Microcopy below:

**Free profile. Live in minutes. Upgrade when you want fan notifications and deeper automation.**

This ties directly to Jovie’s free profile → Pro activation path.

---

# 8. Analytics events

Track the carousel because it will show which artist outcomes actually convert.

## Events

| Event | Trigger |
|---|---|
| `artist_profiles_section_viewed` | Section enters viewport |
| `artist_profile_card_viewed` | Card becomes active/snapped |
| `artist_profile_card_clicked` | User clicks/taps card |
| `artist_profiles_carousel_next_clicked` | Desktop arrow next |
| `artist_profiles_carousel_prev_clicked` | Desktop arrow previous |
| `artist_profiles_cta_clicked` | Any CTA click in section |
| `artist_profiles_handle_submitted` | User submits handle |
| `artist_profiles_live_example_clicked` | Secondary CTA click |

## Card properties

Attach:

```text
card_id
card_title
card_index
intent
device
viewport_width
```

Recommended intents:

- `get_paid`
- `drive_streams`
- `capture_fans`
- `promote_release`
- `book_opportunities`

---

# 9. Component architecture

## Component name

`ArtistProfilesCarouselSection`

## Subcomponents

```text
ArtistProfilesCarouselSection
  SectionHeader
  ClaimProfileCTA
  OutcomeCarousel
    OutcomeCard
      CardHeadline
      PhoneMockup
      ProductScreenshot
  CarouselControls
  CarouselProgress
  BottomCTA
```

## Data model

```ts
type ArtistProfileOutcomeCard = {
  id: string
  eyebrow?: string
  headline: string
  intent: 'get_paid' | 'drive_streams' | 'capture_fans' | 'promote_release' | 'book_opportunities'
  screenshotSrc: string
  screenshotAlt: string
  gradient: 'blue' | 'cyan' | 'purple' | 'magenta' | 'violet'
  seoDescription: string
}
```

---

# 10. Motion spec

Keep motion expensive-looking and restrained.

## On section enter

- Header fades in.
- Cards slide up 12–20px with stagger.
- Carousel remains immediately usable.

## On card hover

- Card lifts 4px.
- Gradient gets slightly brighter.
- Phone shadow deepens.
- No scaling beyond 1.02.

## On scroll

- Active card can scale to 1.
- Neighboring cards can sit at 0.98 opacity/scale.
- Phone image can move upward 4–8px for depth.

## Reduced motion

Respect `prefers-reduced-motion`.

Disable:

- Parallax
- Stagger animation
- Smooth scroll animation

Keep:

- Snap
- Manual controls
- Static gradients

---

# 11. Screenshot requirements

Use real Jovie product surfaces. This section will fail if the screenshots feel fake.

## Required screenshots

1. Artist profile with payment/support action
2. Release/smart link page
3. Fan capture / notification opt-in
4. Release countdown or active drop
5. Booking/contact/request flow

## Screenshot rules

- Use the same phone frame across all cards.
- Use dark product UI.
- Keep the most important UI element in the top half of the phone screen.
- Avoid tiny unreadable text.
- Use artist names, release titles, and artwork that feel real.
- Use quiet Jovie branding.

---

# 12. Acceptance criteria

This section is done when:

- It visually matches the screenshot’s card system.
- Desktop shows a horizontal rail with 4–5 visible cards depending on viewport.
- Mobile shows one card with swipe and snap.
- The section has one real `h2`, useful paragraph copy, and descriptive image alt text.
- The primary CTA is **Claim your profile**.
- The carousel works without JavaScript-heavy hacks.
- Cards use real product screenshots.
- Analytics track card views and CTA clicks.
- Lighthouse does not flag layout shift from unloaded screenshots.
- The visual design remains minimal: no paragraphs inside cards, no badges, no internal CTAs.

---

# Best final version

Use this exact copy in the build:

**Artist Profiles**

# The artist profile that works after every tap.

One public profile for streams, drops, payments, bookings, and fan capture. Jovie keeps your music, links, and fan actions in one place so every visit has a next step.

**Claim your profile**  
**View live example**

Carousel cards:

1. **Get paid from your profile**
2. **Drive streams to the right platform**
3. **Capture fans before they leave**
4. **Promote every drop in one place**
5. **Book shows, press, and brand deals**

Bottom CTA:

**Your profile should do more than point fans somewhere.**

Claim your Jovie profile and turn every visit into a stream, opt-in, payment, booking, or follow-up.

**Claim your profile**

---

## User

Make the text simple like i gave you - Get paid
- Drive streams
- Capture fans
- Sell out - for a tour page
- Get Paid - tip drawer
etc

---

## Assistant

Mr. White — use **short action headlines only**. Each card should feel like a product outcome, not marketing copy.

# Final carousel copy

## Section header

**Artist Profiles**

## Headline

**Everything artists need in one profile.**

## Subhead

Streams, fans, shows, payments, and drops — all from one Jovie link.

## CTA

**Claim your profile**

Secondary: **View example**

---

# Carousel cards

## 1. Get Paid

**Screen:** Artist profile with tip drawer open  
**Product moment:** Fan taps “Support” or “Tip” and pays directly.

Card headline:

**Get Paid**

Alt text:

Jovie artist profile with fan tip drawer open.

---

## 2. Drive Streams

**Screen:** Release page  
**Product moment:** Fan sees the song and chooses Spotify, Apple Music, YouTube, SoundCloud, etc.

Card headline:

**Drive Streams**

Alt text:

Jovie release page with music streaming platform buttons.

---

## 3. Capture Fans

**Screen:** Fan capture drawer  
**Product moment:** Fan enters email or phone to get notified about drops, shows, or updates.

Card headline:

**Capture Fans**

Alt text:

Jovie artist profile with fan signup form.

---

## 4. Sell Out

**Screen:** Tour page  
**Product moment:** Upcoming shows, ticket buttons, city list, RSVP or notify-me option.

Card headline:

**Sell Out**

Alt text:

Jovie tour page with upcoming show dates and ticket links.

---

## 5. Drop Music

**Screen:** Release rollout / countdown page  
**Product moment:** Pre-save, release countdown, cover art, notify fans.

Card headline:

**Drop Music**

Alt text:

Jovie music release page with countdown and pre-save call to action.

---

## 6. Book Deals

**Screen:** Contact / booking page  
**Product moment:** Booking, press, brand, collab, manager contact form.

Card headline:

**Book Deals**

Alt text:

Jovie artist profile with booking and brand inquiry form.

---

# Strongest 5-card version

Use this if you want the section tight:

1. **Get Paid** — tip drawer  
2. **Drive Streams** — release page  
3. **Capture Fans** — signup drawer  
4. **Sell Out** — tour page  
5. **Drop Music** — release countdown / pre-save page  

This is the cleanest homepage set.

---

# Visual copy rules

Inside each card, only show the two-word headline.

No paragraphs.  
No badges.  
No “learn more.”  
No secondary text.  
No explainers inside the card.

The top of each card should look like:

**Get Paid**

Then the phone mockup below it.

---

# Updated homepage section copy

**Artist Profiles**

# Everything artists need in one profile.

Streams, fans, shows, payments, and drops — all from one Jovie link.

**Claim your profile**  
**View example**

Carousel:

**Get Paid**  
**Drive Streams**  
**Capture Fans**  
**Sell Out**  
**Drop Music**

Bottom CTA:

**Claim your artist profile.**

Turn every tap into a stream, fan, ticket, payment, or drop.

**Claim your profile**

---

## User

Alright, now give me a spec for this as a high-res mockup. 

---

## Assistant

Mr. White — here’s the high-res mockup spec.

# High-Res Mockup Spec: Artist Profiles Carousel

## Mockup format

**Desktop frame:** `1920 × 1200px`  
**Export size:** `3840 × 2400px` PNG  
**Background:** light neutral page background  
**Section style:** premium product carousel, dark vertical cards, large simple action copy, phone screenshots inside each card.

Use the reference image’s structure:

- 5 tall rounded cards across the page
- Dark card backgrounds
- White oversized headline at top
- Phone mockup centered below headline
- Color glow gradient from bottom
- Minimal UI, no long text inside cards
- Horizontal carousel feel

---

# Section layout

## Canvas

```text
Frame: 1920 × 1200
Section top padding: 96px
Section side padding: 128px
Section background: #F5F5F7 or #F7F7F8
```

## Header area

Place above carousel, left aligned.

```text
X: 128
Y: 96
Width: 900
```

### Eyebrow

**Artist Profiles**

```text
Font size: 18px
Weight: 600
Color: #6B6B73
Letter spacing: -0.01em
```

### Main headline

**Everything artists need in one profile.**

```text
Font size: 64px
Line height: 68px
Weight: 700
Color: #0B0B0F
Max width: 920px
```

### Subhead

**Streams. Fans. Shows. Payments. Drops.**

```text
Font size: 24px
Line height: 32px
Weight: 400
Color: #4A4A52
Margin top: 18px
```

### CTA row

Primary button: **Claim your profile**  
Secondary link/button: **View example**

```text
Y: 270
Primary button:
  Height: 48px
  Padding: 24px horizontal
  Radius: 999px
  Fill: #0B0B0F
  Text: #FFFFFF
  Font size: 17px
  Weight: 600

Secondary:
  Height: 48px
  Padding: 20px horizontal
  Radius: 999px
  Fill: transparent or #FFFFFF
  Border: 1px #D8D8DE
  Text: #0B0B0F
```

---

# Carousel rail

```text
X: 128
Y: 370
Height: 680px
Gap: 24px
```

## Card dimensions

```text
Card width: 318px
Card height: 680px
Border radius: 26px
Background: #03040A
Overflow: hidden
```

Five cards fit across the high-res desktop mockup:

```text
Card 1 X: 128
Card 2 X: 470
Card 3 X: 812
Card 4 X: 1154
Card 5 X: 1496
```

Optional: show a tiny 6th-card sliver at the far right if you want the carousel to feel more scrollable.

---

# Card visual system

Each card has the same structure.

## Card headline

```text
Position: top center
Y: 54px
Width: 260px
Font size: 34px
Line height: 36px
Weight: 700
Color: #FFFFFF
Text align: center
Letter spacing: -0.04em
```

## Phone mockup

```text
Phone width: 224px
Phone height: 456px
X: centered in card
Y: 178px
Border radius: 36px
Outer frame: #08080C
Inner border: 1px rgba(255,255,255,0.14)
Shadow: 0 30px 80px rgba(0,0,0,0.55)
```

Phone should have:

- Dynamic-island style cutout
- Thin black bezel
- Screenshot clipped inside
- Dark Jovie app UI
- High contrast UI elements
- Realistic artist imagery/artwork

## Bottom gradient

Each card gets a different glow from the bottom.

```text
Gradient type: radial
Origin: bottom center
Size: 120% × 60%
Opacity: 80–95%
Fade to transparent by 65%
```

---

# Card-by-card mockup content

## Card 1: Get Paid

### Headline

**Get Paid**

### Screen

Artist profile with tip drawer open.

Show:

```text
Artist name: KAI NOVA
Primary action: Support
Drawer title: Tip Kai Nova
Amount buttons: $5 / $10 / $25 / Custom
Payment button: Send Tip
Small note: Supports the next drop
```

### Visual direction

- Artist profile in background
- Tip drawer slides up from bottom
- Payment CTA visible
- Use blue/cyan bottom glow

### Gradient

```text
Cyan / electric blue
#00C8FF → #205CFF → transparent
```

---

## Card 2: Drive Streams

### Headline

**Drive Streams**

### Screen

Release page with streaming buttons.

Show:

```text
Release title: After Hours
Artist: KAI NOVA
Cover art
Buttons:
  Spotify
  Apple Music
  YouTube
  SoundCloud
  Audiomack
```

### Visual direction

- Cover art near top
- Streaming platforms stacked clearly
- “Listen now” action visible
- Use deep blue bottom glow

### Gradient

```text
Royal blue / ocean blue
#1463FF → #00A3FF → transparent
```

---

## Card 3: Capture Fans

### Headline

**Capture Fans**

### Screen

Fan capture drawer or signup modal.

Show:

```text
Drawer title: Get updates from Kai Nova
Input: Email or phone
Toggle options:
  New music
  Shows near me
  Merch drops
Button: Join Fan List
```

### Visual direction

- Artist profile visible behind drawer
- Signup form large enough to read
- Clean opt-in flow
- Use violet/purple bottom glow

### Gradient

```text
Violet / purple
#7B2CFF → #2E5BFF → transparent
```

---

## Card 4: Sell Out

### Headline

**Sell Out**

### Screen

Tour page.

Show:

```text
Title: 2026 Tour
Subtitle: Tickets & RSVP
Tour rows:
  Los Angeles — Mar 12 — Tickets
  New York — Mar 19 — Tickets
  Chicago — Mar 22 — Sold Out
  Atlanta — Mar 28 — Tickets
```

### Visual direction

- Tour dates in stacked list
- Ticket buttons clearly visible
- One “Sold Out” row for credibility
- Use magenta/red/purple bottom glow

### Gradient

```text
Magenta / red / purple
#FF3B8A → #7B2CFF → transparent
```

---

## Card 5: Drop Music

### Headline

**Drop Music**

### Screen

Release countdown / pre-save page.

Show:

```text
Release title: Midnight Signal
Countdown: 06 Days 14 Hours
Cover art
CTA: Pre-save
Secondary: Get notified
Platforms: Spotify, Apple Music, YouTube
```

### Visual direction

- Countdown prominent
- Cover art centered
- Pre-save CTA visible
- Use purple/blue/cyan glow

### Gradient

```text
Purple / cyan
#5C2DFF → #00D1FF → transparent
```

---

# Optional 6th card

Use only if the mockup needs a visible carousel continuation.

## Card 6: Book Deals

### Headline

**Book Deals**

### Screen

Booking/contact page.

Show:

```text
Request type:
  Booking
  Press
  Brand Deal
  Collab
Button: Send Request
```

### Gradient

```text
Warm amber / purple
#FF9A3C → #7B2CFF → transparent
```

---

# Mockup composition

## Desktop visual target

The final mockup should look like this:

```text
[Section header and CTA]

[ Get Paid ] [ Drive Streams ] [ Capture Fans ] [ Sell Out ] [ Drop Music ]
[  phone   ] [    phone     ] [    phone    ] [  phone   ] [   phone    ]
[ gradient ] [  gradient   ] [  gradient   ] [ gradient ] [ gradient   ]
```

The cards should visually dominate the section. The header gives context. The carousel sells the product.

---

# Typography

Use Jovie’s actual brand font if available. If not, use a modern Apple-like grotesk.

Recommended fallback:

```text
Font: Inter, SF Pro Display, or Geist
```

## Header type

```text
H2: 64px / 68px / 700
Subhead: 24px / 32px / 400
Card headline: 34px / 36px / 700
Button: 17px / 22px / 600
```

---

# Color palette

## Page

```text
Background: #F5F5F7
Primary text: #0B0B0F
Secondary text: #4A4A52
Muted text: #6B6B73
Border: #D8D8DE
```

## Cards

```text
Card background: #03040A
Card headline: #FFFFFF
Phone frame: #08080C
Phone UI background: #0B0B12
Phone UI panels: #161721
Phone text: #FFFFFF
Phone muted text: #9EA0AA
Primary Jovie accent: #6C5CFF or current brand purple
```

---

# Details that matter

Use these constraints to keep it premium:

- Card headlines are only two words.
- The cards contain no paragraph copy.
- The screenshots should look like real Jovie product screens.
- Phone screenshots should be readable at desktop size.
- Each card should show one clear product outcome.
- Use dark UI inside the phone to match the cards.
- Use real-looking artist names, releases, and cities.
- Keep gradients soft and cinematic.
- Avoid decorative stickers, badges, emojis, and busy labels.

---

# Final copy for mockup

## Header

**Artist Profiles**

**Everything artists need in one profile.**

**Streams. Fans. Shows. Payments. Drops.**

**Claim your profile**  
**View example**

## Cards

**Get Paid**  
**Drive Streams**  
**Capture Fans**  
**Sell Out**  
**Drop Music**

Optional sixth:

**Book Deals**

---

# AI/Figma mockup prompt

Use this as the prompt for a visual mockup generator or designer:

```text
Create a high-resolution desktop website section mockup for Jovie, a music artist platform. The section is called Artist Profiles. Use a clean light gray page background with a premium Apple-style horizontal carousel of five tall dark rounded cards.

Canvas size: 1920 by 1200 pixels. Export at 2x resolution.

At the top left, add the eyebrow “Artist Profiles”, the headline “Everything artists need in one profile.”, the subhead “Streams. Fans. Shows. Payments. Drops.”, and two pill buttons: “Claim your profile” and “View example”.

Below the header, create five vertical cards across the page. Each card is 318 by 680 pixels with 26px rounded corners, a near-black background, a soft colorful radial glow from the bottom, a large white centered headline at the top, and a realistic iPhone mockup centered below the headline.

Card 1 headline: “Get Paid”. Show a Jovie artist profile with a tip drawer open, amount buttons, and a “Send Tip” button. Use a cyan and blue glow.

Card 2 headline: “Drive Streams”. Show a Jovie release page with cover art and streaming buttons for Spotify, Apple Music, YouTube, SoundCloud, and Audiomack. Use a royal blue glow.

Card 3 headline: “Capture Fans”. Show a Jovie fan signup drawer with email or phone input, update preferences, and a “Join Fan List” button. Use a violet glow.

Card 4 headline: “Sell Out”. Show a Jovie tour page with upcoming tour dates, ticket buttons, and one sold out show. Use a magenta and purple glow.

Card 5 headline: “Drop Music”. Show a Jovie release countdown page with cover art, countdown timer, pre-save button, and notify option. Use a purple and cyan glow.

The design should be minimal, premium, high contrast, and product-focused. Do not add paragraphs inside the cards. Do not add badges, emojis, or extra marketing text. Make the product screenshots look realistic and readable.
```


**Topic:** [[chatgpt-clusters/jovie_music]]


## See Also
- [[chatgpt/chatgpt_ai-driven-artist-profiles]]
- [[chatgpt/chatgpt_artist-api-search-issue]]
- [[chatgpt/chatgpt_artist-data-via-api]]
- [[chatgpt/chatgpt_artist-dj-relations-jobs]]
- [[chatgpt/chatgpt_artist-identification-guess]]
