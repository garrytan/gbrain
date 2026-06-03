---
title: "Refined PR rules"
type: guide
created: 2025-08-23
updated: 2025-08-23
source: chatgpt-export
topic: design-ux
message_count: 8
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# Refined PR rules

> **Source:** ChatGPT conversation
> **Date:** 2025-08-23T23:38:07Z
> **Messages:** 8
> **Topic:** design-ux

## Question

Consolidate and refine these rules

## intent
Run a fast, deterministic **smoke test** before opening a PR. **Always open the PR** afterward (pass or fail) with a structured checklist so it can enter the Merge Queue when ready. Follow **Y Combinator best practices** (ship fast, small diffs, tighten feedback loops), take **Linear**-style design inspiration (clarity, minimalism), and aim for **Apple-level UX polish and copywriting** (concise, humane, on-brand).

## triggers
- on: linear.issue_labeled(codegen|ready) OR local.command("prepare-pr") OR vcs.branch_created("feat/*","fix/*","chore/*")

## env
- NODE_VERSION: 20
- PACKAGE_MANAGER: pnpm

## steps
1. checkout → new branch if needed  
2. install: `pnpm i --frozen-lockfile`  
3. **smoke-lint:** `pnpm lint --max-warnings=0`  
4. **smoke-types:** `pnpm typecheck`  // `tsc --noEmit`  
5. **smoke-tests:** `pnpm test:unit --run -t "smoke|happy|render"`  
6. **smoke-build:** `pnpm build -n || vite build --emptyOutDir false`  
7. **ui-sna

## Answer

Here’s a consolidated and refined version of your ruleset — I collapsed duplication, clarified sequence, and kept everything tight but complete.  

---

# 🚦 Jovie PR & Integration Rules

## 1. Intent
- Always run a **fast, deterministic smoke test** before opening a PR.  
- **Always open the PR** (pass or fail) with structured output so it can enter Merge Queue when ready.  
- Follow **YC best practices** (ship small, fast, tighten loops), design like **Linear** (clarity, minimalism), and hold bar for **Apple-level UX & copywriting** (concise, humane, benefit-oriented).  

---

## 2. Triggers
Open PR when:  
- `linear.issue_labeled(codegen|ready)`  
- `local.command("prepare-pr")`  
- `vcs.branch_created("feat/*","fix/*","chore/*")`  

---

## 3. Environment
- `NODE_VERSION=20`  
- `PACKAGE_MANAGER=pnpm`  

---

## 4. Smoke Steps
1. Checkout → new branch if needed  
2. Install deps: `pnpm i --frozen-lockfile`  
3. **Lint:** `pnpm lint --max-warnings=0`  
4. **Types:** `pnpm typecheck` (`tsc --noEmit`)  
5. **Unit (smoke):** `pnpm test:unit --run -t "smoke|happy|render"`  
6. **Build:** `pnpm build -n || vite build --emptyOutDir false`  
7. **UI snapshot (optional):** `pnpm story:build || true`  
8. Summarize → PR body  

---

## 5. Policy
- Don’t reformat files beyond the change set.  
- Don’t touch infra/pipeline files (`.github/workflows/**`, `infra/**`) unless issue requires.  
- Keep diffs **small, focused slices** (≤300 LOC touched).  
- No naked TODOs; clear names only.  
- Copywriting: short, specific, no filler.  

---

## 6. Failure Behavior
- Still open PR.  
- Labels: `needs-human`, `smoke-failed`. Remove `automerge`.  
- Title prepended with ❌. Include logs summary in body.  
- Never queue auto-merge until smoke passes.  

---

## 7. Success Behavior
- Labels: `ready-for-review`, `automerge-candidate`.  
- Title prefix: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `perf:`, `test:`.  
- Auto-enable squash auto-merge if all checks are green.  

---

## 8. PR Template
**Always open PRs with:**  

**Title**  
```txt
{{ status_emoji }} {{ type_prefix }}{{ concise_title }}
```

**Body**  
```md
## Summary
- **Why**: {{ problem_statement }}
- **What**: {{ solution_slice }}
- **Risk**: {{ risk_note }}
- **UX**: Apple-level polish; copy trimmed for clarity.

## Smoke Result
- Lint: {{ lint_status }}
- Types: {{ types_status }}
- Unit: {{ unit_status }}
- Build: {{ build_status }}
- Storybook: {{ story_status }}

## Checklists (YC + Linear-inspired)
- [ ] Small, reviewable diff (≤300 LOC)
- [ ] Clear acceptance criteria met
- [ ] Tests updated/added
- [ ] UX text concise & on-brand
- [ ] No layout shifts/spinner overlap
- [ ] Public profile <100ms p95

## Notes for Reviewers
- Logs: {{ short_logs }}
- Follow-ups: {{ followups }}
```

- Default labels: `["triage"]`  
- Reviewers: `@owner-or-codeowners`  

---

## 9. Post-Open Flow
- ❌ → Post comment with actionable next steps + failing stage/log link.  
- ✅ → Link PR to issue and move Linear

*(Answer truncated — 5500 chars total)*

