---
title: "Workflow summary"
type: guide
created: 2025-12-22
updated: 2025-12-22
source: chatgpt-export
conversation_id: 6948c5d0-f9e4-832c-bb2a-3d526141350e
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Workflow summary

> Conversation ID: 6948c5d0-f9e4-832c-bb2a-3d526141350e
> Created: 2025-12-22T04:15:21Z
> Updated: 2025-12-22T17:04:21Z
> Messages: 6

---

## User

summarize the workflow metioned

---

## Assistant

Mr. White, here’s a concise summary of the **workflow described**:

image_group{"query":["Mercury Linear AI agent workflow diagram","Linear Asks AI agent workflow","AI agent pull request workflow diagram"]}

### Mercury’s Agent-Driven Workflow (End to End)

1. **Request intake (Slack → Linear)**  
   - An ops or internal user submits a request in Slack using a **Linear Asks template**.  
   - The form enforces required fields and includes a dedicated **“notes for AI”** section (examples, constraints, references).

2. **Ticket creation & structuring**  
   - The submission automatically becomes a well-scoped Linear ticket.  
   - Consistency and repeatability are critical; this sharply reduces agent error rates.

3. **Agent assignment**  
   - The ticket is automatically assigned to an AI agent via **Linear for Agents**.  
   - Agents are used primarily for **routine, pattern-based, well-bounded tasks**.

4. **Agent execution (stepwise, not one-shot)**  
   - For larger tasks, the agent:
     - Proposes a plan
     - Executes one step at a time (often starting with tests)
   - Humans stay “in the loop,” guiding and correcting between steps.

5. **Pull request generation**  
   - The agent opens a standard GitHub PR, indistinguishable from a human-generated one.

6. **AI review (optional layer)**  
   - Tools like CodeRabbit provide fast, automated PR feedback (logic errors, issues).

7. **Human review & ownership**  
   - An engineer performs final review and approval.  
   - **Accountability remains fully human**—AI-assisted code is still “your code.”

8. **Merge & ship**  
   - Once approved, the PR is merged like any normal change.

### Net Effect
- Ops teams can resolve many technical changes **self-serve**.  
- Engineering time shifts from execution to **review, guidance, and system design**.  
- Backlog reduction, faster refactors, and more tech debt cleanup—without sacrificing quality.

If you want, I can distill this into a **reusable template** for your own org (inputs, guardrails, and failure modes).

---

## User

make a spec of this blog. theme in tailwind classes, features it has, format. i want a spec i can hand to a design/developer team and have them recreate identically just from the spec (minus the content)

---

## Assistant

:::writing{id="58341" variant="standard"}
# Spec: Linear “Now” Blog Article Page (Mercury AI Agents interview) — Recreate UI/UX (content-agnostic)

Goal: Rebuild the **exact page template** (layout, typography, spacing, components, states) of a Linear “Now” article page. Content will vary, but the structure and styling should match.

---

## 0) Tech + conventions

- **Stack**: Next.js (or any SSR) + Tailwind CSS.
- **Layout principle**: “Centered editorial column + generous whitespace” with a minimal chrome (top nav, footer).
- **Color system**: Use neutral grayscale with high contrast; links in subtle accent.
- **Typography**: Modern grotesk/sans (e.g., `Inter`), tight leading for headlines, comfortable leading for body.

---

## 1) Page anatomy (top to bottom)

### A) Top global navigation (sticky NOT required)
**Structure**
- Full-width bar.
- Left: Linear logomark (click → homepage).
- Center/left cluster: `Product`, `Resources` (each has dropdown), and links: `Pricing`, `Customers`, `Now`, `Contact`, `Docs`
- Right: `Open app`, `Log in`, `Sign up`
- Mobile: collapses to hamburger.

**Tailwind skeleton**
```html
<header class="w-full border-b border-neutral-200/70 bg-white">
  <div class="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-4 sm:px-6">
    <!-- left -->
    <a class="flex items-center gap-2" href="/">
      <span class="sr-only">Navigate to home</span>
      <!-- SVG logo -->
    </a>

    <!-- center nav -->
    <nav class="hidden lg:flex items-center gap-6 text-sm text-neutral-700">
      <!-- dropdown triggers and links -->
    </nav>

    <!-- right actions -->
    <div class="hidden lg:flex items-center gap-3 text-sm">
      <a class="text-neutral-700 hover:text-neutral-900" href="/login">Open app</a>
      <a class="text-neutral-700 hover:text-neutral-900" href="/login">Log in</a>
      <a class="rounded-full bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-800" href="/signup">Sign up</a>
    </div>

    <!-- mobile menu button -->
    <button class="lg:hidden inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-neutral-100">
      <span class="sr-only">Open menu</span>
      <!-- icon -->
    </button>
  </div>
</header>
```

