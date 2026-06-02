---
title: "AI engineering agent prompt"
type: essay
created: 2025-12-09
updated: 2025-12-10
source: chatgpt-export
conversation_id: 69376ff6-22ec-8326-bdc8-af9a85705b49
message_count: 42
tags: [chatgpt, import, code, long-form]
---
# AI engineering agent prompt

> Conversation ID: 69376ff6-22ec-8326-bdc8-af9a85705b49
> Created: 2025-12-09T00:40:23Z
> Updated: 2025-12-10T08:24:03Z
> Messages: 42


This is an AI agent inside of Windsurf. It already has knowledge of my entire tech stack and the specific code that I'm working on, so no need to include any of that. But I would like an AI prompt to give it to go through right now and run all of the unit tests and lint tests locally. Check for any errors and fix them. When everything is good, to commit and open a PR and then monitor that PR and make sure that PR clears all the tests on CI. If it doesn't, to fix all of those failures and then re-update and re-commit and update the PR and to work recursively and continue doing this until it passes through the CI. And then it goes into our CI, which auto-opens a promotion to production. When it's all passing on that, I then would like it to go in. It doesn't have to worry about it actually passing the production CI, just the main branch CI. But once it passes the main branch CI and is merged, then I'd like it to go in and run E2E tests locally and get all of the E2E tests passing. And when they are all passing, I would like it to then go back and work through the entire thing again, make sure unit tests and everything is passing, commit it, open a new PR, get that PR committed, and then get that going up to a production PR automatically through the CI. And I don't want it to stop until it's done all of that. At the end, if anything needs to be done to make E2E tests work in CI and production that isn't already set, like for some reason we have to configure some environmental variables or do something manually, I would like it to go through all of this process as much as it can without my input and then ask those questions or make those instructions at the end. But I don't believe it should need that. I believe that it already has everything that it needs to do. I want this to be concise. It doesn't have to get into the details of it too much. But what I would like it to do is to emphasize not stopping and make this a bulletproof prompt to make sure that it doesn't stop until it checks those markers. If we can insert one additional thing into this is to look at the logs for the unit tests and any unit tests that are over 200 milliseconds for it to refactor those and get them sub 200 milliseconds and then repeat this entire cycle again. If they are unit tests that for some reason can't be that fast and should be integration tests or whatever, then make sure that that gets flagged and dealt with however, respectively. But basically what I want is as much work to be done unattended because I'm about to set this and then walk away. And I'd like to come back and have it have done a serious amount of work without interruption or questions from me.


Here’s a prompt you can drop straight into Windsurf, Mr. White:

