---
title: "MVP code audit prompt"
type: guide
created: 2025-09-06
updated: 2025-09-06
source: chatgpt-export
conversation_id: 68bc863a-28c4-8327-bb92-2fdaa5e09e9c
message_count: 2
tags: [chatgpt, import, code, long-form]
---
# MVP code audit prompt

> Conversation ID: 68bc863a-28c4-8327-bb92-2fdaa5e09e9c
> Created: 2025-09-06T19:06:54Z
> Updated: 2025-09-06T19:07:33Z
> Messages: 2

---

## User

As we continue building our MVP, I'm looking for help reviewing the codebase for things that might be wrong. For example, situations where there's multiple errors popping up and they need debouncing, or situations where the errors aren't using the toaster system properly. And those are specific examples that I just addressed. You know, situations like things where we have our unified design in the dashboard, and we have design tokens extracted, but maybe there are certain components that aren't using those tokens yet. Maybe there's duplicate logic across multiple components to do the same thing. Like a calculation that's not shared or extracted to a utility function or something. Things like that I'm trying to find. Or things that are broken, like buttons in the dashboard and stuff that don't actually do anything, like the backend logic hasn't been created yet. Or weird situations where you click a button, or maybe a situation where we're displaying your username before we've asked you to set your username, or it's always going to display blank, you know what I mean? So what I want to do is I want to prompt, an AI prompt that's well written, that I can give to Codex and have Codex go through the codebase and look at it and identify all of these kinds of things. I want to focus on things that are blocking for an MVP, I don't want to focus on things that are not going to be entirely obvious to me, just clicking through on the app and seeing myself, because I won't be able to just click through the app and see that there's duplicate code, and I won't be able to click through the app and see that necessarily all of the buttons don't function properly and stuff. I'm looking for things that are apparent if you're looking at the source code, but are less apparent if you're actually looking at the app.

---

## Assistant

Mr. White — here’s a single, drop-in prompt you can paste into Codex/Copilot/Claude Code to audit the repo for **MVP-blocking** source-level issues (not just things you’d notice clicking around). It’s tight, prioritized, and outputs both a human report and a machine-readable JSON for quick ticketing.

---

# PROMPT FOR CODE AUDIT (MVP BLOCKERS ONLY)

**Role:** You are a senior code auditor for a Next.js + TypeScript + Tailwind app with a shared design system and a unified toaster. Stack assumptions: Next.js 15, TypeScript, TailwindCSS (design tokens), shadcn/ui (where used), PostHog, Stripe, Drizzle + Neon, Vercel. Icons: Heroicons v2 (UI), SimpleIcons (brands).  
**Goal:** Identify **MVP-blocking** problems that are apparent in source code (not just visible in the UI). For each, provide: exact file path(s), line ranges, minimal repro/explanation, why it’s blocking, and a concrete fix (with patch/diff when feasible).  

## Scope (only flag if it impacts MVP)
1) **Error handling & toasts**
   - Multiple errors triggering repeatedly without **debounce/throttle**.
   - Errors/warnings **not using the centralized toaster** (or mixing ad-hoc alerts/modals/snackbars).
   - Toaster mis-use (e.g., raw strings instead of standard helper, missing severity mapping, no dedup key).
2) **Design system & tokens**
   - Components not using **design tokens** / theme variables when they should.
   - Hard-coded colors/spacing/typography that bypass tokens.
   - Shadow, radius, spacing, typography not aligned with tokens/utilities.
3) **Duplicate logic**
   - Repeated utility logic (e.g., same calculation, formatting, fetch wrapper) across files that should live in `/lib`, `/utils`, or a shared hook.
   - Inconsistent implementations of the same concern (e.g., date/price formatting, URL building, feature-flag checks).
4) **Dead or missing actions**
   - Buttons/menus/CTAs wired to **no-op handlers**, TODOs, or stub endpoints.
   - Client components calling **unimplemented server actions** or API routes; mismatched method signatures/types.
5) **State & UX correctness**
   - Rendering user properties (e.g., **username**) before they exist (null/undefined/empty) without a skeleton/fallback/guard → leads to blank or “undefined”.
   - Race conditions from unguarded async effects, missing `await`, or stale closures that affect onboarding or critical flows.
6) **API contracts & types**
   - Type drift between API/server actions and client consumers (incorrect DTOs, zod/schema mismatches, `any` masking problems).
   - Silent error swallowing in data loaders; missing error boundaries for route segments.