**Dropdown behavior**
- Hover or click opens a panel aligned under the trigger.
- Panel: rounded, shadow, white background, subtle border.

---

### B) Secondary breadcrumb row
- A thin row below header with text links: `Now` / `Community` (contextual section nav).
- Left aligned with main container; smaller type.

```html
<div class="mx-auto max-w-[900px] px-4 sm:px-6">
  <div class="flex gap-4 py-6 text-sm text-neutral-600">
    <a class="hover:text-neutral-900" href="/now">Now</a>
    <a class="hover:text-neutral-900" href="/now/community">Community</a>
  </div>
</div>
```

---

### C) Article hero
**Hero contents**
1) **H1** title (large, bold): “Inside Mercury’s six-month journey building with AI agents”
2) **Hero image** (wide; aspect ~2.2:1). Has desktop and mobile variants in markup (same asset, different sizes).
3) **Byline row**: Author name + separator dot + publish date (e.g., “Kevin Hartnett · July 16, 2025”)

**Spacing**
- Top whitespace: generous (hero sits “low” on page).
- H1 → image: moderate gap.
- Image has rounded corners.

**Tailwind**
```html
<main class="w-full">
  <article class="mx-auto max-w-[900px] px-4 sm:px-6">
    <h1 class="mt-4 text-3xl font-semibold tracking-tight text-neutral-900 sm:mt-8 sm:text-5xl">
      <!-- title -->
    </h1>

    <div class="mt-8 overflow-hidden rounded-2xl">
      <img class="h-auto w-full object-cover" src="..." alt="Hero image alt" />
    </div>

    <div class="mt-6 flex items-center gap-2 text-sm text-neutral-600">
      <span class="font-medium text-neutral-800">Author Name</span>
      <span aria-hidden="true">·</span>
      <time>Month DD, YYYY</time>
    </div>
  </article>
</main>
```

---

## 2) Article body formatting

### Container + rhythm
- Body column aligns with hero container.
- Paragraph width comfortable: **max ~72ch**.
- Vertical rhythm: paragraph spacing ~`mt-5` / `mt-6`.

```html
<div class="mx-auto max-w-[900px] px-4 sm:px-6">
  <div class="prose prose-neutral max-w-[72ch] prose-p:leading-relaxed prose-p:mt-5 prose-a:font-medium prose-a:no-underline hover:prose-a:underline">
    <!-- content -->
  </div>
</div>
```

**If you must avoid Tailwind Typography plugin**, approximate:
- `text-[17px] sm:text-[18px]`
- `leading-7 sm:leading-8`
- `text-neutral-800`
- `space-y-6`

### Interview/Q&A pattern (core feature)
The article is an edited interview with repeated structure:

- **Question**: visually distinct line (often bold or slightly darker), ends with a small mark.
- **Answer**: begins with speaker label (e.g., “Matt Russell:”) in bold, followed by normal text.
- Repeats throughout.

**Implementation**
- Each Q block:
  - question line: `mt-10` (bigger separation than normal paragraphs)
  - answer paragraphs: standard rhythm.

```html
<section class="mt-10">
  <p class="text-neutral-900 font-semibold leading-7">
    <!-- Question -->
  </p>
  <p class="mt-4 text-neutral-800 leading-7">
    <span class="font-semibold text-neutral-900">Speaker Name:</span>
    <!-- Answer -->
  </p>
</section>
```

### Inline links
- Default: neutral/dark text with underline only on hover.
- External links allowed.

```html
<a class="font-medium text-neutral-900 underline-offset-4 hover:underline" href="...">Mercury</a>
```

### Inline emphasis
- Use semibold for speaker labels and occasional emphasis.
- Avoid italics-heavy look.

### Images inside body (feature: embedded diagram)
- Full-width within column, rounded corners.
- Image has descriptive `alt`.
- Often two sizes in markup (desktop + mobile); at minimum provide responsive sizing.

```html
<figure class="my-10">
  <div class="overflow-hidden rounded-2xl border border-neutral-200/70">
    <img class="w-full" src="..." alt="Workflow chart" />
  </div>
</figure>
```

---

## 3) Article utilities + actions

### “Copy link” button (feature)
- Appears near bottom after content.
- Minimal button, icon optional, subtle hover background.

```html
<button class="inline-flex items-center gap-2 rounded-full border border-neutral-200 px-4 py-2 text-sm text-neutral-800 hover:bg-neutral-50 active:bg-neutral-100">
  Copy link
</button>
```

**Behavior**
- Copies canonical URL to clipboard.
- After click: temporary label swap “Copied” for ~2s OR toast (Linear style tends to be subtle).

---

