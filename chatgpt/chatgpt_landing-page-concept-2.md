---
title: "Landing Page Concept"
type: essay
created: 2026-04-29
updated: 2026-04-29
source: chatgpt-export
conversation_id: 69f238b1-0c78-83e8-9669-3fae392f6d4a
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# Landing Page Concept

> Conversation ID: 69f238b1-0c78-83e8-9669-3fae392f6d4a
> Created: 2026-04-29T16:59:14Z
> Updated: 2026-04-29T20:10:54Z
> Messages: 8

---

## User

what about an expeierment where you use this  in a landing page section and then animate it fro empty with 3 friday filled to every fruday filled. with jovie. could be scroll drive or. toggle. etc. think thorugh the world class version of this marketing section generous whitesppace etc. very apple.

---

## Assistant

Mr. White, I’ll shape the contribution-grid interaction into a premium Jovie landing-page section covering message, motion, layout, states, and implementation direction.

---

## Assistant

Mr. White, yes. This could be a killer section.

Use the contribution graph as a **release calendar**, not a GitHub graph. The metaphor:

**Empty Fridays = lost momentum.**  
**Every Friday filled = Jovie keeps your fanbase warm.**

The section:

### Headline
**Own every Friday.**

### Subhead
Fans sign up once. Jovie turns every drop — music, video, merch, tour dates — into an automatic notification moment.

### Visual
Generous white/black space. Centered calendar grid. Only Fridays matter.

Animation sequence:
1. Starts nearly empty: 3 Fridays filled.
2. Scroll begins.
3. Blue pulse travels across the calendar.
4. More Fridays fill in one by one.
5. End state: every Friday filled.
6. Small notification cards appear beside key Fridays:
   - “New single sent”
   - “Merch drop queued”
   - “Tour alert delivered”
   - “Video premiere live”

### CTA copy
**Start filling Fridays**

### Toggle version
A clean switch above the graph:

**Before Jovie** / **With Jovie**

Before:
“3 drops reached fans.”

With:
“52 moments reached fans.”

### Best execution
Scroll-driven is more premium. Toggle is clearer for conversion. World-class version does both: scroll tells the story, toggle lets users replay it.

The uploaded component is a strong base because it already supports contribution-style date cells, levels, tooltips, legend, and animation via `motion` fileciteturn0file0. I’d strip the GitHub framing, remove month/day clutter on mobile, rename “contributions” to “fan moments,” and theme levels with Jovie electric blue instead of green.

Final section idea:

**Own every Friday.**  
Your fans should hear from you more than once a year.  
Jovie turns every release, video, merch drop, and tour date into a reason to bring them back.

[animated Friday grid]

**3 Fridays became 52 fan moments.**

Button: **Start free**

---

## Assistant

Mr. White, yes — this is a strong landing-page experiment.

The uploaded component already gives you the right base: a contribution-style year grid with `data`, `year`, `showLegend`, `showTooltips`, and `motion/react` support. For this marketing use case, I’d use it as the foundation, then fork the visual layer so it feels like a premium product story rather than a utility widget. fileciteturn0file0

## Core concept

**Three Fridays become every Friday.**

The section should communicate one transformation:

> Jovie turns sporadic momentum into a weekly ritual.

The empty grid with only **3 Fridays filled** is the “before.”  
The fully filled Friday row is the “with Jovie” state.  
The visual payoff is a clean horizontal line of filled Fridays across the year.

Because the contribution graph has 7 day rows and 53 week columns, “every Friday” becomes a single elegant row of 52-ish filled cells. That can look very premium if the other days stay ghosted and the Friday row becomes the focal line.

## Best version of the section

### Layout

Very spacious, centered, quiet.

```text
[ Eyebrow ]
CONSISTENCY, MADE VISIBLE

[ Huge headline ]
Make every Friday count.

[ Subcopy ]
Jovie turns scattered moments into a weekly rhythm your audience can expect, remember, and return to.

[ Large animated graph ]
3 Fridays filled → every Friday filled

[ Micro proof / CTA ]
52 Fridays. One repeatable loop.
[ Build your weekly rhythm ]
```

Use a lot of vertical space. The section can be 140–180vh on desktop if scroll-driven, with a sticky inner canvas. The graph should sit inside a nearly invisible card or no card at all: white background, faint border, soft neutral empty cells, one brand accent color for filled Fridays.

## Animation behavior

### Desktop: scroll-driven cinematic version