```text
You are an autonomous engineering agent with full access to this repo, its tests, and CI. Work completely unattended unless you are truly blocked by missing secrets/permissions or a hard safety constraint.

Goal:
1. Get ALL unit tests and lint checks passing locally.
2. Get a PR merged into main with those fixes, fully green on CI.
3. After that, get ALL E2E tests passing locally and merged via a separate PR, green on main CI.
4. Along the way, identify and optimize slow unit tests (>200 ms), or reclassify them appropriately, and repeat the full cycle until everything is green and optimized.

Use your existing knowledge of this codebase and stack. Do NOT ask me questions or wait for confirmation between steps unless you are completely blocked; when in doubt, make reasonable decisions and proceed.

Follow this loop:

1. **Sync & prepare**
   - Sync with the latest main branch.
   - Ensure dependencies, dev tools, and local environment are ready to run tests and linters.

2. **Unit tests + lint (local)**
   - Run the full unit test suite locally.
   - Run all lint/static analysis tools configured for this project.
   - Fix every failing test and every lint error/warning that should be fixed.
   - Iterate: re-run unit tests and lint locally until they are completely clean.

3. **Optimize slow unit tests**
   - Inspect the most recent unit test run results and/or logs.
   - Identify any unit tests whose execution time exceeds 200 ms.
   - For each such test:
     - First try to refactor code and/or test to bring its runtime under 200 ms without reducing coverage or weakening correctness.
     - If the test is inherently slow because it behaves like an integration test (e.g., network, DB, filesystem, external service, large fixtures):
       - Reclassify it appropriately (e.g., move to integration tests, adjust markers/tags/suites).
       - Make sure suite boundaries are clear (unit vs integration).
   - After optimizing/reclassifying slow tests, re-run all unit tests locally.
   - Repeat optimization until:
     - All unit tests are < 200 ms, OR
     - Any remaining >200 ms tests are explicitly treated as non-unit/integration tests and clearly documented (e.g., comments or test naming/markers).

4. **Commit + PR for unit/lint work**
   - When unit tests and lint are fully clean locally and unit-test performance rules are satisfied:
     - Create a focused commit (or commits) with clear messages summarizing the fixes/optimizations.
     - Push a branch.
     - Open a PR targeting main that includes all the unit, lint, and unit-test performance changes.

5. **Monitor CI for that PR**
   - Continuously monitor CI status for this PR (all configured jobs for main’s PR pipeline).
   - If any CI job fails (tests, lint, build, etc.):
     - Inspect CI logs.
     - Reproduce locally if needed.
     - Fix the root cause in the code/tests/config.
     - Re-run relevant tests locally to confirm.
     - Commit, push, and update the same PR.
   - Repeat this cycle until the PR’s CI is 100% green.
   - When CI is green, ensure the PR is merged into main (merge it yourself if you have permissions).

6. **Post-merge verification (main CI)**
   - Ensure the main branch CI run that includes your merged changes is green.
   - If main CI fails:
     - Diagnose from CI logs.
     - Create a follow-up branch/commit/PR as needed and repeat the same loop until main CI passes with your changes included.

7. **E2E tests (local)**
   - Once the main branch is green with the updated unit + lint + performance work:
     - Pull latest main.
     - Run the full E2E test suite locally.
   - Fix any failing E2E tests (or underlying code/config) and re-run them locally until the entire E2E suite passes.

8. **Full verification + PR for E2E work**
   - With all E2E tests passing locally:
     - Re-run unit tests and lint locally to verify nothing regressed.
     - Ensure the unit test performance rules are still satisfied.
   - Commit all E2E-related fixes and any additional changes needed.
   - Push a new branch and open a new PR targeting main for this E2E work.

9. **Monitor CI for the E2E PR**
   - Monitor CI for this new PR (all jobs that would run before merging into main).
   - For any CI failures:
     - Analyze logs, reproduce locally, fix, and push updates.
     - Re-run relevant tests locally to confirm.
   - Repeat until the E2E-related PR is fully green on CI and merged into main.

10. **Interaction with production / promotion CI**
    - Assume CI will auto-open a promotion to production after main is green.
    - You are NOT required to wait for production deployment to finish or to make production CI green.
    - However, if you detect that E2E or other tests would fail in CI/production due to missing configuration (env vars, secrets, external resources, etc.):
      - Go as far as you can without my input:
        - Add or adjust configuration that is safe and clearly correct.
        - Add checks, documentation, or code to fail fast with clear messages if something is missing.
      - At the very end, produce a concise summary of any remaining manual steps required (e.g., which env vars/secrets must be set in which CI/prod environment and why).

11. **Do not stop early**
    - Keep iterating through this process until all of the following are true:
      - All unit tests pass locally.
      - All lint checks pass locally.
      - No unit tests exceed ~200 ms without being explicitly and correctly reclassified as integration tests (with clear justification and documentation).
      - All E2E tests pass locally.
      - The main branch CI is green after merging your unit/lint/performance changes and your E2E-related changes.
    - Only then stop.

Final output:
- When completely done OR when you are truly blocked by missing credentials/permissions/manual configuration:
  - Output a short, structured summary including:
    - Current status of unit tests, lint, E2E tests (local and CI).
    - Links/identifiers of PRs merged or still open.
    - Any remaining manual steps needed (if any), with concrete instructions.
```


Give me the same for making sure every component in our dashbaord has proper skeleton loaders and all that jazz


Here you go, Mr. White — drop this straight into Windsurf:

```text
You are an autonomous engineering agent with full access to this repo, its tests, and CI. Work completely unattended unless you are truly blocked by missing secrets/permissions or a hard safety constraint.

Goal:
Ensure that every relevant component in the dashboard has a proper loading experience (skeleton loaders/placeholders/shimmers/etc.) that is consistent, performant, and accessible across the app, and get that work merged and green on CI.

High-level expectations:
- Do NOT ask me questions or wait for confirmation between steps unless completely blocked.
- Prefer existing patterns, components, and design tokens over inventing new ones.
- Only stop once you have fully implemented and wired loading states everywhere they should exist, and those changes are merged and CI-green on main (excluding production promotion CI).

Follow this loop:

1. **Discover dashboard surface area**
   - Enumerate all dashboard-related routes, pages, and views.
   - Identify all dashboard components that:
     - Fetch data or depend on async operations.
     - Are lazy loaded / code-split / wrapped in suspense or similar.
     - Show content that can take noticeable time to load under realistic conditions.
   - Build a clear internal map of: route → container component(s) → child components that need loading states.

2. **Audit current loading behavior**
   - For each dashboard route and component:
     - Determine what currently happens while data is loading (blank screen, spinner, skeleton, nothing, etc.).
     - Note where:
       - There is no loading UI.
       - Loading UI is inconsistent with our design system.
       - Loading UI is janky, misaligned, or misleading.
   - Prioritize “high-visibility” and “high-latency” areas first, but aim for complete coverage across the dashboard.

3. **Align with existing design system**
   - Inspect the existing design system / component library for:
     - Skeleton components, shimmer placeholders, loading rows/cards, etc.
     - Standard spacing, elevation, color, and motion tokens.
   - Prefer using and extending existing primitives over creating new ad-hoc loaders.
   - If a new skeleton primitive is genuinely needed:
     - Implement it in the shared UI library in a reusable way.
     - Keep it consistent with the existing typography, spacing, and theming.

4. **Implement skeleton loaders / loading states**
   For each dashboard component that needs a loading state:
   - Implement a visually appropriate skeleton or placeholder:
     - Match the approximate layout and density of the final content.
     - Keep it lightweight and avoid unnecessary heavy logic in loaders themselves.
   - Wire it into the component’s data-fetching logic:
     - Show skeleton while data is loading.
     - Hide skeleton and show real content once data is ready.
     - Handle error states gracefully and consistently (e.g., error banners, retry, etc.).
   - Where applicable:
     - Use Suspense (or equivalent) boundaries for async components.
     - Ensure nested loading states are coordinated so UX doesn’t flicker or double-load in weird ways.

5. **Accessibility and UX polish**
   - Ensure skeletons:
     - Are not announced as real content by screen readers (e.g., aria-hidden or similar approaches as appropriate).
     - Do not trap focus or create confusing tab order.
   - Avoid layout shift:
     - Skeletons should roughly match the size/shape of final content to reduce CLS.
   - Avoid infinite/ghost loading:
     - Confirm that skeletons will not remain visible forever if an error occurs.

6. **Performance and behavior checks**
   - Verify that adding skeletons does not significantly degrade performance:
     - No expensive synchronous work in loaders.
     - Avoid unnecessary re-renders or excessive DOM for placeholders.
   - Check both “cold load” and “navigating between dashboard views” scenarios.
   - Make reasonable optimizations if you observe regressions.

7. **Testing**
   - Add or update tests as appropriate:
     - Unit tests for components that verify loading state behavior.
     - Integration/UI tests (if applicable) that:
       - Confirm the presence of skeletons while data is loading.
       - Confirm skeletons disappear once data is loaded.
       - Confirm error states behave as expected.
   - Prefer deterministic patterns (mocking async) so tests are reliable and fast.

8. **Commit + PR for dashboard loading work**
   - Once all targeted dashboard components have correct loading states wired up, tested, and polished:
     - Run all relevant tests and linters locally.
     - Fix any failures.
     - Create focused commits with clear messages summarizing:
       - Skeleton/loader additions/changes.
       - Any new shared components.
       - Key behavior or accessibility improvements.
     - Push a branch and open a PR targeting main.

9. **Monitor CI for the PR**
   - Continuously monitor CI for this PR (all jobs required to merge to main).
   - For any CI failure:
     - Inspect logs, reproduce locally if needed.
     - Fix the root cause (tests, lint, type checks, build, etc.).
     - Re-run locally, then push updates to the same PR.
   - Repeat until the PR is 100% green on CI.
   - Ensure the PR is merged into main (merge it yourself if you have permissions).

10. **Post-merge verification**
   - Verify that the main branch CI run that includes your changes is green.
   - Spot-check the dashboard in realistic scenarios to confirm:
     - Skeletons show up correctly on slow loads.
     - No obvious regressions or weird transitions.

11. **Do not stop early**
   - Keep iterating through this process until all of the following are true:
     - Every dashboard route and component that should have a loading state has a proper skeleton/placeholder.
     - Loading behavior is consistent with the design system.
     - Loading states are accessible and do not cause bad UX (flicker, CLS, stuck loaders).
     - All new/updated tests are passing locally.
     - CI for the PR and main branch is fully green with these changes.
   - Only then stop.

Final output:
- When completely done OR truly blocked by missing credentials/permissions/manual configuration:
  - Output a short, structured summary including:
    - Which dashboard routes/components were updated and how their loading states now behave.
    - Any new shared skeleton/loading primitives created.
    - Links/identifiers for the PR(s).
    - Any remaining manual steps or design decisions that might need human review (if any).
```


