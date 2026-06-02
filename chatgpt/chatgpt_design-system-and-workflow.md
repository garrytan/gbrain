---
conversation_id: 69f106b6-ac58-83e8-87a3-99681a844ec3
created: 2026-04-28
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Design System and Workflow
type: guide
updated: 2026-04-28
---

# Design System and Workflow

**Related:** [[design_ux]]

> Conversation ID: 69f106b6-ac58-83e8-87a3-99681a844ec3
> Created: 2026-04-28T19:12:55Z
> Updated: 2026-04-28T20:51:01Z
> Messages: 6

---

## User

We're having a lot of success with using Claude Code and GPT-5 and just spinning up HTML experiments to fuck with design and then reapplying them back. That's been interesting. Now we're kind of building a design system and conforming our app over to it.

Would it be useful at all at this point for us to have ICP build out a Figma of our whole app and then apply the agents to Figma to have them just keep redesigning the app as we go and then instructing the code to modify off of that? Or is there a better way to do this? Is there a way that we can have design make tweaks visually and have them update in code? Or is that not worth it?

Also, the cloud co-work design thing is really good. There is just no way to get extra usage on it, and we burn through it so quickly. I'm just trying to think what the best kind of way for us to move is. Keep in mind it's just me at the computer right now. 

---

## Assistant

Mr. White, I’ll frame this as a solo-founder design pipeline decision: where Figma should sit, how agents should touch code, and when visual tooling creates leverage versus drag.

---

## Assistant

Mr. White, I would **not** pay someone to recreate the whole app in Figma as a parallel source of truth. That will drift fast, especially with only you driving the work.

The better move is:

> **Code stays the source of truth. Figma becomes the design-system/control surface for tokens, components, and a few key flows. Agents bridge between them.**

Figma is useful now, but mainly as a **component + token + taste layer**, not as a full-app mirror.

## What I’d do

### 1. Keep your HTML/code experiment loop

Your current workflow is probably the highest-leverage thing: spin up rough HTML, explore taste, choose the winner, then fold it back into the app.

Do more of that, with one rule: every successful experiment should get reduced into either:

- a token change: color, radius, spacing, font scale, shadow, motion
- a component change: button, card, nav, modal, input, table, composer, sidebar
- a page template change: dashboard shell, onboarding step, empty state, settings page

That keeps the app from becoming a pile of one-off designs.

### 2. Build the design system in code first

Make a small internal “design lab” route or Storybook-style component gallery. It should show every primitive and every common app pattern.

Minimum set:

- colors / semantic colors
- typography scale
- spacing scale
- radii
- shadows
- buttons
- inputs
- cards
- modals
- nav/sidebar
- tables/lists
- empty states
- loading states
- error states
- page shells

Then have agents make changes there first. Once the gallery looks good, apply across the app.

### 3. Add Figma only where it creates leverage

Figma’s official MCP server can give AI agents design context from Figma, generate code from selected frames, and write native Figma content back to the canvas. Figma also says Code Connect improves this by connecting your real repo components to Figma components so agents get more accurate implementation references. citeturn484131view0turn484131view1

So the valuable setup is:

```text
Figma variables/components
        ↓
Figma MCP + Code Connect
        ↓
coding agent
        ↓
actual app components
        ↓
screenshots / visual regression
        ↓
Figma or design lab updated if needed
```

Do **not** build every screen in Figma. Build:

- your token library
- core component variants
- 5–10 canonical flows
- a “visual exploration” file
- maybe one screen per major product surface

That gives agents enough design context without creating a stale second app.

## Can design make visual tweaks and update code?

Yes, but the best version is **token/component-driven**, not “designer moves pixels and code magically updates.”

There are three useful levels:

### Level 1: Token edits

Designer changes colors, spacing, radius, typography, shadows.

Best path:

```text
Figma variables / token JSON → repo tokens → CSS variables / Tailwind theme / component styles
```