This is the premium version.

As the user scrolls into the section:

**0–20% scroll**  
The graph fades in. Only 3 Friday cells are filled. Everything feels still and sparse.

**20–70% scroll**  
Friday cells fill from left to right. The animation should feel intentional, not fast. Each new Friday cell scales from `0.72 → 1`, fades in, and settles softly.

**70–90% scroll**  
The row completes. A small counter changes from:

```text
3 Fridays
```

to:

```text
52 Fridays
```

**90–100% scroll**  
The final copy appears:

```text
Every Friday, without starting from zero.
```

Then the CTA appears.

The animation should complete once. Avoid looping. Premium motion should feel like a reveal, not a demo GIF.

### Mobile: toggle version

For mobile, I’d avoid scroll-scrubbing as the primary interaction. It often feels jumpy and takes too much vertical space.

Use a simple segmented control:

```text
Before Jovie | With Jovie
```

When the user taps **With Jovie**, the Friday row fills.

This gives mobile users control and makes the before/after message obvious.

## Visual direction

The current component includes month labels, day labels, legend, tooltips, and a table-style structure. For the landing page version, I’d remove most of that.

Use:

```tsx
showLegend={false}
showTooltips={false}
```

The legend and tooltips are useful for analytics-style UI, but this section should feel like a story. The data meaning should come from the headline, counter, and animation. fileciteturn0file0

### Specific design details

Use a white or very light background.

Make empty cells extremely quiet:

```text
#F5F5F7 / neutral-100
```

Make filled Fridays use the Jovie brand color.

Dim non-Friday rows to 20–35% opacity.

Give the Friday row a subtle “lane” behind it, almost like a soft horizontal guide. This helps the user understand that Fridays are the point.

Hide or heavily reduce month labels until the animation completes. After completion, they can fade in softly.

Avoid heavy shadows. A faint hairline border or no container at all will feel cleaner.

## Copy options

### Option A: clean and direct

**Make every Friday count.**

Jovie turns scattered moments into a weekly rhythm people come back to.

`3 Fridays → 52 Fridays`

CTA: **Build your weekly rhythm**

### Option B: more product-marketing

**From occasional to expected.**

A few good Fridays are easy to miss. Jovie helps turn them into a rhythm your audience remembers.

CTA: **See how Jovie works**

### Option C: most Apple-like

**Every Friday, remembered.**

Jovie gives your audience a reason to return — again, and again, and again.

CTA: **Create the rhythm**

My favorite is:

> **Make every Friday count.**  
> Jovie turns scattered moments into a weekly rhythm people come back to.

It is simple, visual, and matches the graph.

## Implementation direction

The demo data in the uploaded component uses random contribution data. For this section, use deterministic Friday-only data so the story is stable every time. fileciteturn0file0

Conceptually:

```tsx
function generateFridayData(year: number, activeFridayCount: number) {
  const data = []
  const fridays = []

  for (
    let date = new Date(year, 0, 1);
    date <= new Date(year, 11, 31);
    date.setDate(date.getDate() + 1)
  ) {
    if (date.getDay() === 5) {
      fridays.push(new Date(date))
    }
  }

  for (const [index, date] of fridays.entries()) {
    const filled = index < activeFridayCount

    data.push({
      date: date.toISOString().split("T")[0],
      count: filled ? 1 : 0,
      level: filled ? 4 : 0,
    })
  }

  return data
}
```

Then drive `activeFridayCount` from either scroll progress or a toggle.

For scroll:

```tsx
const activeFridayCount = Math.round(3 + progress * (fridays.length - 3))
```

Start at `3`. End at all Fridays.

For the truly polished version, I would slightly modify the component so each cell is a `motion.div`, not a static `div`. That lets each Friday cell animate scale, opacity, and glow as it becomes active. The current component imports `motion/react`, but the individual contribution cells do not animate on state changes yet. fileciteturn0file0

## The section structure I’d build

```tsx
<section className="relative min-h-[160svh] bg-background">
  <div className="sticky top-0 flex min-h-svh items-center">
    <div className="mx-auto w-full max-w-6xl px-6">
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
          Consistency, made visible
        </p>

        <h2 className="mt-6 text-5xl font-semibold tracking-tight md:text-7xl">
          Make every Friday count.
        </h2>

        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground md:text-xl">
          Jovie turns scattered moments into a weekly rhythm people come back to.
        </p>
      </div>

      <div className="mx-auto mt-20 max-w-4xl">
        <ContributionGraph
          year={2026}
          data={fridayData}
          showLegend={false}
          showTooltips={false}
          className="jovie-friday-graph"
        />
      </div>

      <div className="mt-12 text-center">
        <p className="text-sm text-muted-foreground">
          <span className="text-foreground">52 Fridays.</span> One repeatable loop.
        </p>
      </div>
    </div>
  </div>
</section>
```