Do an accessibility audit across dark mode and light mode for all dashbaord content in the same way. Make sure every button can be properly read and nothing clips in varied states


Here you go, Mr. White — drop this into Windsurf:

```text
You are an autonomous engineering agent with full access to this repo, its tests, and CI. Work completely unattended unless you are truly blocked by missing secrets/permissions or a hard safety constraint.

Goal:
Perform a thorough accessibility and visual robustness audit of the dashboard in BOTH light mode and dark mode. Ensure all dashboard content is readable, accessible, and visually correct in all interaction states (default, hover, active, focus, disabled, loading, error, etc.), with no clipping, truncation, or overlap issues. Get any required fixes merged and CI-green on main.

High-level expectations:
- Do NOT ask me questions or wait for confirmation between steps unless you are completely blocked.
- Prefer existing design tokens, theming utilities, and components.
- Only stop when dashboards are accessible and visually sound in both themes and states, and all changes are merged and main CI is green.

Follow this loop:

1. **Discover dashboard surface area**
   - Enumerate all dashboard pages/routes and key components (cards, tables, buttons, form controls, menus, modals, toasts, charts, etc.).
   - Focus on UI elements that:
     - Appear in both light and dark mode.
     - Are interactive (buttons, links, inputs, dropdowns, toggles).
     - Present critical information (text, metrics, statuses, errors).

2. **Audit theming and states (light + dark)**
   For each dashboard view and key component, in BOTH light and dark mode:
   - Inspect text and icon contrast against backgrounds:
     - Verify sufficient contrast (aim to meet or exceed WCAG AA where applicable).
     - Check primary, secondary, disabled, and subtle text.
   - Verify interactive states:
     - Default, hover, focus, active/pressed, disabled, loading, error/warning/success.
     - Ensure each state is visually distinguishable and readable in both themes.
   - Check layout robustness:
     - No text clipping, truncation, or overlapping with other elements.
     - No components spilling out of cards or containers on common screen sizes.
     - Buttons, inputs, and labels remain legible and not cut off in any state.

3. **Buttons and key controls**
   - For all button variants (primary, secondary, destructive, ghost, icon-only, link-style, etc.):
     - Verify label text is clearly readable in light and dark mode.
     - Confirm sufficient color contrast for text/icon, borders, and backgrounds.
     - Validate hover/active/focus/disabled/pressed/loading states look correct and are not clipped.
     - Ensure focus styles are visible and not obscured.
   - Apply similar checks to inputs, toggles, radio buttons, checkboxes, dropdowns, date pickers, etc.

4. **Validate against design system**
   - Compare against existing design tokens and components:
     - Colors, typography, spacing, radius, shadows, and focus indicators.
   - Ensure components use tokenized colors and theme-aware APIs where expected.
   - If inconsistencies are found (e.g., hard-coded colors that break in dark mode):
     - Refactor those components to use theme tokens appropriately.
   - Avoid one-off hacks; prefer improving shared components and themes so fixes propagate.

5. **Fix contrast, readability, and clipping issues**
   For each issue found:
   - Adjust to use proper tokens (foreground/background, border, accent, error, etc.).
   - Ensure improved contrast in both light and dark mode while staying consistent with the design language.
   - Fix clipping/truncation by:
     - Adjusting layout, padding, line-height, or wrapping.
     - Fixing flex/grid constraints or max-width/height.
   - Ensure icons remain visible and legible alongside text in all themes and states.

6. **Accessibility specifics**
   - Confirm focus-visible states are clear and accessible (e.g., visible outlines or other indicators in both themes).
   - Avoid using color alone to convey important information; ensure labels, icons, or patterns support state.
   - Check ARIA attributes and roles where relevant (buttons vs links, disabled vs aria-disabled, etc.).
   - Ensure disabled buttons/controls remain readable enough to understand their label and state.

7. **Responsive and edge cases**
   - Spot-check key dashboard views across:
     - Typical breakpoints (e.g., small, medium, large desktop).
     - Longer labels, dynamic content, and error messages.
   - Ensure that in both light and dark mode:
     - No clipping or overflow of button text or key labels.
     - No visual breakage when content grows (e.g., long resource names, overflowing metrics).

8. **Testing**
   - Add/extend tests where feasible:
     - Visual or snapshot tests for theme variants (light and dark) of critical components.
     - Unit or integration tests that verify key accessibility attributes (e.g., correct roles, aria-*, focus behavior).
   - Keep tests deterministic and fast.

9. **Commit + PR for accessibility/theming fixes**
   - Once you have a cohesive set of fixes for light/dark mode accessibility and layout issues:
     - Run all relevant tests and linters locally.
     - Fix any failures.
     - Create clear commits summarizing:
       - Contrast/readability fixes.
       - Theming/tokenization changes.
       - Layout/clipping bug fixes.
       - Accessibility improvements (focus states, ARIA, etc.).
     - Push a branch and open a PR targeting main.

10. **Monitor CI for the PR**
    - Monitor CI for this PR across all jobs.
    - For any CI failure:
      - Inspect logs, reproduce locally as needed.
      - Fix the underlying issue (tests, type checks, build, lint).
      - Re-run locally, then push updated commits.
    - Repeat until the PR is 100% green on CI.
    - Ensure the PR is merged into main (merge it yourself if you have permissions).

11. **Post-merge verification**
    - Verify that the main branch CI run with your changes is green.
    - Spot-check key dashboard flows in both light and dark mode after merge:
      - Confirm buttons and interactive elements are readable and not clipped in all states.
      - Confirm there are no obvious regressions.

12. **Do not stop early**
    - Keep iterating until ALL of the following are true:
      - Dashboard content (text, icons, buttons, controls) is readable and has sufficient contrast in both light and dark mode.
      - All buttons and interactive components are visually correct and unclipped across states (default, hover, active, focus, disabled, loading, error, etc.).
      - Layouts do not clip or overlap important content at common breakpoints.
      - Relevant tests and linters pass locally.
      - CI for the PR and main branch is fully green with these accessibility/theming fixes.
    - Only then stop.

Final output:
- When completely done OR truly blocked by missing credentials/permissions/manual configuration:
  - Output a short, structured summary including:
    - The main classes of issues found and how they were fixed.
    - Examples of key components/routes improved (buttons, forms, cards, navigation, etc.).
    - Any new or updated theme tokens/components.
    - Links/identifiers to the PR(s).
    - Any remaining manual or design-review steps (if any).
```


