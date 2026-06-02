---
title: "Workflow summary"
type: guide
created: 2025-12-22
updated: 2025-12-22
source: chatgpt-export
topic: misc
message_count: 6
tags: [chatgpt, knowledge, misc]
---
**Topic:** [[chatgpt-knowledge/_topics/misc]]

# Workflow summary

> **Source:** ChatGPT conversation
> **Date:** 2025-12-22T04:15:21Z
> **Messages:** 6
> **Topic:** misc

## Question

summarize the workflow metioned

## Answer

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

## Question

make a spec of this blog. theme in tailwind classes, features it has, format. i want a spec i can hand to a design/developer team and have them recreate identically just from the spec (minus the content)

## Answer

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
2) **Hero image** (wide; aspect ~2.2:1). Has desktop and

*(Answer truncated — 10040 chars total)*

## Question

translate it for us to intergrate our current blog to this design. our blog is for Jovie and we have next.js and tailwind and ssr. we use marcdoc files for the blog. we just need a prompt tp give our AI to take the blog we have that is already close and make it spot on with the design.

## Answer

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
  - Answer begins with “Speaker:” labe

*(Answer truncated — 5242 chars total)*