## Experiment variants

### Variant 1: Static before/after

Lowest complexity.

Show two small graphs side by side:

```text
Before: 3 Fridays
With Jovie: Every Friday
```

This is clear, but less memorable.

### Variant 2: Toggle

Best practical MVP.

A single graph with:

```text
Before Jovie | With Jovie
```

This gives the user control and creates a clean product-demo feel.

### Variant 3: Scroll-driven

Best “world-class” version.

A sticky section where the Friday row fills as the user scrolls. This will feel the most premium if the motion is restrained and the surrounding copy is minimal.

I’d ship **toggle first** if you want a fast experiment. I’d ship **scroll-driven** if this section is meant to be a signature moment on the page.

## My recommended final version

Use a hybrid:

Desktop gets the scroll-driven reveal.  
Mobile gets the before/with-Jovie toggle.  
Both end on the same final state:

```text
52 Fridays. One repeatable loop.
```

The section should feel almost empty until the row fills. That restraint is what will make it feel premium. The graph becomes the proof, the copy stays quiet, and Jovie gets associated with consistency, rhythm, and inevitability.

---

## User

give me the handoff build prompt

---

## Assistant

Mr. White, paste this as the build prompt.

Based on the uploaded component, the handoff should use the existing `ContributionGraph` foundation with `data`, `year`, `showLegend`, `showTooltips`, and the `motion` dependency already implied by the component spec. fileciteturn0file0

