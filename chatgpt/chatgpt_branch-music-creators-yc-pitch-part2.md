
The best way is to visualize it as a **landing page system**, not a set of individual pages.

Think of it like this:

```text
Product Cards
   ↓
Reusable Sections
   ↓
Page Recipes
   ↓
Full Landing Pages
```

Each product card becomes a source of truth. Then homepage sections, product pages, use-case pages, comparison pages, and feature pages all pull from the same card data.

---

# The core model

**Related:** [[business_startup]]

## 1. Product cards are the atoms

Each product card should define one sellable capability.

Example Jovie cards:

| Product card | Core promise | Objection it handles |
|---|---|---|
| Artist Profile | One profile for every release | “Do I still need Linkfire / Feature.fm / bio links?” |
| Smart Links | Route fans to the right platform | “How do I send fans to Spotify, Apple, YouTube, etc.?” |
| Pre-save / Countdown | Build anticipation before release day | “Do I need a separate pre-save page?” |
| Fan Capture | Keep the fans your release earns | “How do I collect emails/follows instead of losing traffic?” |
| Notifications | Tell fans when something drops | “How do fans know when I release?” |
| Retargeting | Keep audiences connected across drops | “Do I need to rebuild pixels every time?” |
| Analytics | See what worked | “How do I know which links/campaigns performed?” |
| Release Planner | Turn songs into campaigns | “How do I know what to do next?” |

Each card powers:

```text
Homepage product card
Product page hero
Feature section
Comparison section
FAQ answers
CTA copy
Metadata / SEO
Demo visuals
```

That is the important part. Do not write the same idea five times manually.

---

# 2. Sections are reusable blocks

A section is not a page. A section is a reusable argument.

For Jovie, I’d create this section library:

| Section type | Purpose | Example |
|---|---|---|
| Hero | Main promise | “Release more music with less work” |
| Objection section | Handles one major doubt | “Can I cancel Linkfire / Feature.fm?” |
| Product card carousel | Shows product breadth | Artist Profile, Smart Links, Fan Capture, etc. |
| Lifecycle section | Shows before → release day → after | “One profile for every stage of your release” |
| Stack replacement | Shows tools Jovie replaces | Bio link + smart links + pre-save + forms + analytics |
| Workflow section | Shows how the user gets value | Add song → build campaign → share → track |
| Feature deep dive | Explains one product card | Smart routing, fan capture, countdowns |
| Proof / example | Shows an artist profile or campaign | “See a release running on Jovie” |
| Comparison | Positions against alternatives | Jovie vs bio links / smart links / spreadsheets |
| FAQ | Removes final objections | Pricing, migration, setup, integrations |
| Final CTA | Pushes action | “Start your next release” |

Then every page is just a different arrangement of these sections.

---

# 3. Pages are recipes

A page recipe is the order of sections plus which product cards get passed into each section.

Example:

```text
Homepage
1. Hero
2. Artist Profile / link-stack carousel
3. Release lifecycle
4. Product card grid
5. How it works
6. Example profile
7. Testimonials / proof
8. FAQ
9. CTA
```

Artist Profile page:

```text
Artist Profiles
1. Product hero powered by Artist Profile card
2. Link-stack replacement section
3. Before / release day / after lifecycle
4. Profile modules grid
5. Fan capture section
6. Smart links section
7. Example profile
8. FAQ
9. CTA
```

Smart Links page:

```text
Smart Links
1. Product hero powered by Smart Links card
2. Platform routing section
3. Pre-save to out-now transition
4. Retargeting section
5. Analytics section
6. Comparison vs one-off smart links
7. FAQ
8. CTA
```

Fan Capture page:

```text
Fan Capture
1. Product hero powered by Fan Capture card
2. “Don’t lose release traffic” objection section
3. Email / follow / notification capture
4. Before, during, after release capture moments
5. Audience ownership section
6. Analytics / retargeting section
7. FAQ
8. CTA
```

Release Planner page:

```text
Release Planner
1. Product hero powered by Release Planner card
2. “Know what to do next” section
3. Timeline / task / content planning section
4. Campaign assistant section
5. Lifecycle release workflow
6. Product card cross-sell
7. FAQ
8. CTA
```

That is the system.

---

# Best way to visualize it

Use **three planning views**.

## View 1: Product Card Registry

This is the source of truth.