7) **Keyboard shortcuts & a11y**
   - Shortcut handlers not using the **centralized keyboard system**.
   - Interactive controls missing `aria-*`, proper roles, or focus traps (modals/dialogs).
8) **Icons**
   - Non-standard icons where Heroicons v2 or SimpleIcons equivalents exist.
9) **Feature flags & env**
   - PostHog/flag checks in client without safe defaults.
   - Secrets/env access on client that should be server-only.
10) **Performance that blocks UX**
   - Expensive sync work on render; N+1 fetches in critical routes; missing `revalidate`/caching on SSR where appropriate.

## What to ignore (unless it becomes a blocker)
- Minor lint/style nits, micro-perf that doesn’t affect MVP, purely aesthetic tweaks already consistent with tokens.

## How to search (examples—adapt as needed)
- Find non-toaster errors: `alert(`, `window.alert(`, `console.error(` used as UX, custom snackbars, direct DOM toasts.  
- Find repeated logic: identifiers like `formatPrice`, `buildShareUrl`, repeated regexes, similar `fetch` wrappers.  
- Find hard-coded styles: tailwind-less inline styles, raw hex colors, magic numbers for spacing/typography.  
- Find dead handlers: `onClick={() => {}}`, TODO/FIXME near handlers, routes returning 501/NotImplemented.  
- Find username hazards: components that render `user.username` without null guards/skeletons/defaults.  
- Find shortcut drift: `addEventListener('keydown'` outside the central shortcut module.  
- Find icon drift: imports from arbitrary icon packs when Heroicons v2/SimpleIcons exist.  
- Find noisy errors: repeated toast calls in loops/effects without debounce or `toastId` dedup.

## Output
Produce **two artifacts**:

1) **Report (Markdown)** prioritized by severity:
   - **Severity:** `BLOCKER` | `MAJOR` | `MINOR` (include only BLOCKER + MAJOR; mention MINOR count only).
   - For each finding:  
     - `Title`  
     - `Why it blocks MVP` (1–2 lines)  
     - `Paths + line ranges` (e.g., `apps/web/app/(dashboard)/page.tsx:120-162`)  
     - `Evidence` (tiny snippet)  
     - `Fix` (steps)  
     - `Proposed Patch` (unified diff if safe to auto-apply)

2) **JSON (machine-readable)** with this schema:
```json
{
  "generated_at": "<ISO8601>",
  "summary": { "blockers": 0, "majors": 0, "minors_count_only": 0 },
  "findings": [
    {
      "severity": "BLOCKER",
      "category": "errors_toaster|design_tokens|dup_logic|dead_action|state_ux|api_types|shortcuts|icons|flags_env|perf",
      "title": "string",
      "why_blocks": "string",
      "paths": [{"file": "string", "start": 0, "end": 0}],
      "evidence": "short code excerpt",
      "fix": ["step 1", "step 2"],
      "patch": "unified diff or empty string",
      "dedupe_key": "stable-id-for-tracking"
    }
  ]
}
```

## Rules
- **Prioritize BLOCKERS** first (things that break core flows, cause crashes, data loss, infinite spinners, or user-trust issues).  
- Prefer **centralization**: toaster, shortcuts, formatting, fetch wrappers, feature flags, and icons should route through shared utilities.  
- When proposing patches, **respect design tokens**, use **Heroicons v2/SimpleIcons**, and **unified toaster** helpers (dedup/debounce).  
- For duplicate logic, propose a **single shared utility/hook** and minimal call-site diffs.  
- For username/identity and onboarding, add **guards/skeletons** and fail-safe defaults.  
- Do **not** refactor broadly beyond what’s needed to remove the MVP blocker.

## Deliver
- Print the Markdown report first.  
- Then print the JSON block on a separate line starting with `===JSON===` (exact marker).  
- If you can generate clean patches, include them inline; otherwise provide precise edits.

---

If you’d like, I can also give you a one-liner follow-up prompt to have the agent **open Linear issues** per JSON finding, tagged by `MVP`, `BLOCKER/MAJOR`, and component owner.


## See Also
- [[chatgpt/chatgpt_ai-code-quality-audit]]
- [[chatgpt/chatgpt_audit-and-harden-prompt]]
- [[chatgpt/chatgpt_codex-audit-prompt]]
- [[chatgpt/chatgpt_landing-page-audit-prompt]]
- [[chatgpt/chatgpt_add-cloud-code-ci]]
