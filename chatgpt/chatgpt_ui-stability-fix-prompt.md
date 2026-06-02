---
title: "UI stability fix prompt"
type: guide
created: 2025-08-18
updated: 2025-08-18
source: chatgpt-export
conversation_id: 68a38ef2-0278-8323-8ce6-541a1ec0af23
message_count: 2
tags: [chatgpt, import, code, long-form]
---
# UI stability fix prompt

> Conversation ID: 68a38ef2-0278-8323-8ce6-541a1ec0af23
> Created: 2025-08-18T20:37:10Z
> Updated: 2025-08-18T20:38:30Z
> Messages: 2

---

## User

Give me a prompt that can go through all of our components and fix issues where there's layout shift or fix issues where there's redundant loaders like there's two different spinning icons or something or fix things where like when there's a loading state on the button the button changes size or fix things where you know if our like artist profile pictures don't display because the database isn't connected and then all sudden it connects there's layout shift stuff like that or situations where like when you type in a username and it validates it or you type in an email in a form and it validates it it goes with a green checkmark then it switches to a loader then a green checkmark then a loader then a green checkmark even though you're not typing anything new all of those issues that I just described I just want you to kind of give me an AI prompt to make an AI blanket look at all of our UI components and create fixes for each one of those but I want to keep them minimal and I want to keep them to the UI only because I don't want to create a bunch of conflicts while we're doing a bunch of big database and integration work separately on the code base

---

## Assistant

Got it, Mr. White. Here’s a single, drop-in “make the UI sane” prompt for Claude/Copilot/Windsurf. It keeps changes UI-only, minimizes diffs, and targets CLS/layout shift, spinners, and validation thrash.

---

# Prompt: UI Stability + Loading/Validation Cleanup (UI-Only)

**Context**
- App: Next.js 15 + React, Tailwind, shadcn/ui, Heroicons.
- Constraints: **UI-only** changes. **Do not** modify APIs, DB schemas, server actions, or RLS. No feature additions, only stability/UX fixes.
- Goals: Eliminate layout shift (CLS), unify loading states, prevent size jumps, stop validation “thrash” (loader ↔ checkmark loops), and add robust fallbacks.

**Global Requirements**
1. **Zero/Minimal CLS**
   - Every component that loads late content must reserve space up front (fixed width/height, `aspect-square`, `min-h`, skeleton rows, `next/image` with `width` & `height`).
   - No text reflow on load: preserve line count and container size.

2. **Unified Loaders**
   - Replace ad-hoc spinners with a single `<LoadingIndicator />` and `<Skeleton />` pattern.
   - Spinner shows only if work > 300ms; otherwise show nothing (prevents flicker).
   - Never stack multiple loaders in the same view.
   - Keep icons from shifting: reserve an empty icon slot (`opacity-0`/`invisible`) when idle.

3. **Buttons: No Size Jumps**
   - Buttons must **not** change size between idle/loading/success/error.
   - Enforce fixed **height**, stable **horizontal padding**, and **reserved icon slot**.
   - Example Tailwind: `inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl transition-[opacity,transform]`
   - Loading state = replace label **visually** without changing layout (e.g., swap text with `aria-live` off-screen or keep label and overlay spinner absolutely positioned).

4. **Form Validation: No Thrash**
   - Debounce async validation (≥ 400ms) and **only** revalidate on value change.
   - Use a tiny state machine: `idle → validating → valid|invalid`. Do **not** return to `validating` unless the input value has changed.
   - Keep last result stable; don’t alternate checkmark/loader when nothing changed.
   - Distinguish **format** validation (instant) vs **server/unique** validation (debounced async).
   - Accessibility: `aria-invalid`, `aria-describedBy`, `aria-live="polite"` for messages; never flicker messages.

5. **Avatars/Images: No Jumps**
   - Use `next/image` with explicit `width/height` (or container with fixed size + `fill`).
   - Reserve exact square for avatars (`aspect-square w-10 h-10`) + meaningful fallback (initials) with background color.
   - If data arrives late (e.g., DB connect), content **must not** push layout.

6. **Lists/Cards/Grids**
   - Show skeleton rows/cards with **same dimensions** as final content.
   - Paginated/infinite lists: reserve row height; avoid “pop-in” reflow.

7. **Icons/Status**
   - Single source of truth for status icons (`<StatusIcon state="idle|loading|success|error" />`), consistent size (`w-4 h-4`) to prevent jumps.
   - Success icon persists until value changes again.

8. **A11y/ARIA**
   - Mark busy regions with `aria-busy="true"` while loading without changing layout.
   - Use `aria-live="polite"` for validation messages (no rapid announce loops).