| Card ID | Name | Promise | Pain | Replaces | Visual | Primary page |
|---|---|---|---|---|---|---|
| `artist-profile` | Artist Profile | One profile for every release | Rebuilding links every drop | Bio link, release pages | Profile UI | `/artist-profiles` |
| `smart-links` | Smart Links | Route fans to the right platform | Fans use different platforms | Linkfire-style smart links | Platform selector | `/smart-links` |
| `fan-capture` | Fan Capture | Keep the fans you earn | Traffic disappears after clicking | Forms, email widgets | Capture module | `/fan-capture` |
| `release-planner` | Release Planner | Know what to do next | Scattered planning | Spreadsheets, notes | Timeline UI | `/release-planner` |
| `analytics` | Analytics | See what worked | Scattered numbers | Dashboards | Chart UI | `/analytics` |

This can live in Notion, Airtable, Google Sheets, or a CMS.

---

## View 2: Section Library

This is your reusable design system.

| Section ID | Section name | What it proves | Uses cards? | Used on |
|---|---|---|---|---|
| `home-hero` | Homepage Hero | Jovie helps artists release more music | No | Home |
| `link-stack-carousel` | Replace release-link stack | Jovie replaces link tools | Yes | Home, Artist Profiles |
| `release-lifecycle` | Before / during / after release | Jovie adapts by stage | Yes | Home, Artist Profiles, Planner |
| `product-grid` | Product card grid | Jovie has full workflow coverage | Yes | Home, all product pages |
| `stack-collapse` | Tools replaced | Jovie consolidates tools | Yes | Artist Profiles, Smart Links |
| `workflow-steps` | How it works | Jovie is easy to start | Sometimes | Home, Planner |
| `example-profile` | Demo proof | Shows real output | No | Home, Artist Profiles |
| `faq` | FAQ block | Removes objections | Yes | All pages |

---

## View 3: Page Matrix

This is the most useful planning view.

Rows are sections. Columns are pages.

| Section | Home | Artist Profiles | Smart Links | Fan Capture | Release Planner | Analytics |
|---|---|---|---|---|---|---|
| Hero | Home hero | Product hero | Product hero | Product hero | Product hero | Product hero |
| Link-stack carousel | Yes | Yes | Maybe | No | No | No |
| Lifecycle | Yes | Yes | Yes | Yes | Yes | No |
| Product cards | Yes | Related cards | Related cards | Related cards | Related cards | Related cards |
| Stack replacement | Maybe | Yes | Yes | Maybe | No | No |
| Feature deep dive | No | Profile modules | Routing logic | Capture flows | Timeline/tasks | Dashboards |
| Workflow | Yes | Setup profile | Create smart link | Capture fan | Plan campaign | Review results |
| Example/demo | Yes | Yes | Yes | Maybe | Maybe | Maybe |
| FAQ | General | Profile FAQ | Smart link FAQ | Fan capture FAQ | Planner FAQ | Analytics FAQ |
| CTA | Start release | Create profile | Create smart link | Capture fans | Plan release | View analytics |

This prevents you from building random pages. Every page becomes a controlled remix of shared parts.

---

# The visual diagram I’d use

Use this as the master map:

```text
                           Jovie Landing Page System

┌────────────────────┐
│  Product Cards      │
│                    │
│  Artist Profile    │
│  Smart Links       │
│  Countdowns        │
│  Fan Capture       │
│  Retargeting       │
│  Analytics         │
│  Release Planner   │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│  Section Library    │
│                    │
│  Hero              │
│  Card Carousel     │
│  Lifecycle         │
│  Stack Replacement │
│  Workflow          │
│  Comparison        │
│  FAQ               │
│  CTA               │
└─────────┬──────────┘
          │
          ▼
┌────────────────────────────────────────────────────┐
│  Page Recipes                                      │
│                                                    │
│  Home               = Hero + Carousel + Lifecycle  │
│  Artist Profiles    = Hero + Stack + Profile UI    │
│  Smart Links         = Hero + Routing + Analytics   │
│  Fan Capture         = Hero + Capture + Retargeting │
│  Release Planner     = Hero + Workflow + Timeline   │
└────────────────────────────────────────────────────┘
```

That is the cleanest mental model.

---

# How I’d actually plan it

Start with a spreadsheet or Notion database with four tabs:

## Tab 1: `Product Cards`

Fields:

```text
id
name
short_name
headline
one_line_promise
pain_point
replaces
primary_visual
cta_text
product_page_slug
related_cards
faq_questions
```

Example:

```text
id: artist-profile
name: Artist Profile
headline: One profile for every release
one_line_promise: Share one artist link that stays current before, during, and after every drop.
pain_point: Artists rebuild release links and campaign pages for every song.
replaces: Bio links, smart links, pre-save pages, fan forms, tour pages, merch links.
cta_text: Create your artist profile
slug: /artist-profiles
```

---

## Tab 2: `Sections`

Fields:

```text
section_id
section_type
headline
subheadline
cards_used
visual_type
primary_objection
pages_used_on
```

Example:

```text
section_id: link-stack-carousel
section_type: product_card_carousel
headline: Goodbye rebuilding release links. Hello one profile that stays in sync.
cards_used: artist-profile, countdowns, smart-links, fan-capture, retargeting, analytics
visual_type: dark card carousel
primary_objection: Can I cancel Linkfire or Feature.fm?
pages_used_on: home, artist-profiles, smart-links
```

---

## Tab 3: `Pages`

Fields:

```text
page_slug
page_name
audience
main_promise
primary_objection
primary_cta
sections_in_order
```

Example:

```text
page_slug: /
page_name: Homepage
audience: independent artists
main_promise: Release more music with less work
primary_objection: Is this just another bio link or smart link tool?
primary_cta: Start your next release
sections: home-hero, link-stack-carousel, release-lifecycle, product-grid, workflow, example-profile, faq, final-cta
```

---

## Tab 4: `Page Sections`

This is the real composer.

| Page | Position | Section | Cards used | Variant |
|---|---:|---|---|---|
| Home | 1 | Hero | — | broad |
| Home | 2 | Link-stack carousel | Artist Profile, Smart Links, Countdown, Fan Capture | full |
| Home | 3 | Lifecycle | Countdown, Smart Links, Fan Capture, Analytics | homepage |
| Artist Profiles | 1 | Product Hero | Artist Profile | product |
| Artist Profiles | 2 | Link-stack carousel | Artist Profile, Countdown, Smart Links, Fan Capture | profile-focused |
| Smart Links | 1 | Product Hero | Smart Links | product |
| Smart Links | 2 | Stack replacement | Smart Links, Countdown, Retargeting, Analytics | link-focused |

This is the view that lets you mix and match without losing the structure.

---

# For design, build it in Figma like this

Do not design full pages first.

Design:

```text
01 — Product card components
02 — Section components
03 — Page recipes
04 — Full page mocks
```

In Figma, each reusable section should have slots:

```text
Section component:
- Eyebrow
- Gray headline line
- White headline line
- Subcopy
- Card array
- Visual slot
- CTA
```

Then you can duplicate the section and swap the cards/content.

Example:

```text
Card Carousel Section
Variant A: Homepage / full stack
Variant B: Artist Profiles / link replacement
Variant C: Smart Links / routing focused
Variant D: Fan Capture / capture focused
```

Same component. Different card data.

---

# For code, the clean structure is this

You want pages driven by config.

```text
/content
  productCards.ts
  sections.ts
  pages.ts

/components/sections
  HeroSection.vue
  ProductCardCarousel.vue
  LifecycleSection.vue
  StackReplacementSection.vue
  WorkflowSection.vue
  FAQSection.vue
  FinalCTA.vue
```

Then a page is just:

```js
{
  slug: "/artist-profiles",
  title: "Artist Profiles",
  sections: [
    {
      type: "productHero",
      card: "artist-profile"
    },
    {
      type: "productCardCarousel",
      variant: "link-stack",
      cards: [
        "artist-profile",
        "countdowns",
        "smart-links",
        "fan-capture",
        "retargeting",
        "analytics"
      ]
    },
    {
      type: "lifecycle",
      cards: [
        "countdowns",
        "smart-links",
        "fan-capture"
      ]
    },
    {
      type: "faq",
      source: "artist-profile"
    }
  ]
}
```

That is how the product cards literally power the landing pages.

---

# The best planning rule

Every section should do one of four jobs:

```text
1. Make a promise
2. Handle an objection
3. Show how it works
4. Prove it is real
```

For example, your selected Option 1 section does this:

```text
Section: Link-stack carousel
Job: Handle an objection
Objection: Can I cancel Linkfire / Feature.fm?
Answer: Yes, because Jovie gives you one profile for every release with smart links, countdowns, fan capture, retargeting, and analytics.
```

That makes it much easier to decide where the section belongs.

---

# My recommended system name

Call it internally:

# **Jovie Page Builder**

With three core concepts:

```text
Cards = product truths
Sections = reusable arguments
Pages = recipes
```