```text
Build a premium Jovie landing-page marketing section using the existing ContributionGraph component.

Context:
We have a React/TypeScript/Tailwind/shadcn-style codebase. There is an existing component intended to live at:

/components/ui/contribution-graph.tsx

It exports:
- ContributionGraph
- ContributionData

It accepts:
- data?: ContributionData[]
- year?: number
- className?: string
- showLegend?: boolean
- showTooltips?: boolean

It uses:
- React
- Tailwind CSS
- motion/react

Install dependency if missing:
npm install motion

Goal:
Create a world-class, Apple-like marketing section for Jovie that visualizes this idea:

“Three Fridays become every Friday.”

The section should show a contribution-style year grid. At the start, only 3 Friday cells are filled. As the user scrolls or toggles the state, every Friday in the year fills in from left to right. The message is that Jovie turns scattered momentum into a repeatable weekly rhythm.

Create a new component:

/components/marketing/friday-rhythm-section.tsx

Component name:
FridayRhythmSection

Primary headline:
Make every Friday count.

Eyebrow:
Consistency, made visible

Subcopy:
Jovie turns scattered moments into a weekly rhythm people come back to.

Final microcopy:
52 Fridays. One repeatable loop.

CTA:
Build your weekly rhythm

Design direction:
- Very Apple-like.
- Generous whitespace.
- White or near-white background.
- Centered content.
- Max width around 1100–1200px.
- Large headline, tight tracking, restrained copy.
- No heavy shadows.
- Use subtle borders only if needed.
- The graph should feel like the hero object.
- Empty cells should be very quiet.
- Filled Friday cells should use Jovie brand styling, preferably `bg-brand`.
- Non-Friday rows should be visually subdued.
- Hide graph legend and tooltips for this marketing section.
- Do not make this feel like a dashboard widget.
- Make it feel like a cinematic product-story section.

Responsive behavior:
Desktop:
- Use a scroll-driven sticky section.
- Outer section should be approximately `min-h-[160svh]`.
- Inner content should be sticky and vertically centered.
- As the user scrolls through the section, animate the graph from 3 filled Fridays to all Fridays filled.
- Fill Friday cells left-to-right.
- The animation should feel calm and premium, not playful or chaotic.

Mobile:
- Use a simple segmented control instead of scroll-scrubbing.
- Toggle labels:
  - Before Jovie
  - With Jovie
- “Before Jovie” shows only 3 Friday cells filled.
- “With Jovie” animates all Fridays filled.
- Keep the section compact and readable on mobile.

Data requirements:
Do not use random sample data.

Create deterministic Friday-only data.

Implement a helper like:

function generateFridayRhythmData(year: number, activeFridayCount: number): ContributionData[] {
  // Return full-year data.
  // Every date in the year should be represented.
  // Fridays should have level 4 when active.
  // All other dates should have level 0.
  // Only the first activeFridayCount Fridays should be filled.
}

Behavior:
- Initial state: 3 active Fridays.
- Final state: every Friday in the selected year active.
- Use year 2026 unless the app has a better global setting.
- Count the actual number of Fridays in the year rather than hardcoding 52.
- Display the current count as:
  “3 Fridays”
  increasing to:
  “52 Fridays”
  or the correct number for the selected year.

Animation requirements:
- Use `motion/react`.
- Filled Friday cells should animate with subtle opacity and scale.
- Suggested motion:
  - opacity: 0.25 → 1
  - scale: 0.75 → 1
  - duration: 0.25–0.4s
  - easing: easeOut
- Avoid bouncy/springy animation.
- Avoid looping.
- The animation should complete once per scroll/toggle interaction.
- Respect reduced motion preferences. If reduced motion is enabled, jump directly between states with minimal or no animation.

ContributionGraph customization:
The existing component can be used directly, but the marketing section may require a fork or enhancement if individual cells need animated transitions.

Preferred approach:
1. Keep `/components/ui/contribution-graph.tsx` as the reusable base component.
2. Create a marketing-specific wrapper or variant that passes:
   - showLegend={false}
   - showTooltips={false}
3. If the base component does not support enough visual control, create:
   /components/marketing/friday-rhythm-graph.tsx

That marketing graph should:
- Render the same 7-row, 53-column year grid.
- Keep accessibility basics.
- Animate cells with `motion.div`.
- Dim non-Friday rows.
- Highlight the Friday row.
- Keep month labels subtle or hidden until the animation completes.

Suggested desktop structure:

<section className="relative min-h-[160svh] bg-background">
  <div className="sticky top-0 flex min-h-svh items-center">
    <div className="mx-auto w-full max-w-6xl px-6">
      <div className="mx-auto max-w-3xl text-center">
        <p>Consistency, made visible</p>
        <h2>Make every Friday count.</h2>
        <p>Jovie turns scattered moments into a weekly rhythm people come back to.</p>
      </div>

      <div className="mx-auto mt-20 max-w-4xl">
        <ContributionGraph
          data={fridayData}
          year={2026}
          showLegend={false}
          showTooltips={false}
          className="w-full"
        />
      </div>

      <div className="mt-12 text-center">
        <p><span>52 Fridays.</span> One repeatable loop.</p>
      </div>
    </div>
  </div>
</section>

Scroll behavior:
Use `useScroll` from `motion/react`.

Example logic:
- Track scroll progress for the section.
- Transform progress from 0 → 1 into active Friday count:
  activeFridayCount = Math.round(3 + progress * (totalFridays - 3))
- Clamp the value between 3 and totalFridays.
- Use that count to generate the graph data.

Mobile toggle behavior:
- Use local state:
  mode: "before" | "after"
- before = 3 active Fridays
- after = totalFridays active
- Tapping “With Jovie” should animate the row filling.

Copy and final visual state:
When complete, the section should clearly communicate:

3 Fridays → every Friday

But avoid making the UI too literal or cluttered. The actual graph should carry most of the meaning.

Acceptance criteria:
- Section looks premium, spacious, and minimal.
- Desktop scroll animation works smoothly.
- Mobile toggle works clearly.
- No random data.
- Only Fridays fill.
- Initial state has exactly 3 filled Fridays.
- Final state fills every Friday in the year.
- Legend and tooltips are hidden.
- The component is TypeScript-safe.
- The component works in a Next.js client component environment.
- Reduced-motion users are handled gracefully.
- No hydration errors.
- No unnecessary external assets.
- No Unsplash images.
- No lucide icons unless absolutely necessary.
- The final section can be imported and placed on the Jovie landing page as:

import { FridayRhythmSection } from "@/components/marketing/friday-rhythm-section"

<FridayRhythmSection />
```

---

## User

a year of drops...i think centering arond the drop somtething every week idea is what this section might wanna be . consitency unlcoked type shit.

---

## Assistant

Mr. White, yes — the stronger frame is **a year of drops**. Use the graph as a visual metaphor for weekly shipping, not calendar analytics.

