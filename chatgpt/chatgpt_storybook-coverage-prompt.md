---
title: "Storybook coverage prompt"
type: guide
created: 2025-12-07
updated: 2025-12-07
source: chatgpt-export
conversation_id: 6935c292-3d90-8330-99c1-d69ffcc5ddae
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Storybook coverage prompt

> Conversation ID: 6935c292-3d90-8330-99c1-d69ffcc5ddae
> Created: 2025-12-07T18:08:37Z
> Updated: 2025-12-07T18:34:23Z
> Messages: 4

---

## User

Give me a prompt for full storybook coverage of our next.js app. Get the agent to work recursively til its done

---

## Assistant

Here you go, Mr. White — a drop-in “master prompt” you can paste into your coding agent inside your Next.js repo:

```text
You are a senior frontend/devex engineer specialized in Next.js, React, TypeScript, and Storybook.

## Primary Objective

Achieve **full, high-quality Storybook coverage** for this Next.js app.

“Full coverage” means:

- Every reusable UI component that can reasonably be demonstrated in isolation has at least one Storybook story.
- Key states (default, edge, loading, error, empty, interactive states, etc.) are represented where relevant.
- Storybook builds and runs cleanly with no TypeScript or runtime errors.
- The setup matches the conventions of this codebase (framework, router, styling, etc.).

You must **work recursively and systematically until coverage is complete**, maintaining and updating a TODO list of components as you go.


## Global Rules

1. **Do not ask the user questions.** Make reasonable assumptions based on the codebase and document those assumptions in comments if needed.
2. **Preserve existing behavior and API.** Do not refactor components unless necessary to make them story-friendly (e.g., expose props instead of using hard-coded values).
3. **Use TypeScript and CSF 3** (`Meta`, `StoryObj`) if the project is in TS.
4. Prefer colocated stories:
   - `Component.tsx` → `Component.stories.tsx` (or `.tsx`/`.jsx` variants matching the project).
5. Follow the project’s conventions:
   - Respect existing `tsconfig` paths, aliases, linting rules, and directory structure.
   - Match existing Storybook config style if present.


## High-Level Plan (Follow These Steps)

### 1. Understand the Project & Storybook Status

1. Inspect:
   - `package.json`
   - `next.config.*`
   - `tsconfig.*`
   - `.storybook/*` if it exists

2. Determine:
   - Next.js version and router mode (Pages vs App Router).
   - Styling solutions (CSS modules, Tailwind, Styled Components, etc.).
   - Whether Storybook is already installed and how it’s configured.

3. If Storybook is **not installed**:
   - Add Storybook using the appropriate CLI for this stack (React + Next + TS).
   - Configure it to support:
     - Next.js routing (e.g., `next/router` mocks or `storybook-addon-next-router` if appropriate).
     - Global styles and design tokens.
     - Path aliases from `tsconfig`.
   - Ensure the Storybook dev command is available in `package.json` (e.g., `storybook` / `storybook:dev`).

4. If Storybook **is installed**:
   - Clean up or update configuration to work with the current Next.js version and tooling.
   - Fix any obvious config issues and ensure it can build and run.


### 2. Discover Components & Build a Coverage TODO List

1. Scan typical component directories (adapt to this repo):
   - `src/components/**/*.{tsx,jsx}`
   - `app/**/*.{tsx,jsx}` (for App Router)
   - `src/ui/**/*.{tsx,jsx}`
   - Any other reusable UI folders you detect.

2. **Exclude**:
   - Next.js pages/routes (`pages/**`, `app/**/page.tsx`, `layout.tsx` if not reusable).
   - API routes.
   - Server-only utilities, hooks, or non-visual logic.

3. Build an internal **TODO list** of components that should have stories:
   - Mark which already have `*.stories.*` files.
   - Mark which do not have stories yet.
   - Prioritize:
     - Design system / primitives (buttons, inputs, typography, etc.)
     - Common layout and container components
     - Complex widgets (forms, modals, tables, cards, dashboards)


### 3. For Each Component, Create or Improve Stories

For every component on the TODO list, do the following in a loop until the list is empty:

1. Open the component file and infer:
   - Its props (types, defaults, optional/required).
   - Common usage patterns from where it’s imported/used.
   - Edge cases and important visual/behavioral states.

2. Create or update a `*.stories.*` file that:

   - Uses CSF 3 format:
     - Defines `Meta` and `StoryObj` with appropriate `title` and `component`.
     - Aligns `title` with existing Storybook naming conventions (e.g. `"UI/Button"` vs `"Components/Button"`).

   - Provides **multiple stories**, such as (as applicable):
     - `Primary`, `Secondary`, `Tertiary` variants
     - `Disabled`, `Loading`, `Error`, `Success`
     - `WithIcon`, `WithLongText`, `Compact`, `FullWidth`
     - Theme variants (light/dark) if theming exists
     - Responsive variants (e.g., different sizes / breakpoints)

   - Demonstrates realistic, meaningful data instead of placeholders where possible.

3. If component usage requires providers (theme, router, query client, etc.):

   - Prefer adding those providers in:
     - `.storybook/preview.tsx` (global decorators), or
     - A dedicated story-level decorator.
   - Do **not** replicate provider setup in every story.

4. Where appropriate, add **interaction tests** using Storybook’s `play` function and Testing Library:
   - Simple clicks, form inputs, open/close states.
   - Basic assertion of visible text / state changes.
   - Keep them fast and stable.


### 4. Handle Next.js- and App-Specific Concerns

1. For components using `next/link`, `next/image`, or router hooks:
   - Ensure Storybook mocks or adapters are correctly configured in `.storybook/preview.*` or separate setup files.

2. For server components that also make sense as UI stories:
   - If needed, extract reusable visual parts into client components and write stories for those.
   - Keep server logic separate from Storybook stories.

3. For components relying on environment variables or browser-only APIs:
   - Provide safe fallbacks or mocks in stories.
   - Avoid accessing `window`/`document` at module scope.


### 5. Recursion & Completion Strategy

You must work **recursively** until full coverage is achieved:

1. Maintain and update the component coverage TODO list as you go.
2. After finishing a batch of components:
   - Re-scan the repo for new or previously missed components matching the patterns you used.
   - Add any newly discovered components to the TODO list.
3. Repeat story creation/improvement until:
   - Every reusable UI component has a corresponding story file, **or**
   - You explicitly determine (with a short comment) that a component is not suitable for Storybook (e.g., pure logic hooks, internal layouts tightly coupled to routing).

Document in a short markdown note (e.g. `docs/storybook-coverage.md`):

- What you covered.
- Any components intentionally excluded and why.
- How to run Storybook and tests.


### 6. Quality & Validation

Throughout the process:

1. Continuously ensure:
   - TypeScript passes for all new/edited files.
   - Storybook builds successfully.
2. Fix any lint errors introduced by new stories.
3. Keep stories minimal but expressive; avoid over-engineered examples.
4. Favor clear prop values and realistic data to make stories useful for designers, devs, and QA.

### 7. Output / Reporting

At the end, present:

1. A concise list of:
   - Directories scanned for components.
   - Number of components found vs number covered by stories.
2. A short summary of:
   - Changes made to `.storybook` configuration.
   - Any global decorators/providers added.
   - Remaining limitations or follow-ups, if any.

Proceed now to inspect the repository and begin executing this plan step by step until Storybook coverage is complete.
```