Figma variables are explicitly intended for design tokens and modes like light/dark themes, and Figma’s Variables REST API can query, create, update, and sync variables to/from design-system source of truth, though the API access has plan/seat constraints. citeturn484131view3turn484131view4

This is the cleanest “visual tweak updates code” workflow.

### Level 2: Component edits

Designer changes a button, card, input, sidebar, modal, etc.

Best path:

```text
Figma component → agent reads via MCP → agent updates real React/component code → screenshots verify
```

Code Connect is specifically designed to connect Figma components with components in your repository and provide production code references in Dev Mode/MCP workflows. citeturn484131view1turn484131view2

This is worth setting up.

### Level 3: Full screen edits

Designer changes an entire screen in Figma and the agent updates the app.

This is useful for new flows and big redesigns. It is weaker for ongoing product work because screens include logic, state, responsive behavior, loading/error cases, permissions, and real data. Use this for direction, not as an automatic source of truth.

## The specific recommendation

I’d make the app conform to a code-native design system first, then add Figma around it.

Order of operations:

1. **Freeze the primitives.** Decide tokens: colors, spacing, radius, type, shadows.
2. **Refactor the app toward shared components.** Kill one-off CSS.
3. **Create a component gallery/design lab in the app.**
4. **Use Claude/GPT agents to generate visual variants in HTML.**
5. **Promote winners into tokens/components.**
6. **Create a small Figma system that mirrors only those components and core flows.**
7. **Set up Figma MCP + Code Connect once your components are stable.**
8. **Use visual regression/screenshots so agents can see before/after.**

That gets you 80–90% of the value without turning Figma into a maintenance burden.

## On the Claude Design / Cowork usage issue

You may want to re-check the current settings. Anthropic now documents extra usage for paid Claude plans and says it applies to Claude Code terminal usage; for Team and seat-based Enterprise plans, extra usage can also cover Claude, Cowork, and Claude Code after seat limits are reached. citeturn388632view0turn388632view1

For Claude Design specifically, Anthropic says it is metered independently from regular Claude/Claude Code, has its own weekly allowances, and extra usage is available for purchase on individual plans; Team admins can also buy extra usage. citeturn765421view0

So the move is probably:

- use Claude Design/Cowork for high-taste exploration only
- use code agents for implementation
- use cheaper/local HTML experiments for bulk variant generation
- buy/enable extra usage where available
- avoid spending scarce design usage on token cleanup, component plumbing, or repetitive page conversion

## My practical call

**Do not have ICP build a Figma of the whole app.**

Have them build a **design-system Figma**:

- tokens
- components
- variants
- key flows
- visual rules
- examples of good/bad usage

Then wire that to code with MCP/Code Connect.

For you right now, the best workflow is:

```text
HTML experiment → pick direction → extract tokens/components → apply to app → screenshot QA → update Figma system only where useful
```

That keeps speed high and gives future designers/agents a real system to work from.

---

## User

Would it be better, honestly, for us to just like take our landing pages right now and just go into Framer, and then to just like, because we want, like, we have six or seven landing pages and I've kind of built out a little mini design studio. But I guess I'm just like having trouble telling it exactly what I need. Like, what I need is to basically see like all the component library that I have and to basically be like, this is what I like, this is what I don't like, and like iterate on that. And then to like see all the landing pages that are powered by those components and have it like, I want the same footer CTA on six different landing pages, but I want them to have different copy and stuff like that. And like, I just, I have an ultrawide monitor. I just want to look side by side on the ultra-wide monitor at all the different pages. And as I adjust, you know, the order of things and stuff, and then like, I'm happy to then go and be like, okay, this section needs a redesign, then go tell Claude to do that. But like, I'm just kind of like having trouble like visually piecing it together, do you know what I mean? Like, is there a better way?

---

## Assistant