The uploaded component already supports the required base props and uses `motion/react`, so the handoff can build from it while creating a more marketing-specific wrapper/variant. fileciteturn0file0

Paste this:

```text
Build a premium Jovie landing-page marketing section called “A Year of Drops.”

Context:
We have an existing React/TypeScript/Tailwind contribution graph component at:

/components/ui/contribution-graph.tsx

It exports:
- ContributionGraph
- ContributionData

It accepts:
- data?: ContributionData[]
- year?: number
- className?: string
- showLegend?: boolean
- showTooltips?: boolean

It uses:
- React
- Tailwind CSS
- motion/react

Install dependency if missing:
npm install motion

Create a new marketing section:

/components/marketing/year-of-drops-section.tsx

Component name:
YearOfDropsSection

Core idea:
Jovie helps creators, brands, and teams turn scattered momentum into a weekly drop cadence.

The visual story:
At first, the calendar has only 3 drops.
Then Jovie unlocks consistency.
The graph animates until there is one drop every week for the entire year.

User-facing concept:
“A year of drops.”

Primary copy:
Eyebrow:
Consistency unlocked

Headline:
A year of drops.

Subcopy:
Drop something every week. Jovie turns scattered ideas into a rhythm your audience can count on.

Counter:
3 drops → 52 drops

Final microcopy:
52 weeks. One repeatable drop cadence.

CTA:
Build your drop cadence

Optional secondary CTA:
See how it works

Design direction:
- Apple-like.
- Premium, quiet, spacious.
- White or near-white background.
- Lots of whitespace.
- Centered composition.
- The graph is the hero object.
- Minimal chrome.
- No dashboard feeling.
- No heavy shadows.
- No stock images.
- No decorative icons unless absolutely necessary.
- Empty cells should feel soft and quiet.
- Active drop cells should use Jovie brand styling, preferably `bg-brand`.
- Other days should fade into the background.
- The weekly drop row should become the visual focal point.
- Keep month labels extremely subtle or hidden until the final state.
- Hide the existing contribution graph legend and tooltips.

Important framing:
Do not make the section feel like GitHub contributions.
Do not use developer language like “contributions.”
Use product/creator language:
- drops
- cadence
- weekly rhythm
- consistency
- audience
- momentum

Responsive behavior:
Desktop:
- Use a scroll-driven sticky reveal.
- Outer section should be around `min-h-[160svh]`.
- Inner content should be sticky and vertically centered.
- As the user scrolls, animate from 3 active weekly drops to every week filled.
- The cells should fill left-to-right across the year.
- Motion should be calm, precise, and premium.

Mobile:
- Use a segmented control instead of scroll-scrubbing.
- Toggle labels:
  - Before Jovie
  - With Jovie
- “Before Jovie” shows only 3 weekly drops.
- “With Jovie” fills the whole year.
- Keep mobile compact and clear.

Implementation detail:
Use the existing ContributionGraph if possible.

Preferred structure:
1. Keep `/components/ui/contribution-graph.tsx` as the base reusable component.
2. Create `/components/marketing/year-of-drops-section.tsx`.
3. If the base ContributionGraph does not allow enough visual control, create a marketing-specific graph:
   `/components/marketing/year-of-drops-graph.tsx`

The marketing graph should:
- Render a 7-row, 53-column year grid.
- Represent every date in the year.
- Fill exactly one weekday per week.
- Use Friday as the default drop day for now.
- Keep the drop day configurable with a prop:
  `dropDay?: 0 | 1 | 2 | 3 | 4 | 5 | 6`
- Default:
  `dropDay = 5`
- Avoid showing “Friday” in the main copy unless needed.
- Treat the selected weekday as “drop day.”
- Animate individual active cells with `motion.div`.
- Respect reduced-motion preferences.

Data requirements:
Do not use random data.

Create deterministic weekly drop data.

Implement a helper like:

function generateYearOfDropsData({
  year,
  activeDropCount,
  dropDay = 5,
}: {
  year: number
  activeDropCount: number
  dropDay?: 0 | 1 | 2 | 3 | 4 | 5 | 6
}): ContributionData[] {
  // Return full-year data.
  // Every date in the year should be represented.
  // Only the selected weekday should ever be active.
  // The first activeDropCount selected weekdays should be filled.
  // Active drop cells should have:
  // count: 1
  // level: 4
  // All inactive cells should have:
  // count: 0
  // level: 0
}

Behavior:
- Initial state: 3 active drops.
- Final state: every weekly drop day in the year active.
- Use year 2026 unless the app has a better global setting.
- Count the actual number of selected drop days in the year.
- Do not hardcode 52.
- Display the current count dynamically:
  “3 drops”
  increasing to:
  “52 drops”
  or the correct number for the selected year.

Animation requirements:
- Use `motion/react`.
- Active drop cells should animate with subtle opacity and scale.
- Suggested motion:
  - opacity: 0.25 → 1
  - scale: 0.72 → 1
  - duration: 0.25–0.4s
  - easing: easeOut
- Add a very subtle glow or emphasis only when the final row completes.
- Avoid bouncy motion.
- Avoid looping.
- Avoid confetti.
- The animation should feel like a quiet unlock.
- For reduced-motion users, jump cleanly between states.

Suggested desktop structure:

<section className="relative min-h-[160svh] bg-background">
  <div className="sticky top-0 flex min-h-svh items-center">
    <div className="mx-auto w-full max-w-6xl px-6">
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
          Consistency unlocked
        </p>

        <h2 className="mt-6 text-5xl font-semibold tracking-tight md:text-7xl">
          A year of drops.
        </h2>

        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground md:text-xl">
          Drop something every week. Jovie turns scattered ideas into a rhythm your audience can count on.
        </p>
      </div>

      <div className="mx-auto mt-20 max-w-4xl">
        <YearOfDropsGraph
          year={2026}
          activeDropCount={activeDropCount}
          dropDay={5}
        />
      </div>

      <div className="mt-12 text-center">
        <p className="text-sm text-muted-foreground">
          <span className="text-foreground">{activeDropCount} drops.</span>{" "}
          One repeatable cadence.
        </p>
      </div>

      <div className="mt-8 flex justify-center">
        <Button>Build your drop cadence</Button>
      </div>
    </div>
  </div>
</section>

Scroll behavior:
Use `useScroll` from `motion/react`.

Logic:
- Track scroll progress for the section.
- Convert scroll progress into active drop count.
- Start at 3.
- End at totalDropDays.

Example:
const activeDropCount = Math.round(
  3 + progress * (totalDropDays - 3)
)

Clamp between 3 and totalDropDays.

Mobile toggle behavior:
Use local state:
mode: "before" | "after"

before:
activeDropCount = 3

after:
activeDropCount = totalDropDays

Segmented control copy:
Before Jovie
With Jovie

When the user taps “With Jovie,” animate the graph filling from 3 drops to the full year.

Visual polish:
- The active weekly drop cells should create a clean horizontal rhythm across the grid.
- Use the selected weekday row as the visual lane.
- Add a faint horizontal backdrop behind that row if it improves readability.
- The rest of the grid should remain present but subdued.
- Empty cells should be around neutral-100 / neutral-200.
- Active cells should use `bg-brand`.
- The completed state should feel inevitable and satisfying.

Optional copy variants:
Use these only if they fit the page better.

Variant A:
Eyebrow: Consistency unlocked
Headline: A year of drops.
Subcopy: Turn ideas into a weekly cadence your audience can count on.

Variant B:
Eyebrow: Weekly momentum
Headline: Drop every week.
Subcopy: Jovie helps you turn scattered ideas into a year-long rhythm.

Variant C:
Eyebrow: The cadence layer
Headline: Ship the rhythm.
Subcopy: Plan the drops, keep the pace, and give your audience a reason to come back.

Recommended final copy:
Eyebrow:
Consistency unlocked

Headline:
A year of drops.

Subcopy:
Drop something every week. Jovie turns scattered ideas into a rhythm your audience can count on.

Final line:
52 weeks. One repeatable drop cadence.

Acceptance criteria:
- Section can be imported as:

import { YearOfDropsSection } from "@/components/marketing/year-of-drops-section"

<YearOfDropsSection />

- Looks premium and minimal.
- Uses generous whitespace.
- Uses deterministic data.
- Starts with exactly 3 active drops.
- Ends with every selected weekly drop day active.
- Uses 2026 by default.
- Counts actual drop days in the selected year.
- Works smoothly on desktop scroll.
- Works clearly on mobile toggle.
- Uses `motion/react`.
- Handles reduced motion.
- Is TypeScript-safe.
- Works as a Next.js client component.
- Hides legend and tooltips.
- Does not use random sample data.
- Does not use Unsplash.
- Does not use unnecessary icons.
- Does not introduce hydration errors.
```
