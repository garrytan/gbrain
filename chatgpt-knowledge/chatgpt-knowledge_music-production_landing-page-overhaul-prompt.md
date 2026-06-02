---
title: "Landing page overhaul prompt"
type: essay
created: 2025-08-03
updated: 2025-08-03
source: chatgpt-export
topic: music-production
message_count: 20
tags: [chatgpt, knowledge, music-production]
---
# Landing page overhaul prompt

> **Source:** ChatGPT conversation
> **Date:** 2025-08-03T17:42:38Z
> **Messages:** 20
> **Topic:** music-production

## Question

{'asset_pointer': 'file-service://file-VxEy5FW878v4SVDj1xKtve', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 812, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1773671, 'width': 1470}
{'asset_pointer': 'file-service://file-8k7dhrns42s9rasCfWFXX8', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 742, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': Tr

## Answer

Here’s your Claude prompt, tailored for overhauling your landing page while keeping the existing section structure but elevating it to Apple/Linear-level design and conversion focus:  

---

**Claude Prompt:**  

You are a world-class product designer and copywriter with deep expertise in modern SaaS landing page design, drawing inspiration from Apple, Linear, and Y Combinator’s best practices. Your task is to **overhaul an existing landing page for Jovie** (a link-in-bio product for musicians) while **keeping all existing sections and general messaging**, but dramatically improving **spacing, layout, typography, colors, buttons, and calls to action** for maximum conversion and aesthetic appeal.  

### Constraints:
- **Do not change the section order or remove sections.** Keep the hero, problem statement, social proof, pre-footer, and footer intact.
- **Headlines remain the same in meaning**, but you can slightly tweak formatting, line breaks, and emphasis for visual hierarchy (e.g., split “The fastest link-in-bio for musicians” into two lines:  
  **The fastest link-in-bio**  
  *Built for musicians*  
  One line bold, one line regular or in an accent color.)
- **Body copy can be slightly tightened** for clarity and readability. Minor copy refinements (e.g., “One optimized design” → “One optimized profile”) are encouraged if they improve flow.
- **Design inspiration:** Apple.com and Linear.app — modern, elegant, minimal, balanced. Avoid overly large, chunky elements. Proportions should feel refined and intentional.
- **Color strategy:** Default to a black-and-white/light theme base. Each section can have its own subtle accent color (Apple/Linear style). No single brand color dominates.
- **Typography:** Elegant, highly readable, with a clear hierarchy. Avoid oversized “marketing fluff” font sizing; aim for sophistication over bombast.
- **Button & CTA style:** Linear.app style — slightly smaller, refined, high-contrast, minimal shadows, subtle hover animations.  
- **Form field redesign:**  
  - The “Find your artist profile” search bar should be **front and center in the hero** (not pushed down).  
  - Include an **inline “Claim Profile” button** inside the search field on the right.  
  - The search results dropdown (Spotify API) should feel integrated and premium.  
- **Redundant copy removal:** Some AI-generated filler copy should be condensed. Only keep what drives the user to act.
- **Spacing & padding:** More white space for breathing room. Avoid cramped layouts. Each section should feel distinct.
- **Icons & imagery:** Keep them small and precise like Linear, not oversized. Use consistent icon style.
- **Proof through design:** Since Jovie’s value proposition is its clean, conversion-focused design, the landing page itself should prove this — a user should instantly feel, “This product is better designed.”

### Deliverables:
- Provide an **updated HTML/CSS layout** with modernized spacing, font sizes, button styles, and section accents.


*(Answer truncated — 3529 chars total)*

## Question

Yeah, let's do that.

## Answer

### Section-by-Section Overhaul Plan  
*(Keep the same order & core messages—just refine layout, copy, and visuals for an Apple / Linear-quality feel.)*

| # | Section | What to Tighten / Remove | Visual & Layout Tweaks | Copy / Micro-copy Tweaks | Accent Color Idea |
|---|---------|--------------------------|------------------------|-------------------------|-------------------|
| 1 | **Nav Bar** | None | • Slimmer height (56 px)<br>• Jovie logo left, Sign In / Sign Up right (Sign Up = filled button)<br>• Sticky w/ subtle shadow on scroll | Button text: **“Sign Up Free”** (signals $0) | Neutral (black #0A0A0A on white) |
| 2 | **Hero** | Cut the “Free forever • High converting” line—move that to a badge | • 90 vh hero, max-width 820 px content<br>• Headline split:<br>  **The fastest link-in-bio** (bold, black)<br>  *Built for musicians* (regular, brand accent)<br>• New badge above headline: **90-second setup • Free forever** | Sub-headline → tighten to:<br>“One optimized profile loads instantly and converts consistently—while others tweak colors, you gain streams.” | Subtle purple-blue (#7367F0) gradient 5% height top-to-bottom |
|   |  |  | • **Search field front-and-center** (max-width 600 px)<br>  – Left = input<br>  – Right = inline **“Claim Profile”** button<br>  – Rounded 12 px, 1 px gray border, slight inner shadow<br>  – Autocomplete dropdown styled like Linear’s cmd-k palette | Placeholder: “Search your Spotify artist name…”<br>Button label: **Claim →** | Same accent as headline second line |
| 3 | **Social Proof (Featured Artists)** | Currently blank—add 3-4 avatar chips w/ marquee logos once available. | Horizontally-scrollable row; small circular images (48 px) + artist names. | Section label stays. | Soft gradient shift to teal (#14B8A6) top border |
| 4 | **Problem Statement** (“Why customization kills conversion”) | Remove sentence starting “It was chaos.” | • Increase top padding<br>• Center-aligned text block 640 px | Revised copy:<br>“Remember MySpace? Glitter backgrounds, custom fonts, auto-play music. Facebook won by making every profile identical—*and optimized*. Your link-in-bio shouldn’t be a canvas; it should be a **conversion machine**.” | None (plain white) |
| 5 | **Process Steps** (“From Spotify artist … 60 seconds”) | None | • Convert to 3-column grid; icons 48 px<br>• Use Apple-style line connectors on large breakpoints | Step labels short caps: **Connect • Claim • Convert** | Section top border accent coral (#F97316) |
| 6 | **Feature Trio** (“Built exclusively for musicians”) | None | • Keep 3-column grid<br>• Icon size 40 px, titles 20 px, body 16 px<br>• More vertical white space | Copy tighten:<br>Lightning Fast → “Loads 3× faster than customizable pages.”<br>Smart Preferences → “Remembers every fan’s favorite platform.”<br>Zero Distractions → “One design, no detours—pure music discovery.” | Violet accent (#8B5CF6) dots under headings |
| 7 | **Comparison Table** (Linktree vs. Jovie) | Reduce height (row paddin

*(Answer truncated — 4755 chars total)*

## Question

So one issue that I've been running into a lot is that it seems like we ask Claude to like make changes and then it breaks something like on the home page it Just had an issue where like I don't know the home hero is a server component trying to render a client component and And we need to see if we like, you know, we need to like fix that or whatever Kind of like curious if there's a way that we can you know Kind of force Claude to like Give me tips for like forcing Claude to like ensure that when it makes changes to like a design thing It doesn't break something by doing that like it checks to see oh Did I implement this right and is it actually working and etc, etc, you know

## Answer

Mr. White, the AI breaks stuff when it can’t see the full picture or when its output isn’t compiled/test-driven. Here’s how to box Claude in so it ships code that actually works:

1. **Always give the exact file tree + key files.**  
   > “Here’s `app/page.tsx`, `components/Hero.tsx`, and `tailwind.config.js`. Only touch these.”

2. **Specify component boundaries up front.**  
   > “`Hero` must stay a *client component*; the page wrapper is a *server component*. Don’t flip them.”

3. **Demand a diff, not a paste-over.**  
   Ask for a unified diff (`--- /+++`) so you can skim what changed and revert quickly.

4. **Force TypeScript strictness.**  
   Tell Claude the repo runs `tsc --noEmit --strict`. It will avoid sloppy any’s and missing imports.

5. **Require the AI to write a quick unit snapshot.**  
   > “Add a Jest test that renders `<Hero/>` without throwing.”

6. **Add a GitHub Action that blocks merge on:**
   - `npm run lint`
   - `npm run typecheck`
   - `npm run build`
   - `npm run test`
   Claude sees the workflow in the repo and will code to satisfy it.

7. **Ask for a self-check step.**  
   > “Before giving the diff, list any build or ESLint errors you’d expect—answer must be ‘none’.”

8. **Pin versions in the prompt.**  
   > “Tailwind 3.4, Next 15.4.5, React 19 RC. Do not introduce incompatible APIs.”

9. **Tell Claude to assume Vercel preview deploy.**  
   It will default to edge-safe patterns (no Node-only libs in client code).

10. **Iterate small.**  
    One section per PR → faster to identify what broke.

11. **Have it wrap risky code in feature flags.**  
    e.g. `process.env.NEXT_PUBLIC_EXPERIMENTAL_HERO_V2`

12. **Use Storybook (stories still compile).**  
    Tell Claude to add/adjust a story; if Storybook breaks, you know instantly.

13. **When in doubt: ask for pseudo-code first.**  
    Then approve and let it flesh out.

Stick these rules into every prompt and into your repo’s `CONTRIBUTING.md`. The CI gate makes sure anything Claude forgets to test never reaches `main`.

## Question

Can Cursor or Clawed Code be instructed to always check to make sure that any changes they do don't create build errors, and to make sure that they always automatically go in and fix the build errors on the local build before they consider the task completed? So in other words, sometimes they'll complete the task, and then they'll just stop working as if everything's done, but then I'll notice that I'm getting build errors in the browser, or I'm seeing errors in the console on the local machine, and therefore the page is not displaying correctly, or not displaying at all, because there's some kind of error blocking it. And in those scenarios, I would like Clawed Code or Cursor to just check to make sure that's not the case, and if that is the case, to fix those before it considers the task complete.

## Answer

**Short answer:** Yes for Cursor (because it can execute shell commands in your repo); only *part-way* for Claude Code (it can’t really compile your project—so you enforce it with CI gates or a test harness and make Claude iterate until the gate is green).

---

### How to force **Cursor** to “compile-until-clean”

1. **Make a reusable npm script**  
   ```json
   // package.json
   "scripts": {
     "check": "npm run lint && npm run typecheck && npm run build && npm test"
   }
   ```

2. **Create a Cursor task template**  
   ```
   # .cursor/config.yml
   tasks:
     fix-and-build:
       steps:
         - apply_patch %PATCH%
         - run "npm run check"
         - if_exit_code_not_zero:
             ask_ai "Resolve the build/lint/test errors shown above, then re-run check."
   ```
   Now when you prompt:  
   > “🛠 Task: **fix-and-build** – Patch the Hero component per spec.”  
   Cursor will loop until `npm run check` exits 0.

3. **Optional: pre-push hook** (`husky`)  
   ```sh
   npx husky add .husky/pre-push "npm run check"
   ```
   Even if Cursor skipped a step, Git won’t push broken code.

---

### How to get **Claude Code** to behave

Claude can’t run your build, but you can:

1. **Show it the failing log**  
   ```
   Here is `npm run build` output. Fix ALL errors until this command returns without error.
   ```
2. **Tell Claude to deliver a *diff* only**  
   It focuses on edits instead of rewriting files blindly.
3. **Wrap every prompt with the rule**  
   ```
   ── RULES ──
   1. After you propose changes, explain WHY they compile.
   2. Ask me to run `npm run check`. If it fails, you must iterate.
   3. Do not consider the task complete until I confirm zero errors.
   ───────────
   ```
4. **Fail-fast CI** (GitHub Actions)  
   Claude sees the workflow in your repo; it will pre-emptively satisfy it:
   ```yaml
   steps:
     - run: npm run check
   ```

---

### Boiler-plate prompt you can reuse

> **“Modify the landing page per spec. After each patch you propose, list the exact commands (`npm run lint`, `npm run typecheck`, `npm run build`) that *must* succeed. If any would fail, revise your patch until all pass. Deliver a unified diff only when you’re confident the repo builds.”**

Stick that in every Claude request and it’ll keep iterating instead of declaring victory too early.

---

**Bottom line:**  
- **Cursor** can truly “compile-until-clean” because it has terminal access—use the task loop above.  
- **Claude** needs a feedback loop (break-fix-test) driven by you or CI; enforce it with strict prompts + blocking workflows.

## Question

{'asset_pointer': 'file-service://file-FpeyejNUMKrZcx4UYQVs8U', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 845, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 2070283, 'width': 1470}
Give me a prompt for Claude to improve the UX of this dramatically. Again, linear style, themes, etc.

## Answer

**Claude Prompt (copy-paste into Cursor/Claude):**

---

### Context  
You’re working on **Jovie’s landing page** (Next 15 + Tailwind 3.4). The screenshot below shows the current hero. The goal is a Linear-quality UX: elegant, understated, instantly clear, zero friction.

```
/app/page.tsx → <Hero />
/components/Hero.tsx
/components/SearchClaim.tsx
/tailwind.config.js
```

### Objective  
**Redesign only the Hero + search/claim block** to dramatically improve first-impression UX while keeping copy, gradient theme, and component boundaries intact.

### Design Guard-rails  
1. **Linear-style sizing** – no jumbo fonts; headline ≈ 4.5 rem desktop, subline 1.25 rem.  
2. **Two-line headline** exactly:  
   **The fastest link-in-bio** (bold)  
   *Built for musicians* (semibold, accent color).  
3. Badge stays (`90-second setup • Free forever`), but make it a pill with subtle glass-blur (Linear).  
4. **Search + “Claim Profile” inline**  
   - Max-width 560 px, height 52 px.  
   - Input left, button right (button width auto ∼112 px).  
   - Rounded-full, 1 px `slate-300/30` border, focus ring accent.  
   - Keyboard “Enter” triggers same action.  
5. Move helper text (“Don’t see your artist…”) to small eye-catching tooltip icon next to input placeholder → reduces clutter.  
6. Section vertical spacing: 13 vh top pad, 18 vh bottom; everything vertically centered on >lg.  
7. **Accessible contrast**: gradient overlay gets 15 % darker at `bg-gradient-to-b from-[#4F46E5]/90 to-[#DB2777]/90` so white text passes WCAG AA.  
8. Motion: tiny `translate-y-1 scale-105` button hover, `duration-150 ease-out`.  
9. Preserve server/client split (Hero is server, inner SearchClaim is client). **DO NOT convert components.**

### Implementation Rules  
- **Diff only** (`---` / `+++`) touching the three files above. No rewrites of other sections.  
- Code must pass `npm run lint && npm run typecheck && npm run build` (repo uses strict TS, Tailwind JIT).  
- After diff, **list “🔍 Self-check”** answering:  
  1. Does `npm run build` succeed?  
  2. Any ESLint warnings?  
  3. Any Lighthouse contrast issues?  
  *All answers must say “None” or explain fixes included.*  
- Use Tailwind utilities; no custom CSS files.  
- Commit message: `feat(hero): Linear-style UX polish + inline claim field`

### Deliverables  
1. Unified diff.  
2. “🔍 Self-check” section (see above).  
3. **(Optional)** short note on further micro-copy/animation ideas *without* changing copy now.

*If the self-check predicts failures, iterate until it predicts none.*

---

## Question

We're on Tailwind 4.1 now.

## Answer

### Updated Claude Prompt (Tailwind 4.1)

---

### Context  
Repo stacks: **Next 15 + Tailwind 4.1 (JIT, new color tokens)**. Same file targets:

```
/app/page.tsx → <Hero />
/components/Hero.tsx
/components/SearchClaim.tsx
/tailwind.config.js
```

### Objective  
Polish the **Hero + search/claim block** to Linear-grade UX. Keep copy & gradient theme; improve sizing, spacing, and interaction.

### Design Guard-rails  
1. **Linear-sized typography** – headline `text-[4.5rem] lg:text-[5rem]`, subhead `text-xl`.  
2. Headline always two lines:  
   **The fastest link-in-bio** (font-bold)  
   *Built for musicians* (font-semibold, `text-accent`).  
3. Badge (`90-second setup • Free forever`) → pill with `backdrop-blur-sm bg-white/5`.  
4. **Search + “Claim Profile” inline**  
   - `max-w-[560px] h-13`, `rounded-full border border-slate-300/30`.  
   - Tailwind 4 “groups” for focus ring `ring-2 ring-accent`.  
   - Enter key triggers claim.  
5. Tooltip icon replaces helper text.  
6. Section spacing: `pt-[13vh] pb-[18vh] lg:flex lg:flex-col lg:justify-center`.  
7. Gradient darkened 15 %: `bg-gradient-to-b from-indigo-600/90 to-pink-600/90` for AA contrast.  
8. Button hover: `transition-transform duration-150 ease-out hover:scale-105 hover:-translate-y-0.5`.  
9. **Maintain component boundaries** (Hero = server, SearchClaim = client).

### Implementation Rules  
- **Tailwind 4.1 utilities only** (use new `text-balance`, `color-scheme` if helpful).  
- Provide a **unified diff** touching only the four files above.  
- Must pass `npm run lint && npm run typecheck && npm run build`.  
- Add **“🔍 Self-check”** after diff:  
  1. Build status?  
  2. ESLint/type errors?  
  3. Lighthouse contrast issues?  
  *All must be “None” or fixed in diff.*  
- Commit message: `feat(hero): Tailwind-4 UX polish + inline claim field`

### Deliverables  
1. Unified diff.  
2. “🔍 Self-check” section.  
3. *(Optional)* quick ideas for next micro-iterations (no code).

*Iterate until self-check says everything is green.*

---

## Question

{'asset_pointer': 'file-service://file-9EGvn7nPKtmfHEUx7zj7R9', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 726, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1617419, 'width': 1470}
This section, I just like to be concise, circular profile photos. I don't want any of the artist names, I don't want to view all artists, and all that. I want to make it super concise, and remove the featured artists, and see how musicians are using Jovi. I just want it to be a clean little thing with all of the circular profile photos, and they can scroll all the way off screen, and maybe have a horizontal scroll or something on them. And then I also want 

## Answer

**Claude Prompt (replace file paths/names with your actual ones if different)**

---

### Context  
`FeaturedArtists.tsx` currently renders a headline, subtitle, card grid, and “View All” button. We want to strip it down to **one clean, horizontally-scrollable row of circular avatars** with skeleton loaders—nothing else. Tailwind **v4.1**.

```
/components/FeaturedArtists.tsx  // client component; fetches artists
/app/page.tsx (imports <FeaturedArtists />)
```

### Objective  
1. Remove the text header, subheader, artist names, track names, and “View All Artists” button.  
2. Display only **64 px circular profile photos** in a single row that can scroll horizontally off-screen (drag or wheel).  
3. Add **skeleton loaders** (same circle size, pulsing bg-slate-400/20) so layout never shifts.  
4. Keep existing gradient background but shrink vertical padding to `py-20` desktop, `py-14` mobile.  
5. Hide default scrollbars on Chrome/Safari (use `scrollbar-none` via Tailwind plugin or inline styles).  
6. Use **scroll-snap-x mandatory** so avatars snap into place when scrolled.

### Implementation Guard-rails  
- **Tailwind 4.1 utilities only**.  
- Component remains a **client component**; any data fetch stays the same—just map to new avatar DOM.  
- Skeleton: show 12 placeholders until `artists` array arrives.  
- Alt text each avatar = `artist.name`.  
- Section max-width `max-w-[1200px] mx-auto`.  
- No other sections touched.

### Deliverables  
1. **Unified diff** modifying only `FeaturedArtists.tsx`.  
2. After diff, include a **“🔍 Self-check”** confirming:  
   - `npm run build` passes?  
   - No ESLint/type errors?  
   - No CLS (layout shift) because skeleton keeps height?  
   (Answers must say “None” or explain fix.)  
3. Commit message: `feat(featured): avatar-only marquee + skeleton loaders`

### Skeleton Loader Details  
```tsx
const Skeleton = () => (
  <div className="h-16 w-16 rounded-full bg-slate-400/20 animate-pulse shrink-0" />
);
```

### Avatar Row Styles (example)  
```tsx
<div className="flex gap-6 overflow-x-auto scrollbar-none snap-x snap-mandatory">
  {artists.map(a => (
    <img
      key={a.id}
      src={a.image}
      alt={a.name}
      className="h-16 w-16 rounded-full object-cover shrink-0 snap-center"
    />
  ))}
</div>
```

*Iterate until Self-check is green.*

---

## Question

{'asset_pointer': 'file-service://file-AN4WRLk2zZAGQe1GLVoU5W', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 621, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1285902, 'width': 1470}
I want to overhaul this pre-footer and the footer.

## Answer

**Claude Prompt – Pre-Footer & Footer Overhaul**

---

### Context  
Repo: **Next 15 + Tailwind 4.1**. Current files:

```
/components/PreFooterCTA.tsx
/components/Footer.tsx
/app/page.tsx  // imports both
```

### Goals  
1. **Pre-footer CTA** (gradient band) should feel like an Apple/Linear-style “one last push” section.  
2. **Footer** should be slimmer, high-contrast, with clear nav links and copyright—no dead space.

### Design Requirements  

#### Pre-footer CTA  
| Item | Requirement |
|------|-------------|
| Layout | Stack-centered, max-width `780px`, `text-center`, `py-24 lg:py-28`. |
| Headline | Keep text but split lines:<br>**Stop losing fans**<br>*to ugly link pages .* (italics smaller). |
| Subline | Reduce to 32 words max, `text-balance`, `text-lg text-slate-100/90`. |
| Button | `.btn-primary` = `rounded-full px-7 py-3 text-base font-semibold tracking-wide shadow-md hover:scale-105 transition`. |
| Gradient | Subtle 4-color 135° (`from-sky-500 via-violet-600 via-fuchsia-600 to-rose-600`) @ 90% opacity for AA contrast. |
| Motion | Fade-up + slight slide on scroll (`data-aos="fade-up"` placeholders). |

#### Footer  
| Zone | Requirement |
|------|-------------|
| Container | `max-w-[1200px] mx-auto flex flex-col lg:flex-row items-center justify-between gap-6 py-10 text-sm text-slate-500`. |
| Left | Jovie word-mark (24 px height) + “© 2025 Jovie. Made with 🤍 in LA.” |
| Center | Simple nav list → Privacy • Terms • Status • Twitter. Use `flex gap-5`. |
| Right | Tiny theme-toggle icon (existing) + subtle GitHub icon link. |
| Color | Pure white background, 1 px top border `border-slate-100`. |
| Accessibility | All links `hover:text-slate-900 focus-visible:outline-accent`. |
| Mobile | Stack with `gap-4` and center text. |

#### Shared  
- Tailwind 4.1 utilities only—no extra CSS files.  
- Keep components **client/server state** exactly as now.  
- Animations leverage existing AOS import; if unavailable, leave data-attributes.

### Implementation Rules  
1. **Unified diff** editing only the two component files + any shared button/utility class.  
2. Must pass: `npm run lint && npm run typecheck && npm run build`.  
3. After diff, provide “🔍 Self-check” table confirming build, ESLint, Lighthouse contrast → *all* “None”.  
4. Commit message: `feat(prefooter+footer): linear-style CTA & slim footer`.

---

*(Hand this to Claude; iterate until the Self-check is green.)*

## Question

{'asset_pointer': 'file-service://file-1XjWx1C5ny8A1QSWSuLzFY', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 805, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 191777, 'width': 1468}
Overhault the onboarding screen. It won't need to prompt for artist name or tagline, just handle

## Answer

**Claude Prompt – On-Boarding Screen Simplification**

---

### Context  
Repo stack: **Next 15 + Tailwind 4.1 + React-Hook-Form + Zod validation**. Current files:

```
/app/onboarding/page.tsx        // server wrapper that imports the form
/components/OnboardingForm.tsx  // client component with Artist, Handle, Tagline fields
/lib/validation/onboarding.ts   // zod schema used by the form
```

### Objective  
**Overhaul the onboarding UI** so we ask for **one thing only: the artist’s jov.ie handle**.  
All other fields (Artist Name, Tagline) were gathered earlier, so delete them.

### UX / UI Requirements  

| Area | Requirement |
|------|-------------|
| Layout | Vertically centered card-less layout, `max-w-[420px] mx-auto pt-[15vh] pb-[20vh]`. |
| Headline | “Welcome to Jovie” (h2, `font-semibold text-3xl`) |
| Subline | “Choose your jov.ie handle” (`text-slate-500 text-base mb-8`). |
| Handle Field |  |
|  • Prefix | Left-locked `span` inside the input showing `jov.ie/` (disabled text-slate-400). |
|  • Input | Tailwind `h-12 flex-1 bg-transparent outline-none` with `autoFocus`, placeholder `your-handle`, `maxLength=24`. |
|  • Inline Validation | show green check / red x icon at right on blur. Only lower-case a-z, 0-9, and hyphen. |
|  • Uniqueness Check | debounce fetch `/api/handle/check?handle=...` (already exists). |
| Primary CTA | **Continue** button spans full width below field: `btn-primary rounded-full py-3 mt-6 disabled:opacity-50`. Disabled until valid & available. |
| Secondary CTA | Tiny `text-xs text-slate-400 mt-4` → “You can change this later in Settings.” |
| Keyboard UX | <Enter> triggers submit when valid. |
| Motion | Slight input border glow on focus (`ring-2 ring-accent/40`). |
| Accessibility | `aria-live="polite"` for validation message. |

### Dev Tasks  

1. **Delete** Artist Name & Tagline inputs and their labels.  
2. **Shrink** Zod schema to `{ handle: z.string().regex(...) }`.  
3. Remove associated fields from form default values / mutations.  
4. **Adjust API route** (if needed) so it expects only `handle`.  
5. Update tests & types accordingly.

### Implementation Rules  

- **Tailwind 4.1 utilities only**; no external CSS.  
- Keep component boundaries (page = server, form = client).  
- Provide a **unified diff** touching only the three files above plus any test file you must fix.  
- Ensure `npm run lint && npm run typecheck && npm run build` succeed.  
- After diff, add **“🔍 Self-check”** table confirming:  
  1. Build passes?  
  2. ESLint/Type errors?  
  3. Lighthouse a11y warnings?  
  4. CLS issues?  
  *All should be “None”.*  
- Commit message: `feat(onboarding): simplify to handle-only flow`.

### Optional Polish (mention but don’t code now)  
- Handle suggestions if taken (`{handle}-music`, `{handle}-official`).  
- Animation when continue succeeds → subtle confetti.

---

*Iterate until the Self-check is green.*

## Question

Okay, knowing what the Joby product needs to do now, I'd like you to think through what needs to be built. And I'd like you to analyze our code base and then lay out basically lay out a list of tasks try and make them relatively small tasks like concise tasks of like specific limited function tasks of everything that we have to do to go from where our code base is currently at to a functioning MVP where someone can go through that whole flow to sign up and create a profile that works and is good enough that they can share it on like their Instagram and stuff like that. And order the tasks by priority. Key functionaries to get to a MVP that we can launch as soon as possible. https://github.com/itstimwhite/Jovie

## Answer

Below is an **MVP-critical work-plan** for Jovie, broken into bite-sized, developer-ticket-sized tasks and ordered by the fastest path to a share-worthy profile flow.  Each task is scoped to a single PR and should normally take <½ day.  (Anything larger is split.)  
  
---

## 0 · Project plumbing (blockers – must land first)

| # | Task | Key files / refs |
|---|------|------------------|
|0-A|**Fill `.env.local`** from `.env.example`; include Supabase URL/anon, Clerk keys, Spotify app creds. | `env.example` citeturn2view0 |
|0-B|**Verify RLS migrations run** ( `supabase/migrations/0001_init.sql` ) in local Supabase; add `npm run db:push`. | same |
|0-C|**CI gate** – ensure `lint · typecheck · build · vitest` run on PRs (workflow exists but enable “required” rule). | `.github/workflows` citeturn2view0 |

---

## 1 · Authentication & onboarding

| # | Task | Priority notes |
|---|------|----------------|
|1-A|**Enable Spotify OAuth** inside Clerk dashboard; copy provider ID to env. | Clerk docs citeturn7search0 |
|1-B|**Add <SignIn /> route** using Clerk’s social-only variant (hide password box). | Clerk examples citeturn7search2 |
|1-C|**Strip onboarding form to “handle-only”** (we already planned this). Update Zod schema & route. | onboarding screenshot; spec above |
|1-D|**Debounced handle-availability endpoint** `/api/handle/check` querying Supabase `artists.handle` unique index. | Supabase Next.js guide citeturn7search3 |
|1-E|**Create artist row** post-claim + store Clerk `userId`, Spotify `artistId`, handle, avatar. | RLS principles citeturn7search1 |

---

## 2 · Spotify ingest

| # | Task | Notes |
|---|------|-------|
|2-A|**Server action `fetchSpotifyArtist(artistId, token)`** – pulls name, picture, top 5 releases. | need OAuth token retrieval pattern citeturn7search4 |
|2-B|**Cron (Edge Function)** to refresh release list nightly; store in `releases`. | Supabase RLS realtime docs citeturn7search9 |

---

## 3 · Public profile (& tip variant)

| # | Task | Details |
|---|------|---------|
|3-A|**Dynamic route `/[handle]/page.tsx`** – fetch artist, releases, socials; SSR for SEO. | `app/[handle]/` dir exists citeturn3view0 |
|3-B|**Smart link component** – choose user’s last-clicked platform via `localStorage`; fallback to multi-platform list. | README feature list citeturn3view0 |
|3-C|**Add optional `/[handle]/tip` route** with Stripe Link / Apple Pay button (simple one-time payment). |   
|3-D|**Analytics call** on every outbound click → `click_events` Supabase insert. | Supabase quickstart citeturn7search5 |

---

## 4 · Marketing site polish (already 80 % done)

| # | Task | Notes |
|---|------|-------|
|4-A|Hero spacing + inline claim search (done earlier). |
|4-B|Circular avatar carousel with skeleton loaders (spec above). |
|4-C|Slim pre-footer + footer redesign (spec above). |

---

## 5 · Instrumentation & perf

| # | Task | Why |
|---|------|-----|
|5-A|**Segment JS snippet** guarded by `NEXT_

*(Answer truncated — 4250 chars total)*