## Question

We dont use clerk billing, we use stripe billing directly

## Answer

Got it. I’ll strip out the Clerk Billing section entirely and refine the rules to reflect **direct Stripe billing** instead. Here’s the cleaned and consolidated version:  

---

# 🚦 Jovie PR & Integration Rules

## 1. Intent
- Always run a **fast, deterministic smoke test** before opening a PR.  
- **Always open the PR** (pass or fail) with structured output so it can enter Merge Queue when ready.  
- Follow **YC best practices** (ship small, fast, tighten loops), design like **Linear** (clarity, minimalism), and hold bar for **Apple-level UX & copywriting** (concise, humane, benefit-oriented).  

---

## 2. Triggers
Open PR when:  
- `linear.issue_labeled(codegen|ready)`  
- `local.command("prepare-pr")`  
- `vcs.branch_created("feat/*","fix/*","chore/*")`  

---

## 3. Environment
- `NODE_VERSION=20`  
- `PACKAGE_MANAGER=pnpm`  

---

## 4. Smoke Steps
1. Checkout → new branch if needed  
2. Install deps: `pnpm i --frozen-lockfile`  
3. **Lint:** `pnpm lint --max-warnings=0`  
4. **Types:** `pnpm typecheck` (`tsc --noEmit`)  
5. **Unit (smoke):** `pnpm test:unit --run -t "smoke|happy|render"`  
6. **Build:** `pnpm build -n || vite build --emptyOutDir false`  
7. **UI snapshot (optional):** `pnpm story:build || true`  
8. Summarize → PR body  

---

## 5. Policy
- Don’t reformat files beyond the change set.  
- Don’t touch infra/pipeline files (`.github/workflows/**`, `infra/**`) unless issue requires.  
- Keep diffs **small, focused slices** (≤300 LOC touched).  
- No naked TODOs; clear names only.  
- Copywriting: short, specific, no filler.  

---

## 6. Failure Behavior
- Still open PR.  
- Labels: `needs-human`, `smoke-failed`. Remove `automerge`.  
- Title prepended with ❌. Include logs summary in body.  
- Never queue auto-merge until smoke passes.  

---

## 7. Success Behavior
- Labels: `ready-for-review`, `automerge-candidate`.  
- Title prefix: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `perf:`, `test:`.  
- Auto-enable squash auto-merge if all checks are green.  

---

## 8. PR Template
**Always open PRs with:**  

**Title**  
```txt
{{ status_emoji }} {{ type_prefix }}{{ concise_title }}
```

**Body**  
```md
## Summary
- **Why**: {{ problem_statement }}
- **What**: {{ solution_slice }}
- **Risk**: {{ risk_note }}
- **UX**: Apple-level polish; copy trimmed for clarity.

## Smoke Result
- Lint: {{ lint_status }}
- Types: {{ types_status }}
- Unit: {{ unit_status }}
- Build: {{ build_status }}
- Storybook: {{ story_status }}

## Checklists (YC + Linear-inspired)
- [ ] Small, reviewable diff (≤300 LOC)
- [ ] Clear acceptance criteria met
- [ ] Tests updated/added
- [ ] UX text concise & on-brand
- [ ] No layout shifts/spinner overlap
- [ ] Public profile <100ms p95

## Notes for Reviewers
- Logs: {{ short_logs }}
- Follow-ups: {{ followups }}
```

- Default labels: `["triage"]`  
- Reviewers: `@owner-or-codeowners`  

---

## 9. Post-Open Flow
- ❌ → Post comment with actionable next steps + failing stage/log link.  
- ✅ → Link PR

*(Answer truncated — 5750 chars total)*

## Question

Update our claude md file to remove clerk billing and add stripe mentions

## Answer

Mr. White — the in-editor patch tool errored, so here’s a clean, copy-pasteable patch you can apply. It removes all Clerk Billing content and adds direct Stripe billing rules, examples, envs, and checks.

# Unified diff (apply to `CLAUDE.md`)
```diff
@@
-## **2. Clerk Billing with Stripe Integration**
-...
-# (entire Clerk Billing section removed)
+## **2. Stripe Billing (Direct Integration)**
+
+**Purpose:** Use **direct Stripe Billing** (Checkout + Webhooks + Customer Portal). Keep billing separate from auth.
+
+### **2.1 – Core Principles**
+1. **Server-only** creation of Checkout Sessions; never expose secrets client-side.
+2. **Webhooks are mandatory** for lifecycle: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_succeeded|failed`, `customer.subscription.trial_will_end`.
+3. **Persist subscription state** in our DB (user ↔ customer ↔ subscription ↔ price). Stripe = source of truth; DB = fast authz cache.
+4. **Server-side enforcement** of access; never trust client checks.
+5. **Price IDs** come from env (e.g., `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_PRO`); no hardcoding.
+6. **Customer Portal** for self-serve management (payment method, plan changes, cancel).
+7. **Idempotent handlers** with logging/alerts on failures.
@@
 ### **3.1 – ALWAYS DO THE FOLLOWING**
 #### **For Clerk-Supabase Integration:**
 ...