Mr. White, I’d treat this as a visual orchestration problem: you need a multi-page control room for components and landing pages. I’ll check Framer’s current fit, then recommend the fastest solo workflow.

---

## Assistant

Mr. White, yes, I know exactly what you mean.

You need a **visual landing-page control room**, not a full Figma/Framer migration.

My honest recommendation: **do not move the landing pages into Framer yet** unless you want marketing pages to become a separate no-code website surface. For your exact need, it is probably better to extend your mini design studio inside your existing codebase.

## The better setup

Build a route like:

```text
/studio/landing-pages
```

That route shows:

```text
Left rail:
- component library
- sections
- variants
- token controls
- selected component controls

Main canvas:
- all 6–7 landing pages side by side
- same viewport size per page
- synchronized scrolling
- section outlines
- click a section to edit/reorder/swap it

Right rail:
- selected section props
- copy per page
- component variant
- notes: like / dislike / needs redesign
```

That is the thing you are describing.

The key is to make every landing page powered by a **page config**, not hand-authored page markup.

Example:

```ts
const landingPages = {
  creators: {
    hero: {
      eyebrow: "For creators",
      headline: "Launch your AI persona",
      cta: "Start building",
      variant: "split-visual",
    },
    sections: [
      { type: "socialProof", variant: "logos" },
      { type: "featureGrid", variant: "threeColumn" },
      { type: "footerCta", copy: "Create your Jovie today" },
    ],
  },

  agencies: {
    hero: {
      eyebrow: "For agencies",
      headline: "AI talent infrastructure for modern agencies",
      cta: "Book a demo",
      variant: "centered",
    },
    sections: [
      { type: "socialProof", variant: "stats" },
      { type: "featureGrid", variant: "useCases" },
      { type: "footerCta", copy: "See how agencies use Jovie" },
    ],
  },
}
```

Then the shared footer CTA exists once:

```tsx
<FooterCTA
  headline={page.footerCta.headline}
  subhead={page.footerCta.subhead}
  cta={page.footerCta.cta}
/>
```

Changing the component changes it everywhere. Changing the config changes only that page’s copy/order/variant.

## Why this beats Framer for you right now

Framer is strong when you want designers/editors to ship standalone marketing pages visually. It supports React code components that render on the canvas, in preview, and on the published site, and Framer property controls let users manipulate component props visually in the Framer interface. citeturn923781search1turn927836search2

That sounds close to what you want, but the hidden cost is that you’d create a second implementation surface. Your app components, landing-page components, styles, data model, and agent workflow would start to split unless you are very disciplined.

For you, sitting alone at the computer, the fastest durable path is:

```text
real code components
→ visual studio route
→ side-by-side page matrix
→ Claude/GPT redesigns individual sections
→ changes apply across pages
```

Framer becomes attractive once you have someone else owning marketing pages daily and they need to edit without touching the repo.

## What I would build

### 1. Landing page matrix view

On your ultrawide, show all pages at once:

```text
Creators       Agencies       Enterprise
Influencers    AI Talent      Demo / Waitlist
```

Each page preview should be rendered using the actual app components.

Add controls:

```text
Viewport: Desktop / Tablet / Mobile
Zoom: 50% / 75% / 100%
Sync scroll: on/off
Show section names: on/off
Show component boundaries: on/off
```

### 2. Component library board

A visual board of every reusable section:

```text
Hero
- centered
- split visual
- product screenshot
- editorial

Social proof
- logo strip
- testimonial card
- stats bar

Feature section
- three column
- alternating rows
- sticky visual

Footer CTA
- simple
- dark block
- gradient card
```

Each component should show:

```text
What I like
What I dislike
Where used
Variants
Open redesign prompt
```

This solves the “I can’t visually piece it together” problem.

### 3. Page config editor

You should be able to reorder sections without rewriting code:

```text
Creators page:
1. Hero
2. Logo strip
3. Feature grid
4. How it works
5. Footer CTA
```