## 4) Footer (global)

**Structure**
- Multi-column link lists: Features / Product / Company / Resources / Connect
- Each column title + stacked links.
- Bottom is dense but clean.

**Tailwind**
```html
<footer class="mt-20 border-t border-neutral-200/70 bg-white">
  <div class="mx-auto max-w-[1200px] px-4 py-16 sm:px-6">
    <div class="grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
      <!-- column -->
      <div>
        <h3 class="text-sm font-semibold text-neutral-900">Features</h3>
        <ul class="mt-4 space-y-3 text-sm text-neutral-600">
          <li><a class="hover:text-neutral-900" href="#">Plan</a></li>
          <!-- ... -->
        </ul>
      </div>
      <!-- repeat -->
    </div>
  </div>
</footer>
```

---

## 5) Responsive rules (must match feel)

### Breakpoints
- `sm` (≥640px): increase headline size, widen padding
- `lg` (≥1024px): show full nav; hide hamburger; more generous hero spacing

### Mobile
- Nav collapses to menu.
- Hero image remains full-width within rounded container.
- Body text slightly smaller but still comfortable.

---

## 6) Motion + micro-interactions (subtle)

- Links: color darken + underline on hover.
- Buttons: slight bg tint on hover.
- Dropdown panels: fade/slide `duration-150`.
- No heavy animation.

Suggested classes:
- `transition-colors duration-150`
- `transition-all duration-150 ease-out`

---

## 7) Accessibility requirements (non-negotiable)

- `Skip to content` link at top of DOM (visible on focus).
- Nav dropdown triggers:
  - `aria-expanded`, `aria-controls`
  - keyboard navigable (Tab + Esc closes)
- Images: meaningful `alt`.
- Focus rings: use Tailwind default or:
  - `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900/30`

---

## 8) Content model (CMS-agnostic)

**Article fields**
- `title` (string)
- `heroImage { src, alt }`
- `author { name, url? }`
- `publishedAt` (date)
- `sections[]` where section types include:
  - `paragraph`
  - `question`
  - `answer { speaker, text }`
  - `image { src, alt, caption? }`
  - `buttonRow` (e.g., copy link)

---

## 9) Pixel-level defaults (use these to match spacing)

- Page background: `white`
- Container max widths:
  - Header/footer: `max-w-[1200px]`
  - Article: `max-w-[900px]`
  - Readable text: `max-w-[72ch]`
- Corner radius:
  - images/cards: `rounded-2xl`
  - buttons: `rounded-full`
- Borders: `border-neutral-200/70`
- Shadows (dropdown only): `shadow-xl shadow-neutral-900/10`

---

## 10) QA checklist (to ensure “identical feel”)

- [ ] Header link order and spacing matches.
- [ ] Breadcrumb row appears under header.
- [ ] Title sizing: large but not display-gigantic.
- [ ] Hero image: rounded, no weird cropping, proper `object-cover`.
- [ ] Byline line: correct typography + muted color.
- [ ] Body: comfortable leading; Q lines visually pop.
- [ ] Embedded images: same rounding + border style.
- [ ] Copy link button works; minimal styling.
- [ ] Footer columns match density and muted link styling.
- [ ] Keyboard navigation works for skip link and dropdowns.

---

## Reference: workflow diagram component (from this page)

A mid-article figure shows a **flow chart**. Recreate the *presentation* only:
- Insertable image figure component
- Full-width within article column
- Rounded corners
- Subtle border
- `my-10` spacing

---

If you want, I can convert this into:
1) a **Figma-ready component inventory** (Header, Breadcrumbs, Hero, Q/A block, Figure, Footer), or  
2) a **single Next.js + Tailwind starter page** that matches this spec.
:::


---

## User

translate it for us to intergrate our current blog to this design. our blog is for Jovie and we have next.js and tailwind and ssr. we use marcdoc files for the blog. we just need a prompt tp give our AI to take the blog we have that is already close and make it spot on with the design.

---

## Assistant

Mr. White, here’s a **copy/paste prompt** you can give your AI to refactor Jovie’s existing Next.js + Tailwind + SSR + MD/MDX (Markdoc) blog to match the Linear “Now” article page *pixel-for-pixel* (structure + styling, not content).

:::writing{id="60427" variant="standard"}
You are a senior frontend engineer. Your task: modify our existing Jovie blog (Next.js + Tailwind + SSR) to match the design of this reference page exactly:

Reference URL: https://linear.app/now/mercury-linear-ai-agents

We already have a blog implementation that is close. Do NOT rewrite from scratch. Produce a minimal, surgical diff that makes our UI/UX match the reference.