If you tell me which agent/editor you’re using (Cursor, Codeium, etc.), I can tweak this to match its exact workflow style, Mr. White.

---

## User

{'asset_pointer': 'sediment://file_0000000032a471fdb092e72292fce001', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 614, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 178596, 'width': 1356}
How to improve our empty state

---

## Assistant

Mr. White, here are **high-leverage improvements for your empty state**, focused on UX clarity, motivation, and conversion. Right now the screen is *informational but passive*. You want it to feel like a guided onboarding moment.

---

# **1) Add a Primary CTA**
Right now the user has no obvious next step other than pasting a link.

Add a **big, central primary CTA button**, e.g.:

> **“Add Your First Link”**

When clicked, it focuses the input bar.

This reduces cognitive friction and tells users what to do first.

---

# **2) Add a Mini-Preview / Why It Matters**
Users don’t know what adding links unlocks.

Add a **small visual mock of their profile card** with blurred placeholders:

- "Your top link"
- "Your socials"
- "Your landing page"

This converts the empty state into a **promise of value**, not just a blank form.

---

# **3) Add Microcopy That Reduces Uncertainty**
Your current line is generic:

> “Add links to build your profile.”

Replace it with something **outcome-oriented**:

> “Add links you want fans to find — music, socials, payments, or a website. These appear on your public profile immediately.”

Users act more when they know the *benefit and visibility*.

---

# **4) Show Example Content**
A blank list feels empty and unknown.

Inside the dashed box, add a **beautiful sample card**:

```
🎵 Your Spotify artist link
📸 Instagram profile
💵 Venmo for tips
🌐 Website / Landing page
```

With a caption:

> “Here’s how your profile will look once you add links.”

This removes mystery and accelerates onboarding confidence.

---

# **5) Add Smart Suggestions**
Inside the input bar, rotate placeholder examples every 3 seconds:

> Paste Spotify artist URL  
> Paste Instagram profile URL  
> Paste Venmo link for tips  
> Paste your portfolio website  

Suggested formats reduce hesitation.

---

# **6) Auto-Detect Link Types (Key UX Win)**
If user pastes a URL, **auto-detect platform** and format card automatically, then notify:

> “Spotify link detected — added to your profile!”

This lets the empty state feel *magical*, not mechanical.

---

# **7) Allow Drag-and-Drop From Browser Tabs (If Feasible)**
Even stronger:

> Drop a link from another tab to add it.

Empty states that **invite physical action** outperform text alone.

---

# **8) Add a “Help Me Choose” Tooltip**
Some users don’t know what links matter.

Add a tooltip next to the CTA:

> “Don’t know where to start? Use your most active platform — Spotify, Instagram, TikTok, or a landing page.”

Reduces onboarding paralysis.

---

# **9) Add Trust + Social Proof (Even Subtle)**
Below the empty list, add a footer:

> “Creators typically add 3–5 links.”

This sets a **behavioral norm**, increasing completion rate.

---

# **10) Reduce Visual Weight of Tags**
Right now the row of platform pills is visually dominant.

For an empty state:

- Dim them slightly *until a link is added*
- OR collapse into a dropdown like “Suggested platforms”

Otherwise, they distract from **the one thing that matters: adding the first link**.

---

# **Most Effective Final Layout (Summary)**

**Top:**  
Big CTA → "Add Your First Link"

**Middle:**  
Input bar → auto-focus after CTA click

**Below:**  
A tasteful example preview card (blurred or skeleton)

**Side / Secondary:**  
Platform suggestions (less visually dominant)

**Microcopy:**  
Outcome-oriented, e.g.:

> "Add a link to make your profile discoverable. Your top links appear instantly and help fans find your music, socials, or payments."

**Optional:**  
Norm: “Creators usually add 3–5 links.”

---

If you want, I can:

- rewrite the microcopy for tone and brand
- redesign the empty state visually (Figma-style)
- write interactions for Storybook
- convert components into reusable empty-state patterns

Just tell me what direction you want next, Mr. White.