9. **DX & Safety**
   - Small, isolated PRs by feature area. No new deps. No Storybook requirement.
   - Add **component tests** (Playwright/React Testing Library) only where trivial: assert no height/width change across states.

**Implementation Tasks (apply repo-wide)**
1. **Create shared UI primitives** (or update if they exist):
   - `components/ui/LoadingIndicator.tsx` → fixed box, 16–20px spinner; accepts `className`, `label?` for screen readers only.
   - `components/ui/Skeleton.tsx` → size-controlled blocks/rows; no content shift.
   - `components/ui/StatusIcon.tsx` → renders one of: idle (empty reserved space), loading (spinner), success (check), error (x). Always `w-4 h-4`.
2. **Buttons**
   - Refactor all buttons with loading to use **stable layout**:
     - Keep label in DOM; overlay spinner absolutely (`relative` parent + `absolute inset-y-0 left-3`).
     - Or reserve left icon slot with `w-4`.
     - Prevent width change; never swap text length during loading.
3. **Forms**
   - Add `useAsyncValidation` hook:
     - Inputs: `value`, `validateFn` (async), `debounceMs=400`.
     - State: `{status:'idle'|'validating'|'valid'|'invalid', error?}`.
     - Only run `validateFn` when `value` changes (strict equality), cancel in-flight on change, and don’t re-run on identical result.
     - Expose `showSpinner` = `status==='validating' && lastRunDuration>300ms`.
   - Replace per-field loaders/checkmarks with `<StatusIcon state=… />`.
4. **Avatars/Images**
   - Wrap all avatar usages with a shared `Avatar` that:
     - Reserves `w-10 h-10 aspect-square rounded-full overflow-hidden bg-muted`.
     - Uses `next/image` with fixed size or `fill` inside a fixed container.
     - Fallback initials with same size/line-height; never triggers reflow.
5. **Lists & Cards**
   - Replace “loading…” text with skeleton rows/cards **matching** final dimensions.
   - Keep parent container height stable during fetches and pagination.
6. **Validation Messages**
   - One-line height reserved below inputs (`min-h-[20px]`) to avoid jump when messages appear/disappear.
   - Animate opacity, not layout (`transition-opacity`).
7. **Remove Duplicate Loaders**
   - Grep for loader/spinner duplicates; replace with shared `<LoadingIndicator />`.
   - Ensure only one loader per visual region.
8. **Prevent Micro-flicker**
   - Gate fast completes: if an async call returns < 200–300ms, don’t show spinner; keep idle state to avoid flash.

**Code Patterns (use these)**
- **Stable Button**
  ```tsx
  <button
    className="relative inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 disabled:opacity-70"
    aria-busy={loading || undefined}
    disabled={loading}
  >
    <span className="w-4 h-4 shrink-0">
      <StatusIcon state={loading ? 'loading' : success ? 'success' : 'idle'} />
    </span>
    <span className="pointer-events-none select-none">{label}</span>
    {/* Right-side placeholder to keep symmetry if needed */}
    <span className="w-4 h-4" />
  </button>
  ```
- **Skeleton Row**
  ```tsx
  <div className="grid grid-cols-[40px_1fr_80px] items-center gap-3 h-14">
    <Skeleton className="w-10 h-10 rounded-full" />
    <Skeleton className="h-4 w-2/3 rounded" />
    <Skeleton className="h-4 w-16 justify-self-end rounded" />
  </div>
  ```
- **Avatar Wrapper**
  ```tsx
  <div className="relative w-10 h-10 rounded-full overflow-hidden bg-muted">
    <Image src={src ?? fallback} alt={name} fill sizes="40px" className="object-cover" />
  </div>
  ```
- **Validation Hook Sketch**
  ```ts
  const { status, error } = useAsyncValidation(value, validateFn, { debounceMs: 400, minSpinnerMs: 300 });
  // Render <StatusIcon state={status==='validating'?'loading':status==='valid'?'success':status==='invalid'?'error':'idle'} />
  ```

**Acceptance Criteria (automated/manual)**
- Buttons: measure before/after **width & height are identical** across idle/loading/success/error.
- Inputs: with hands off keyboard, status **does not** bounce between loader/checkmark.
- Avatars/images: no layout shift when source loads or switches.
- Lists/cards: replacing skeletons with data causes **no container resize**.
- No component renders >1 spinner at a time; spinners never appear for <200ms.
- Lighthouse/CLS: **no layout shifts triggered by our components** during normal data fetch.

**What to Submit**
- Small PRs by area (Buttons, Forms, Avatars, Lists).
- Diff summary + short reasoning per change.
- Before/after GIFs for at least one case in each area.
- No backend code touched.

---

Use this verbatim. If you want, I can tailor it to your actual folder structure and component names next.