-#### **For Clerk Billing:**
-1. **Use Clerk's billing system** - NOT direct Stripe integration
-2. **Use `<PricingTable />` component** for pricing pages
-3. **Use `has()` method** for plan/feature access control
-4. **Use `<Protect>` component** for React-based protection
-5. **Create plans and features** in Clerk Dashboard
-6. **Link pricing page** from homepage and navigation
-7. **Test billing flow** end-to-end
-8. **Handle subscription states** properly
+#### **For Stripe Billing (Direct):**
+1. **Use direct Stripe Billing** (Checkout + Webhooks + Customer Portal); do **not** use Clerk billing.
+2. **Create Checkout Sessions server-side** only; never expose secrets client-side.
+3. **Handle webhooks** for: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.trial_will_end`.
+4. **Persist subscription state** in our DB (user ↔ customer ↔ subscription ↔ price). Treat Stripe as source of truth; cache locally.
+5. **Enforce access server-side** (middleware/API) by checking our DB-backed subscription status.
+6. **Use env price IDs** (e.g., `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_PRO`).
+7. **Offer Customer Portal** for self-serve billing.
+8. **Log & alert** on webhook failures; implement idempotency.
@@
 ### **3.2 – NEVER DO THE FOLLOWING**
 #### **For Clerk-Supabase Integration:**
 ...
-#### **For Clerk Billing:**
-1. **Do not** implement direct Stripe integration
-2. **Do not** bypass Clerk's billing system
-3. **Do not** hardcode plan/featu

*(Answer truncated — 9575 chars total)*

## Question

{'asset_pointer': 'file-service://file-VTyeckyS6dGfJW5QneQXVN', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 948, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1052727, 'width': 1470}
{'asset_pointer': 'file-service://file-VFhznQTaFBGBYpfG42RG4s', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 909, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': Tr

## Answer

Mr. White — here’s a tight UX audit and a copy-paste AI fix prompt your agent can run.

# UX Audit (Linear/Apple, color-agnostic)

**Overall**
- Visual weight is dominated by purple accents; feels “template-y.” Go neutral first, accent last.
- Card has mixed shadows, blur, and strong gradients → noisy. Prefer flat/soft surfaces with 1px keylines.
- Stepper and timers add color + motion noise; hierarchy isn’t crisp (too many headings, emojis).
- Buttons use saturated brand color; loading states cause layout shift and spinner misalignment.
- Error state in handle field pushes layout and uses red icon without inline hint text.
- Mobile density isn’t tuned: large paddings force scrolling; CTA not sticky; keyboard overlap risk.

**Specifics**
- **Typography:** Too many sizes/weights; H1 + “Welcome to Jovie!” repeats. Use 1 H1, 1 section title, body M.
- **Color system:** Unscoped purple. Move to grayscale tokens (`--bg`, `--surface`, `--text`, `--muted`, `--keyline`) + `--accent` that can be swapped.
- **Surfaces:** Card blur + gradient background grid compete. Use plain dark/neutral surface with subtle grid at 5–8% opacity or remove it on mobile.
- **Stepper:** Use neutral track with accent only on current step. Replace circles with tiny ticks + step labels.
- **Form:** Inline validation (no reflow); helper text reserved space; 1-line error.
- **Buttons:** CTA should be **black** (light theme) or **white** (dark theme) with inner spinner overlay, no width change.
- **Timer:** Reduce to subtle text “~2 min” (muted), not a progress bar.
- **Motion:** 150–200ms ease-out for micro transitions; no bouncy curves; crossfade between steps; preserve height.
- **A11y:** 16px min target, 4.5:1 contrast, proper aria-live for errors, focus ring consistent.
- **Mobile:** Sticky bottom CTA, header collapses on scroll, safe-area paddings, keyboard-avoidance.
- **No layout shift:** Reserve heights for error/help; spinner overlays; story checks for long names + error states.

---

# AI Fix Prompt (drop into Windsurf/Claude/Cursor)

**Title:** Overhaul Onboarding to Linear/Apple-grade, Color-Agnostic UX (no layout shift)

**Goal:** Re-skin and harden `/onboarding` (steps 1–4) to a neutral, premium style (Linear/Apple) with color-agnostic theming. Preserve copy brevity. Zero layout shift across states. Mobile + desktop both world-class.

**Constraints**
- Tailwind v4 + Headless UI. No new deps.
- Keep accent color configurable; default to system accent but UI must look great in pure grayscale.
- CTA: white in dark mode / black in light mode. Spinner overlays; width never changes.
- Avoid gradients, heavy shadows, and emojis. Subtle keylines over shadows.
- Respect branch rules: feature branch from `preview`, small diff, no infra edits.

**Deliverables**
1. **Theme tokens (CSS vars in `globals.css`):**
   ```css
   :root {
     --bg: #0b0c0e;         /* page */
     --surface: #111214;    /* cards */
     --keyline: #1e2023;    /* 1px borders */
     --text: #e7e9ee;
   

*(Answer truncated — 6832 chars total)*