{'asset_pointer': 'sediment://file_00000000a74c71fd823d874c974c53d0', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 588, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 269837, 'width': 1359}
I want a micro animation that make the card border like shimmer. Like a Len flare that runs around the whole border once. How can I do that? Tailwind css


Mr. White —

Yes, you can get a border shimmer / lens-flare effect around a card **fully in Tailwind CSS**, with no JS required. The trick is:

1. Wrap the card in a `relative` container
2. Create an absolutely-positioned `::before` or extra div that:
   - Has a gradient
   - Is bigger than the card
   - Animates its position or rotation
   - Is clipped to only show on the border
3. Use `mask`, `mask-composite` or `background-clip: content-box` to keep it to the border

### **Example: animated border shimmer (one full lap)**

```html
<div class="relative rounded-xl p-6 bg-neutral-900">
  <!-- Shimmer border -->
  <div class="absolute inset-0 rounded-xl pointer-events-none border-[2px] border-transparent animate-border-shimmer"></div>

  <!-- Your card content -->
  <div class="relative">
    <h3 class="text-white font-semibold">Tim White on YouTube</h3>
    <p class="text-neutral-400 text-sm">https://www.youtube.com/@timwhite</p>
  </div>
</div>
```

### **Tailwind CSS (extend section)**
```js
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      keyframes: {
        'border-shimmer': {
          '0%':   { 'background-position': '0% 0%' },
          '100%': { 'background-position': '200% 200%' },
        },
      },
      animation: {
        'border-shimmer': 'border-shimmer 2.5s linear infinite',
      },
    },
  },
}
```

### **Utility classes for the shimmer layer**
Add via `@layer utilities`:

```css
@layer utilities {
  .animate-border-shimmer {
    background: linear-gradient(
      115deg,
      rgba(255,255,255,0) 0%,
      rgba(255,255,255,0.8) 50%,
      rgba(255,255,255,0) 100%
    );
    background-size: 200% 200%;
    mask: 
      linear-gradient(#000 0 0) content-box, 
      linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    padding: 2px;
  }
}
```

### **How this works**
- The shimmer layer is **just a gradient moving behind a border**
- The `mask-composite: exclude` forces the gradient to show **only where the border is**
- The `200% background-size` + animation gives you that **lens-flare sweep**

---

# ⭐ OPTIONAL: one-time shimmer on hover
If you want the shimmer to play **once when the card is hovered**, instead of infinite:

```css
.animate-border-shimmer-once:hover {
  animation: border-shimmer 1.5s linear 1 forwards;
}
```

Then:

```html
<div class="relative rounded-xl p-6 bg-neutral-900 hover:animate-border-shimmer-once">
  ...
</div>
```

---

# ⭐ OPTIONAL: rotate-around-the-border shimmer
If you want it to look like a **lens flare that physically travels around the perimeter**, do this instead:

```css
@layer utilities {
  .animate-lens {
    --d: 3px;
    border-radius: inherit;
    position: absolute;
    inset: calc(var(--d) * -1);
    background: conic-gradient(
      from 0deg,
      transparent 0deg,
      transparent 250deg,
      rgba(255,255,255,0.8) 275deg,
      transparent 360deg
    );
    animation: lens-spin 2s linear infinite;
    mask:
      linear-gradient(#000 0 0) content-box,
      linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    padding: var(--d);
  }

  @keyframes lens-spin {
    to { transform: rotate(360deg); }
  }
}
```

Usage:

```html
<div class="relative rounded-xl p-6 bg-neutral-900">
  <div class="animate-lens pointer-events-none"></div>
  <!-- content -->
</div>
```

This one is **closest to a real lens flare** because the conic gradient rotates like a flashlight around the border.

---

# 🔥 Best for you

Given your dashboard aesthetic, the **conic-gradient rotating shimmer** is the sexiest and matches your cards visually.

No JS, no framer-motion, no SVG, pure Tailwind + CSS.

---

If you want, I can:

- convert it into a reusable Tailwind component
- add dark/light theme awareness
- make it trigger on selection state rather than hover
- reduce GPU use for mobile
- do a one-shot shimmer after mount (more cinematic)

Just tell me what vibe you want.


Explain vercel blob storage and how we should use it for profile image storage. Specifically should each env have its own blob storage or what


Short version: Vercel Blob is basically “S3-lite built into Vercel,” great for things like profile images. For environments: **yes, treat each environment as logically separate**, but how you do that can vary.

I’ll keep this tight and opinionated.

---

## 1. What Vercel Blob actually is (for our use case)

- It’s a **key/value object store** managed by Vercel.
- You push files via API or upload URL; Vercel gives you a **public, CDN-backed URL**.
- You don’t manage buckets directly; you manage **“stores”** via the dashboard/config and access them via tokens/env vars.
- It’s ideal for:
  - User uploads (profile images, attachments)
  - Static-ish blobs that don’t need complex ACLs
- No need to run your own S3, CloudFront, etc.

For profile images, the flow is typically:

1. Client requests an upload URL from your backend.
2. Backend uses Vercel Blob API + token to generate upload URL.
3. Client uploads image directly to Blob.
4. Blob returns the final URL.
5. You store that URL on the `User` record in your DB.

---

## 2. Environment strategy: shared vs separate

You have two main patterns:

### Option A: Separate store per environment (recommended)

**Idea:**  
- `BLOB_READ_WRITE_TOKEN` / `BLOB_STORE_ID` (or equivalent) is **different** for dev, preview, prod.
- Each environment writes to its own Blob store.

**Pros:**
- **Isolation**: No chance of dev/preview code nuking prod files.
- **Cleanup**: You can blow away dev/previews without worrying about prod.
- **Privacy/safety**: Test data, fake users, etc. don’t mix with real users.
- **Debuggability**: If you see a weird file in prod, you know it came from prod.

**Cons:**
- Slightly more setup in Vercel dashboard.
- If you copy DB snapshots between envs, image URLs will point to whatever store they were created with (you may want a migration or fallback strategy).

**How to wire it:**

- In Vercel:
  - Create blob store(s) as needed.
  - Add env vars per environment:
    - `BLOB_STORE_URL` / `BLOB_READ_WRITE_TOKEN` for Production
    - Different values for Preview
    - Different again for Development (can even be local `.env` only).

Your code just reads from env:

```ts
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN!;
const BLOB_STORE = process.env.BLOB_STORE_URL!;
```

No branching in code; env switches behavior.

**This is what I’d do for real user-facing profile images.**

---

### Option B: Single shared store, namespaced by environment

**Idea:**  
One Blob store, but keys are prefixed:

- `prod/users/{userId}/avatar.jpg`
- `preview/users/{userId}/avatar.jpg`
- `dev/users/{userId}/avatar.jpg`

**Pros:**
- Only one store to manage.
- If you clone DB between envs, URLs can keep working if you don’t change the domain / base URL.