Drag/drop or simple up/down buttons are enough.

Then each section exposes props:

```text
Footer CTA
Variant: dark-card
Headline: Create your Jovie today
Subhead: Launch your AI persona in minutes.
CTA: Start building
```

### 4. “Same section across all pages” mode

This is the feature you specifically need.

Click `FooterCTA`, then see:

```text
FooterCTA across all pages

Creators:     "Create your Jovie today"
Agencies:     "Launch AI talent for clients"
Enterprise:   "Deploy AI talent infrastructure"
Influencers:  "Turn your likeness into an AI business"
```

Now you can evaluate one component globally while preserving page-specific copy.

### 5. Redesign handoff button

For any section, generate a Claude prompt automatically:

```text
Redesign this FooterCTA component.

Context:
- Used on these pages: creators, agencies, enterprise, influencers
- Must preserve props: headline, subhead, ctaLabel, ctaHref, variant
- Current dislikes: too generic, CTA does not feel premium, weak visual hierarchy
- Desired direction: more cinematic, founder-led, high-conviction, less SaaS-template
- Do not change copy.
- Return updated React/Tailwind component only.
```

This lets you use Claude Code for the right thing: **redesigning a specific component with constraints**, rather than asking it to understand the entire landing-page system every time.

## The prompt I’d give Claude Code

Use this almost verbatim:

```text
Build a landing page design studio route at /studio/landing-pages.

Goal:
I need to visually compare 6–7 landing pages side by side on an ultrawide monitor. All pages should be rendered from the real landing page components and page config, not screenshots.

Requirements:
1. Create a page config model where each landing page is an ordered list of sections.
2. Each section has:
   - type
   - variant
   - props
   - page-specific copy
3. Build a component registry that maps section types to actual React components.
4. Build a studio UI with:
   - left rail: component/section library
   - main area: grid of all landing page previews
   - right rail: selected section props and notes
5. Add synchronized scrolling across page previews.
6. Add controls for desktop/tablet/mobile viewport width.
7. Add section outlines and labels.
8. When I click a section in one page, highlight the same section type across all pages.
9. Add a “component usage” view showing where each component appears across all pages.
10. Add a “copy matrix” view for shared sections like FooterCTA, so I can edit page-specific copy while keeping the same component.
11. Keep this internal-only and hidden from production navigation.

Do not redesign the components yet. First create the studio infrastructure.
Use the existing app styling, components, routing, and Tailwind setup.
```

Then after that exists, use a second prompt:

```text
Now populate the studio with all current landing pages and reusable sections.
Convert duplicated landing page sections into shared components where reasonable.
Do not change the live page appearance yet.
Preserve current copy and layout as closely as possible.
```

Then a third:

```text
Add a like/dislike/notes system per component and per page section.
Store notes locally in a JSON file or simple local storage.
Each note should include:
- what I like
- what I dislike
- redesign priority
- desired direction
- agent prompt seed
```

## Where Framer fits

Use Framer if you want this outcome:

```text
marketing pages are independent from the app
designer edits visually
publishing speed matters more than codebase unity
some duplication is acceptable
```

Framer has real value there. It has visual editing, hosting, SEO tooling, CMS-style site workflows, and developer extensibility through React code components and plugins. citeturn923781search0turn923781search4

But for your stated need — shared components powering multiple landing pages, visual side-by-side comparison, then Claude-driven code edits — **a code-native design studio is more aligned**.

## The decision

I’d do this:

```text
Keep landing pages in code.
Build /studio/landing-pages.
Use configs to power all pages.
Use shared components for repeated sections.
Use Claude to redesign one section/component at a time.
Use Framer only for throwaway marketing experiments or standalone microsites.
```

The thing you are missing is not Framer. It is a **multi-page visual editor/viewer for your own component system**. That is very buildable, and it should become your internal design cockpit.


**Topic:** [[chatgpt-clusters/design_ux]]