## Hard requirements
- Match: layout, spacing, typography scale, link styles, rounded corners, borders, hover states, and responsive behavior.
- Content is irrelevant: keep our words and Markdoc content, but the template/styling should look identical to the reference.
- SSR must remain intact.
- Tailwind only (ok to add Tailwind Typography plugin if not already present; if you add it, configure it to match the reference).
- Markdoc remains the content source. Do not change our authoring format. Only change rendering/components/layout styles.
- Implement the page chrome the same way: top nav + breadcrumb row + article hero + byline + body + “Copy link” + footer.
- Accessibility: skip-to-content, focus-visible rings, proper landmarks, alt text.

## What to output
1) A short “Plan” (bulleted) describing which files you’ll touch.
2) A list of exact file changes (paths) with code blocks for each modified/new file.
3) Notes on any Tailwind config changes.
4) A QA checklist to confirm it matches the reference.

## Visual targets (must implement)
### Global layout + containers
- Header/footer container: max-w-[1200px], px-4 sm:px-6
- Article container: max-w-[900px], px-4 sm:px-6
- Body text column: max-w-[72ch]
- Background: white
- Borders: subtle neutral with opacity (e.g. border-neutral-200/70)

### Header (top nav)
- Full-width top bar with bottom border.
- Left: logo.
- Primary links: Product (dropdown), Resources (dropdown), Pricing, Customers, Now, Contact, Docs.
- Right actions: Open app, Log in, Sign up (Sign up is pill button with dark bg).
- Mobile: hamburger; desktop: full nav visible at lg.

### Breadcrumb row under header
- Links: “Now” and “Community” style (text-sm, muted neutral, hover dark).

### Article hero
- H1: large, semibold, tracking-tight.
- Hero image: wide responsive, rounded-2xl, object-cover.
- Byline row: Author · Date in muted text-sm, with author slightly stronger.

### Article body (Markdoc rendering)
- Use consistent editorial rhythm:
  - paragraph leading relaxed (leading-7/8), text neutral-800
  - spacing between paragraphs ~space-y-6 equivalent
- Links: darker neutral, underline on hover, underline-offset-4; not bright blue by default.
- Q&A pattern:
  - Question line visually distinct (font-semibold, neutral-900, larger top margin).
  - Answer begins with “Speaker:” label in semibold/strong.
- Inline images (figures):
  - my-10, rounded-2xl, optional subtle border.
  - Support responsive image sources if available.

### Copy link
- Button near bottom:
  - rounded-full, border-neutral-200, text-sm
  - hover bg-neutral-50, active bg-neutral-100
- Copies canonical URL; show temporary “Copied” state for ~2s (or a subtle toast).

### Footer
- Multi-column link lists (5 columns on lg), headings text-sm font-semibold.
- Links muted neutral with hover dark.
- Top border and generous padding.

### Motion
- Subtle transitions only (transition-colors duration-150).

## Implementation constraints
- Keep our existing components when possible; restyle them to match reference.
- Prefer Tailwind class changes over custom CSS.
- If we use a Layout component, update it; if not, create a minimal layout wrapper.
- Ensure the Markdoc renderer maps:
  - paragraphs, headings, links, images, blockquotes, lists
  - plus custom nodes for Q&A if we have them; if not, implement a convention:
    - Questions = <h3> or a custom Markdoc tag like {% question %}...{% /question %}
    - Answers = {% answer speaker="..." %}...{% /answer %}
  Keep authoring simple; do not force content rewrites.

## Deliverable details
- Provide the exact Tailwind classes you apply for each major element (header, breadcrumbs, hero, prose/body, figures, copy link, footer).
- If adding @tailwindcss/typography:
  - update tailwind.config.js content globs
  - set prose defaults to match reference: prose-neutral, max-w-[72ch], paragraph spacing/leading, link styling, image rounding.

## QA checklist (must include)
- Desktop vs mobile nav behavior
- Breadcrumb visibility and alignment
- H1 sizing and spacing
- Hero image rounding and aspect handling
- Byline styling
- Body type scale + line-height
- Link hover styling matches reference
- Q&A blocks visually match
- Copy link works + feedback state
- Footer column layout matches
- Keyboard navigation + focus states

Begin now. Make changes and output code.
:::

If you want, paste (or link) your current blog layout files (e.g., `app/blog/[slug]/page.tsx`, Markdoc renderer, and your header/footer components) and I’ll tailor the prompt to your exact file paths and component names.


## See Also
- [[chatgpt/chatgpt_2026-landing-page-workflow]]
- [[chatgpt/chatgpt_admin-workflow-design]]
- [[chatgpt/chatgpt_agent-orchestration-summary]]
- [[chatgpt/chatgpt_ai-deal-workflow-explanation]]
- [[chatgpt/chatgpt_ai-dev-workflow-optimization]]