**Cons:**
- Blast radius: bug in preview can overwrite or delete “prod” objects if your code is wrong.
- Harder to “just delete dev stuff”.
- Less clean separation for audits/compliance.

**I’d only do this for non-critical or internal apps.**

---

## 3. What I recommend for your profile photos

For anything user-facing and production-grade:

1. **Use separate stores / credentials per environment.**
   - Configure Production, Preview, Development separately in Vercel env settings.
   - Same code, different env vars.

2. **Use stable keys per user, per environment.**
   - Example object key:  
     `users/${userId}/profile-${timestamp}.${ext}`  
   - Save the final URL in your DB.

3. **Decide on public vs signed URLs.**
   - Most apps are fine with **public profile images**:
     - Blob gives you a public HTTPS URL you embed directly in `<img>` tags.
   - If you want more privacy (e.g. non-public images), you’d add a layer (proxy route) that checks auth and then reads from Blob.

4. **Handle replacement / cleanup.**
   - When a user uploads a new profile image:
     - Upload new one.
     - Update `user.profileImageUrl`.
     - Optional: delete old blob asynchronously to keep storage clean.

---

## 4. Migration / DB snapshot gotcha

If you:

- Clone production DB into staging, and
- Staging uses a **different** blob store,

then your copied users’ `profileImageUrl` fields will still point at prod URLs.

You have three options:

1. **Accept it.**  
   Staging shows real prod profile images – often fine.
2. **Rewrite URLs during snapshot restore.**  
   Run a script that replaces the base URL to point to staging’s store.
3. **Use env-agnostic blob domain and separate stores behind the scenes.**  
   More complex; usually not worth it early on.

Most teams just accept staging hitting prod images or don’t care that much.

---

## 5. Concrete setup checklist

For your app:

- **Vercel dashboard:**
  - Create a Blob store for production (and optionally separate ones for preview/dev).
  - Generate read/write tokens per store.
  - Add these as env vars:
    - `BLOB_READ_WRITE_TOKEN`
    - `BLOB_STORE_URL` (or whichever Vercel Blob env var you need).

- **Code:**
  - Backend API route:
    - Verifies user.
    - Creates an upload URL with a key like `users/${userId}/profile-${Date.now()}.jpg`.
    - Returns upload URL + future public URL.
  - Frontend:
    - Uses that upload URL for direct upload.
    - When done, calls backend to set `profileImageUrl` to the final blob URL.

- **Environments:**
  - Production uses the prod blob store.
  - Preview uses its own (or shares prod if you explicitly decide you’re okay with that).
  - Local dev can either:
    - Use a “dev” blob store with separate credentials (my default suggestion), or
    - Just hit staging/prod for convenience while building.

---

If you tell me what your current environments are (prod / preview / local / “staging”) and how you move DBs between them, I can give you a very explicit env-matrix of “this env uses this store, these URL patterns, and this behavior.”


How should I name the blob storage tokens


Mr. White — best practice is **names that describe both environment and capability**, and they should be clearly machine-readable and human-readable.

You will typically have TWO env vars per environment:

- **READ_WRITE_TOKEN** (backend only)
- **PUBLIC_URL or STORE_URL** (where assets live)

So the naming conventions should look like this:

---

# ✅ **Production**
```
VERCEL_BLOB_PROD_READ_WRITE_TOKEN
VERCEL_BLOB_PROD_PUBLIC_URL
```

---

# ✅ **Preview / Staging (CI, PRs, QA)**
```
VERCEL_BLOB_PREVIEW_READ_WRITE_TOKEN
VERCEL_BLOB_PREVIEW_PUBLIC_URL
```

---

# ✅ **Local / Development**
```
VERCEL_BLOB_DEV_READ_WRITE_TOKEN
VERCEL_BLOB_DEV_PUBLIC_URL
```

---

# ⭐ Why this naming style is correct

- **Prefix with the platform** (VERCEL_BLOB)  
  Makes grepping, tracing ownership, and onboarding very clean.

- **Include environment explicitly** (PROD, PREVIEW, DEV)  
  Never ambiguous which env you’re looking at.

- **Describe purpose** (READ_WRITE_TOKEN vs PUBLIC_URL)  
  You will always know which token is for upload and which URL is for consumption.

- **Uppercase + underscores**  
  Conventional for env vars and works well in Vercel’s dashboard.

---

# ⭐ If you want a slightly shorter style (still correct)

```
BLOB_PROD_TOKEN
BLOB_PROD_URL

BLOB_PREVIEW_TOKEN
BLOB_PREVIEW_URL

BLOB_DEV_TOKEN
BLOB_DEV_URL
```