That is the cleanest way to plan it, design it, and eventually build it.


can we just make this as a simple internal page that i can use to visually assemble them?


Yes. Build it as a simple private route:

# **`/internal/page-builder`**

It should not be a real CMS yet. Make it a visual composer that lets you assemble landing pages from shared sections and product cards.

I made a starter Nuxt/Vue file you can drop in here:

[Download `jovie-page-builder.vue`](sandbox:/mnt/data/jovie-page-builder.vue)

Use it as:

```text
pages/internal/page-builder.vue
```

## What it does

It gives you three panels:

**Left:** section library  
Add Hero, Card Carousel, Lifecycle, Stack Replacement, Workflow, FAQ, Final CTA.

**Middle:** page canvas  
Shows the current landing page recipe in order.

**Right:** inspector  
Edit the selected section’s headline, subcopy, variant, and attached product cards.

It also includes:

**Copy JSON**  
Exports the current page recipe.

**Save locally**  
Saves the assembled recipes in `localStorage`.

**New page**  
Creates a new landing page recipe.

## The mental model

The internal page should work like this:

```text
Product cards = reusable product truths
Sections = reusable arguments
Pages = ordered recipes
```

So a page becomes:

```json
{
  "name": "Homepage",
  "promise": "Release more music with less work.",
  "sections": [
    "hero",
    "card-carousel",
    "lifecycle",
    "stack-replacement",
    "workflow",
    "faq",
    "final-cta"
  ]
}
```

## Best MVP behavior

Do not start with drag-and-drop. Use buttons:

```text
Add section
Move up
Move down
Duplicate
Delete
Edit copy
Toggle product cards
Copy JSON
Save locally
```

That is enough to plan pages visually without building a whole CMS.

## What to do next

After this works, the real site pages can be powered by the exported recipes:

```text
/content/productCards.ts
/content/sectionTemplates.ts
/content/pageRecipes.ts
```

Then your homepage, Artist Profiles page, Smart Links page, Fan Capture page, and Release Planner page are all just different recipes using the same shared components.


were next js. just give me a prompt to create it.


Paste this into Cursor / Claude Code / v0:

```text
Create a private internal Next.js page builder for Jovie at:

app/internal/page-builder/page.tsx

Use Next.js App Router, TypeScript, React, and Tailwind. Make it a client-side internal planning tool, not a full CMS.

Goal:
Build a simple visual landing page assembler where I can mix and match shared Jovie marketing sections. Product cards should power the landing pages. I want to assemble recipes for pages like Homepage, Artist Profiles, Smart Links, Fan Capture, Release Planner, etc.

Design style:
Dark, premium, Jovie-style UI. Use a black / near-black background, subtle gray borders, glassy panels, violet/purple accents, soft glow, rounded cards, and high-end SaaS/product feel. It should visually resemble a polished internal tool, not a basic admin table.

Core concept:
Product Cards = reusable product truths
Sections = reusable marketing arguments
Pages = ordered recipes made from sections

Build a 3-column interface:

1. Left sidebar: Section Library
- List reusable section types.
- Each section has name, purpose, and “Add” button.
- Section types:
  - Hero
  - Product Card Carousel
  - Lifecycle
  - Stack Replacement
  - Workflow
  - Product Grid
  - Comparison
  - FAQ
  - Final CTA

2. Center canvas: Page Recipe Preview
- Shows the currently selected landing page.
- Has editable page name and page promise.
- Shows sections in order.
- Each section preview should include:
  - section type badge
  - variant badge
  - gray headline line
  - white headline line
  - subcopy
  - attached product cards
- Each section should have controls:
  - move up
  - move down
  - duplicate
  - delete
  - select/edit

3. Right sidebar: Inspector
- When a section is selected, allow editing:
  - variant
  - eyebrow
  - grayHeadline
  - whiteHeadline
  - subcopy
  - CTA label
  - CTA href
  - product cards attached to the section using checkboxes
- When no section is selected, show helper text.

Data:
Create TypeScript types for:

ProductCard:
- id
- name
- shortName
- icon
- promise
- painPoint
- replaces
- visualType
- primaryPageSlug

SectionTemplate:
- type
- name
- job
- defaults

PageSection:
- id
- type
- variant
- eyebrow
- grayHeadline
- whiteHeadline
- subcopy
- ctaLabel
- ctaHref
- cardIds

PageRecipe:
- id
- name
- slug
- promise
- audience
- primaryObjection
- sections

Include this product card registry:

1. artist-profile
Name: Artist Profile
Promise: One permanent profile for every release.
Pain: Rebuilding pages and bio links for every drop.
Replaces: Bio links, landing pages, release hubs, artist websites.

2. smart-links
Name: Smart Links
Promise: Route every fan to the right platform.
Pain: Fans use different streaming platforms.
Replaces: Linkfire-style smart links, one-off song links.

3. countdowns
Name: Countdowns
Promise: Build anticipation before release day.
Pain: Creating separate pre-save and countdown pages.
Replaces: Pre-save pages, countdown tools, temporary landing pages.

4. fan-capture
Name: Fan Capture
Promise: Keep the fans your releases earn.
Pain: Release traffic disappears after fans click out.
Replaces: Email forms, follow gates, disconnected signup tools.

5. notifications
Name: Notifications
Promise: Notify fans when music, shows, merch, or videos go live.
Pain: Fans miss drops unless the algorithm shows them.
Replaces: Manual fan alerts and scattered announcements.

6. retargeting
Name: Retargeting
Promise: Keep pixels and audiences connected across drops.
Pain: Artists rebuild campaign setup every release.
Replaces: Repeated pixel setup and disconnected ad audiences.

7. analytics
Name: Analytics
Promise: See what worked and improve the next release.
Pain: Performance data is scattered across tools.
Replaces: Scattered link analytics and campaign dashboards.

8. release-planner
Name: Release Planner
Promise: Turn every song into a clear rollout.
Pain: Release planning lives in notes, docs, and spreadsheets.
Replaces: Release spreadsheets, task lists, content calendars.

Include default page recipes:

Homepage:
- Hero
- Product Card Carousel
- Lifecycle
- Stack Replacement
- Workflow
- Product Grid
- FAQ
- Final CTA

Artist Profiles:
- Product Hero
- Product Card Carousel
- Lifecycle
- Stack Replacement
- Product Grid
- FAQ
- Final CTA

Smart Links:
- Product Hero
- Stack Replacement
- Product Card Carousel
- Comparison
- Analytics section
- FAQ
- Final CTA

The key homepage section should be the selected winning Option 1:

Eyebrow:
ALWAYS-ON ARTIST LINK

Gray headline:
Goodbye rebuilding release links.

White headline:
Hello one profile that stays in sync.

Subcopy:
Jovie gives every artist one permanent link for every release. Before the drop, it becomes a countdown and pre-save. On release day, it routes fans to the right platform. After the release, it captures fans, shows what worked, and keeps your music, videos, shows, merch, and news up to date.

Attached cards:
artist-profile, countdowns, smart-links, fan-capture, notifications, retargeting, analytics

Add buttons:
- Save locally
- Load saved
- Copy page JSON
- Import JSON
- Reset
- New page

Behavior:
- Store recipes in localStorage.
- Copy JSON copies the selected PageRecipe to clipboard.
- Import JSON opens a textarea modal or panel where I can paste a recipe and load it.
- No backend required.
- No drag-and-drop required for v1. Move up/down buttons are enough.
- Do not require any new dependencies unless absolutely necessary.
- Use React state only.
- Make the page responsive enough for desktop; mobile is not important.
- Keep all code self-contained if possible, but cleanly separated inside the same file is okay.

Important:
This is an internal visual planning tool. It should help me see how shared sections and product cards combine into landing pages. It does not need to publish pages yet, but the JSON output should be clean enough that we could later use it to power real landing pages.

Deliver:
- A working Next.js page at /internal/page-builder.
- Polished Tailwind UI.
- Strong TypeScript types.
- Default product cards, section templates, and page recipes.
- Local save/load.
- JSON copy/import.
```

Use this as the shorter implementation direction inside the repo:

```text
Build /internal/page-builder as a client-side Next.js App Router page. It is a visual landing-page recipe builder for Jovie. Product cards are the source of truth, sections are reusable marketing arguments, and pages are ordered recipes. Use a 3-column UI: section library, page canvas, inspector. Store recipes in localStorage and let me copy/import JSON. Use dark premium Tailwind styling with violet accents. No backend and no drag-and-drop for v1.
```


combine option 1 and 2 and to one clean slide that hsows one line. always in sync. as the copy and walks you through the morphing release cycle the link supports in a clean amd clear way. compress the copy down and let the visual and white space lead.


great now show me this in a more frame.io style design.


**Topic:** [[chatgpt-clusters/business_startup]]