Works fine, still very readable.

---

# ⭐ If you want the most future-proof style (my personal favorite)

```
BLOB__ENV__TOKEN
BLOB__ENV__URL
```

Meaning:

```
BLOB__PROD__TOKEN
BLOB__PROD__URL

BLOB__PREVIEW__TOKEN
BLOB__PREVIEW__URL

BLOB__DEV__TOKEN
BLOB__DEV__URL
```

The **double-underscore field boundary** is REALLY nice for tooling, because you can safely parse:

- prefix = `BLOB`
- environment = `PROD`
- capability = `TOKEN`

This is the cleanest if you ever build automation.

---

# ❌ **Never do this**
```
TOKEN
URL
BLOB_TOKEN
BLOB_URL
```

Too vague, dangerous, impossible to reason about environments in a pinch.

---

# ⭐ What the backend code should do

```ts
const token = process.env[
  `BLOB_${process.env.APP_ENV.toUpperCase()}_TOKEN`
]!;
```

Where:

```
APP_ENV=prod | preview | dev
```

Then you don’t hardcode env branching.

---

# 🔥 Final answer

If you want the simplest + safest + scalable naming:

```
BLOB_PROD_TOKEN
BLOB_PROD_URL
BLOB_PREVIEW_TOKEN
BLOB_PREVIEW_URL
BLOB_DEV_TOKEN
BLOB_DEV_URL
```

This is the one I’d use for your profile image system, Mr. White.


Should we only have one for everything. Or profile images get one and other stuff gets another etc


Short answer, Mr. White: **one store per env, one token per env, many prefixes.** Don’t over-split unless you have a real reason.

### How to think about it

There are two axes:

1. **Store** – where the bytes live.
2. **Token** – who can touch which keys in that store (optionally restricted by prefix/path).

For your app:

- **Prod:** 1 Blob store  
- **Preview:** 1 Blob store  
- **Dev/local:** 1 Blob store (or none, hit preview)

Inside each store, just namespace keys:

- `profiles/{userId}/avatar-<timestamp>.jpg`
- `posts/{postId}/image-<timestamp>.jpg`
- `uploads/{someFeature}/…`

And have a **single READ_WRITE token per env** in your backend env vars.

### When to create multiple tokens/stores

Only split when you actually need:

- Different **permissions** (e.g. a token restricted to `profiles/` that you might use in a limited context, another for `attachments/`).
- Different **retention / cleanup policies** (e.g. ephemeral exports vs long-lived profile photos).
- Different **projects/teams/billing**.

If you don’t have those constraints yet:

- Use **one Blob store per environment**.
- Use **one backend token per environment**.
- Namespace with prefixes for profile images vs everything else.

You can always introduce extra tokens later if you need stronger isolation.


Finally we're based in LA. Most customers are use based in la or nyc. Where should the blob storage live


Mr. White, for your setup (LA-based team, mostly LA/NYC users):

### 1. What actually matters

For profile images + typical web assets, the key latency is:

- **Origin region** (where Blob physically lives)
- **CDN edge** (where it’s cached)

Vercel Blob is fronted by Vercel’s CDN, so once an image is requested, it’s cached near the user. That means:

- West-coast users hit a west-coast edge
- East-coast users hit an east-coast edge

So region choice mostly affects:

- First request / cache miss latency
- Where data “at rest” lives (compliance / privacy)

### 2. Region choice for you

Given:
- Team in LA
- Users mainly on US coasts
- No special EU/geo-compliance requirements mentioned

You should:

- Pick a **US region**, preferably **US-West** (e.g. `iad` vs `lax` style region naming will depend on Vercel’s UI, but you want *a US region, ideally west*).
- Let Vercel’s CDN handle fast delivery to NYC users via edge caching.

Why west?

- Slightly better latency for your own tools, local dev, any origin hits.
- NYC users will still be fine because of the CDN, and cross-US latency for a cache miss is still acceptable for profile images.

If Vercel Blob gives you only a generic “US” option (no per-city), just choose **US** and move on—that’s the right bucket for you.

### 3. When you’d do something different

You’d only worry about multiple regions if:

- You have strict data residency requirements (e.g. must live in EU).
- You’re doing low-latency, non-cached binary access in multiple continents.

For profile images in a US-focused SaaS: **one US region is perfect.**

So: **Use a single US/US-West Blob store per environment, rely on Vercel’s edge caching, and don’t overthink it.**
