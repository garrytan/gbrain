---
title: "Hypertrophy Pro clone prompt"
type: note
created: 2025-08-22
updated: 2025-08-22
source: chatgpt-export
conversation_id: 68a8db93-1930-8325-b95b-3388f17dd95b
message_count: 4
tags: [chatgpt, import, long-form]
---
# Hypertrophy Pro clone prompt

> Conversation ID: 68a8db93-1930-8325-b95b-3388f17dd95b
> Created: 2025-08-22T21:06:56Z
> Updated: 2025-08-22T21:10:59Z
> Messages: 4

---

## User

Analyze the rp hypertrophy app. Come up with a comprehensive prompt to build a clone. but use next.js, tailwind css 4, clerk auth, supabase. Call it Hypertrophy Pro.

---

## Assistant

Got it, Mr. White. Here’s a clean, end-to-end build prompt you can paste into Windsurf/Cursor/Cascade to generate **Hypertrophy Pro** (Next.js + Tailwind CSS 4 + Clerk + Supabase). I’ve mirrored the RP Hypertrophy app’s core behaviors—auto-regulated volume using RIR/soreness/pump inputs, progressive mesocycles with deloads, and volume-landmark logic—without copying their IP or branding. citeturn0search20turn0search11turn0search3turn0search4turn0search10

---

# Build Prompt — Hypertrophy Pro

You are a senior full-stack engineer. Build **Hypertrophy Pro**: a hypertrophy training web app (web + PWA) inspired by RP Hypertrophy’s workflow: individualized mesocycles (4–6 weeks), weekly progressive overload with declining RIR targets, user feedback (pump/soreness/performance) to auto-adjust volume, and deload detection. Do not copy RP’s content, copy, or assets. Implement from first principles based on public hypertrophy principles (volume landmarks: MV/MEV/MAV/MRV). citeturn0search3turn0search11turn0search10

## Tech & Platform
- **Framework:** Next.js (App Router, RSC, Server Actions, Edge runtime where possible), TypeScript.
- **UI:** Tailwind CSS **4** (use native CSS variables + new config), headless components only, dark mode.
- **Auth:** Clerk (email/password + OAuth). Roles: `user`, `coach`, `admin`.
- **Backend:** Supabase (Postgres + RLS + Storage + Functions). Use Supabase JS with server-side calls via Server Actions.
- **Hosting:** Vercel (prod), Preview deployments for PRs. Image optimization via Next/Image.
- **PWA:** Offline caching for workouts, installable app, background sync for logs.

## Product Goals
- **Latency:** <100 ms TTFB for public pages; <200 ms action round-trips on Edge paths. Optimistic UI for set logging.
- **Reliability:** All workout logging must work offline and sync conflict-free.
- **Science-driven:** Implement volume landmarks (MV/MEV/MAV/MRV), weekly RIR targets, autoregulated volume via user feedback (soreness/pump/performance), and deload heuristics. citeturn0search10turn0search4

## Core Flows (MVP)
1. **Onboarding (10 mins, skippable)**
   - Inputs: training age, lift experience, available days/wk, equipment, session length cap, weak-point priorities by muscle group, injury constraints, preferred variants per pattern.
   - Output: initial **mesocycle plan**: 4–6 weeks, per-muscle weekly set targets; per-exercise RIR targets by week; starter loads estimated from test sets.

2. **Program Builder**
   - Choose template (upper/lower, PPL, 4–6d/wk) or blank.
   - For each muscle group: target sets/week (MEV→MAV ramp), exercise menu with swap rules and accessories.

3. **Workout Screen**
   - Warm-ups (auto-calculated ramp sets), working sets with RIR targets, rest timer, load suggestions, substitution, supersets, notes.
   - Inputs after each exercise: actual reps, RIR achieved, pump (0–5), soreness entering session (0–5), perceived fatigue.
   - Offline-first logger; autosave every interaction.

4. **Weekly Check-In**
   - Summarize lifts, PRs, compliance, soreness/pump averages, fatigue flags.
   - Auto-adjust next week: +/- sets by muscle, tweak RIR targets, suggest deload if performance down + high fatigue/soreness.

5. **Deload Week**
   - Auto-insert when triggers hit; reduce volume ~40–60% and intensity ~5–10%, raise RIR. Allow manual override.

6. **Progress & Analytics**
   - Per-muscle volume trend, e1RM trends, best sets, compliance, bodyweight visuals.
   - Export CSV; share read-only links.

7. **Coach Mode (phase 2)**
   - Invite clients, view logs, propose edits, comment, template library.

## Data Model (Supabase)
Create tables (snake_case). Add created_at/updated_at on all. Soft delete via deleted_at where noted.

- `profiles` (id PK = auth.user_id, name, height_cm, sex, timezone, coach_id FK nullable)
- `equipment` (id, name, tags)
- `exercises` (id, name, muscle_groups[], movement_pattern, equipment_ids[], video_url, is_public)
- `exercise_variants` (id, exercise_id FK, cues, constraints, regressions[], progressions[])
- `programs` (id, owner_id FK, name, days_per_week, is_template, is_public, deleted_at)
- `mesocycles` (id, program_id FK, start_date, weeks INT, status ENUM[draft,active,deload,complete])
- `microcycles` (id, mesocycle_id FK, week_index INT, status)
- `workouts` (id, microcycle_id FK, day_index INT, name, planned_minutes)
- `workout_exercises` (id, workout_id FK, exercise_variant_id FK, target_sets INT[], target_rir FLOAT[], target_reps INT[] nullable, is_superset_group_id nullable)
- `sets` (id, workout_exercise_id FK, set_index INT, target_load_kg, target_reps, target_rir)
- `set_logs` (id, set_id FK, actual_load_kg, actual_reps, actual_rir, rpe nullable, notes, duration_s)
- `session_feedback` (id, workout_id FK, soreness_0_5, pump_0_5, fatigue_0_5, sleep_h, bodyweight_kg nullable, injuries_note)
- `weekly_adjustments` (id, microcycle_id FK, muscle_group, delta_sets INT, rationale)
- `deload_events` (id, mesocycle_id FK, reason ENUM[performance_drop,high_soreness,high_fatigue,manual], details JSONB)
- `pr_history` (id, exercise_id FK, profile_id FK, metric ENUM[1RM,e1RM,best_set_volume], value, date)
- `coach_clients` (coach_id, client_id) PK composite
- Storage buckets: `exercise_videos/`, `exports/`.

### Indices
- Hot reads: (profile_id, date) on logs, (mesocycle_id, week_index), (workout_id).
- Full-text search on exercises.name.

### RLS (examples)
- `profiles`: user can select/modify own row; coach can read/write client rows via `coach_clients`.
- `programs/mesocycles/...`: owner OR owner’s coach read/write; deny others.
- Storage policies mirror row policies (JWT claims from Clerk → Supabase).

## Algorithms (server-side)
Implement simple, transparent heuristics (configurable per user):
- **Load Suggestion:** e1RM per exercise updated via Epley/Brzycki from best set; next-set load suggestion uses target RIR and last set delta.
- **Volume Progression:**
  - Track per-muscle weekly stimulus score = sum(sets × hard-set factor where RIR≤3).
  - If average **pump ≥3** and **soreness ≤2** for muscle group → `+1–2 sets` next week (cap at MAV); if **soreness ≥4** or performance drops ≥2 weeks → `-2–3 sets` and/or trigger deload; otherwise hold. citeturn0search4
  - RIR target: start 3–4 RIR week1 → progress toward 1–2 RIR by week4–5; then deload week with higher RIR (3–4). citeturn0search3turn0search11
- **Deload Trigger:** any two: persistent high soreness, declining performance trend, compliance <70%, HRV proxy (optional future). Insert deload week and reset RIR/volume.

Expose these rules in Settings so advanced users can tune ranges.

## Pages & Routes (Next.js App Router)
- `/` Marketing (screens, pricing, CTA).
- `/auth/*` Clerk.
- `/onboarding` multi-step.
- `/dashboard` today’s workout + week overview.
- `/workout/[id]` logger (offline-first).
- `/programs` list/create/edit; `/programs/[id]`.
- `/progress` charts & PRs.
- `/coach` (phase 2): roster, client detail.
- `/settings` profile, equipment, preferences, algorithm knobs.
- `/export` CSV downloads.

## UX Details
- One-hand logging: large tap targets, swipe to complete set, long-press to edit.
- Rest timer auto-starts on set completion; background notifications.
- Exercise swap: keeps muscle intent; suggests equivalents given equipment.
- Accessibility: keyboard-first, ARIA, prefers-reduced-motion.

## Offline & Sync
- Use IndexedDB for `set_logs`, `session_feedback`, and pending actions.
- Conflict strategy: last-write-wins for logs; merge by `set_id` granularity.
- Background sync on regain network; optimistic UI for all actions.

## Testing & CI
- **Unit:** Vitest for algorithms (volume, RIR, deload). Gate on 100% branch coverage for core calc modules.
- **E2E:** Playwright: onboarding → generate mesocycle → complete workout → weekly check-in → auto-adjust.
- **Visual:** Storybook + Chromatic/Playwright snapshots for critical components (logger, rest timer, charts).
- **Static gates:** `tsc --noEmit`, ESLint, Tailwind class validator. Fail fast if type or lint fails. Merge Queue with required checks only.
- Seed minimal safe preview dataset; no RP content.

## Analytics & Telemetry
- PostHog: funnel (onboard→first workout→week1 retention), event for auto-adjustments, session replay (mask inputs).
- Feature flags for new algorithms.

## Security & Privacy
- No PII beyond auth; encrypt local caches at rest (CryptoJS).
- Rate-limit write actions; audit logs on server actions.
- CSP strict; disable inline scripts; signed URLs for Storage.

## Monetization (stub)
- Stripe (later): free trial 14 days; Pro $12/mo; Coach $29/mo. Lock coach features behind plan.
- Billing events via webhook → Supabase `subscriptions`.

## Deliverables
1. Fully scaffolded repo with the above stack and routes.
2. Supabase SQL schema + RLS policies + seed script.
3. Algorithm module with unit tests and config.
4. PWA manifest + service worker (workouts offline).
5. CI pipeline (GitHub Actions) with required checks.
6. Minimal marketing site with screenshots and a clear “science-based auto-regulation” message (no RP branding).
7. Docs: README (setup), ARCHITECTURE.md (data + flows), ALGORITHM.md (volume/RIR/deload rules), PRIVACY.md.

## Nice-to-Haves (backlog)
- Apple/Google Health weight sync; wearable HR sync.
- Coach annotations on specific sets; template marketplace.
- Multi-user “partner mode” in-gym.
- i18n (EN first), RTL-safe styles.

**References for behavior only (do not copy content):** RP onboarding/mesocycle help pages and public write-ups on volume landmarks, autoregulation via soreness/pump feedback, and 4–6 week mesocycle + deload patterns. citeturn0search20turn0search11turn0search3turn0search4turn0search10

---

If you want, I can convert this into a repo scaffold (Next + Tailwind v4 config, Clerk wiring, Supabase schema + RLS, and the algorithm module with unit tests) in one shot.

---

## User

Use headless UI and tailwind ui components. Use hero icons v2. Use inter as the primary font. Style the design after linear.app. follow ycombinator principles for code and copywriting. Use apple level ux magic and copywriting. No google sync just apple health eventually when we roll out ios but for now no sync cuz web apps dont support it.

---

## Assistant

Roger that, Mr. White. Here’s a **drop-in, all-in build prompt** for Windsurf/Cursor/Cascade that bakes in Headless UI + Tailwind UI, Heroicons v2, Inter, a Linear-style aesthetic, YC-style code/copy, and **no device health sync (web only)**—future Apple Health reserved for native iOS.

---

# Build Prompt — Hypertrophy Pro (Updated UI/UX + Stack)

You are a senior full-stack engineer. Build **Hypertrophy Pro**: a hypertrophy training web app with mesocycles, weekly auto-regulation, RIR targets, soreness/pump feedback, deload heuristics, and offline-first logging. Do **not** copy proprietary content; implement from first principles.

## Tech
- **Framework:** Next.js (App Router, RSC, Server Actions, Edge where possible), TypeScript.
- **Auth:** Clerk (email/OAuth). Roles: `user`, `coach`, `admin`.
- **DB/Backend:** Supabase (Postgres, RLS, Functions, Storage). Server-side calls via Server Actions.
- **UI Stack:** Tailwind **CSS v4**, **Headless UI** primitives + **Tailwind UI** patterns, **Heroicons v2** (`@heroicons/react/24/*`), **Inter** via `next/font`.
- **Host:** Vercel. Image optimization via Next/Image. PWA with offline workouts + background sync.

## Visual Language — “Linear-esque”
- **Theme:** Dark-first, high-contrast neutrals (slate/neutral), single accent (blue/violet), subtle gradients; rounded-2xl, soft shadows, 8/12pt grid.
- **Motion:** Fast, minimal; micro-interactions on log/save; optimistic updates.
- **Keyboard-centric:** Global **Cmd/Ctrl-K** command menu (Headless UI `Combobox`), slash-to-focus search, hotkeys for “log set,” “next set,” “swap exercise.”
- **Density:** Information-dense but scannable; tables/cards with clear affordances like Linear.

## Components (compose with Headless UI + Tailwind UI)
- **Primitives:** Button, IconButton, Input, Textarea, Select (Listbox), Switch, Tabs, Tooltip, Dialog/Sheet, Dropdown (Menu), Toast, Progress, Badge, Card, EmptyState, Skeleton.
- **Workout UI:** Set row (load/reps/RIR), rest timer, warm-up ladder, superset group, exercise swap dialog, per-exercise notes, offline badge, sync state.
- **Data Viz:** Minimal line/area charts for e1RM & volume; bar chart for weekly sets per muscle. No fancy colors; keep it clinical.

## Typography & Icons
- **Font:** Inter (variable) via `next/font/google`. Base 15–16px; tight line heights for dense screens.
- **Icons:** Heroicons v2 outline by default; solid only for emphatic states (success/warn).

## Product Flows
1. **Onboarding:** training age, days/wk, equipment, session cap, weak-point priorities, injuries → generate 4–6 week **mesocycle** (per-muscle set targets MEV→MAV, weekly RIR map, starter loads from one test set).
2. **Program Builder:** templates (UL/LL, PPL, 4–6d) or blank; exercise menu with swap rules; weekly set targets visible per muscle.
3. **Workout Screen:** offline-first logger, autosave; inputs: actual reps/load/RIR, pump (0–5), soreness entering session (0–5); timers, supersets, quick swap.
4. **Weekly Check-In:** summarize PRs/compliance; auto-adjust next week: `+/- sets` per muscle, tweak RIR targets, suggest deload if performance down + high fatigue/soreness.
5. **Deload:** auto-insert week with ~40–60% volume drop, +RIR; allow manual override.
6. **Progress:** e1RM trends, volume per muscle, compliance; export CSV; share read-only links.
7. **Coach Mode (phase 2):** roster, client logs, propose edits, comment.

## Algorithms (transparent, configurable)
- **Load suggestion:** e1RM from best sets (Epley/Brzycki); adjust next set by achieved RIR deltas.
- **Volume progression:** weekly stimulus score (count hard sets where RIR ≤3). If pump ≥3 and soreness ≤2 → `+1–2 sets` (cap at MAV). If soreness ≥4 or two-week performance drop → `-2–3 sets` and/or deload. Start RIR 3–4 week1 → 1–2 by week4–5 → deload reset.
- **Deload trigger:** any two—high soreness, performance decline, low compliance.

## Data Model (Supabase, summary)
- `profiles`, `equipment`, `exercises`, `exercise_variants`
- `programs`, `mesocycles`, `microcycles`, `workouts`
- `workout_exercises`, `sets`, `set_logs`, `session_feedback`
- `weekly_adjustments`, `deload_events`, `pr_history`, `coach_clients`
- Storage: `exercise_videos/`, `exports/`
- Indexes for hot reads; FTS on exercises.
- **RLS:** owner or owner’s coach; storage mirrors row policies (JWT from Clerk).

## Offline & Sync
- IndexedDB cache for `set_logs`/`session_feedback` + pending actions.
- Conflict policy: merge by `set_id`, last-write-wins for logs.
- Background sync on reconnect; explicit “Resolve conflicts” if needed.

## Pages (App Router)
`/`, `/auth/*`, `/onboarding`, `/dashboard`, `/workout/[id]`, `/programs`, `/programs/[id]`, `/progress`, `/coach` (phase 2), `/settings`, `/export`.

## Copy & Product (YC style)
- Be plain and punchy; eliminate fluff. Above the fold: “**Train smarter. Progress weekly.**”
- Buttons: “Start mesocycle,” “Log set,” “Add set,” “Swap exercise,” “Finish workout,” “Run check-in.”
- Empty states teach the next action; success toasts confirm saves; errors in-line and specific.

## No Device Sync (explicit)
- **Do not implement Apple/Google Health or any device sync in web.** Surface a stub “Connect on iOS (coming soon)” gated behind feature flag. Hide by default in web builds.

## Testing & CI (ship fast, break small)
- **Unit (Vitest):** algorithms (volume, RIR, deload) 100% branch coverage.
- **E2E (Playwright):** onboard → generate mesocycle → complete workout → weekly check-in → auto-adjust.
- **Visual:** Storybook + Playwright snapshots for logger/timer/forms.
- **Static gates:** `tsc --noEmit`, ESLint, Tailwind class validator. **Fail fast** if types or lint fail. Required checks + Merge Queue.
- **Seed:** minimal safe preview dataset (no proprietary content).

## Implementation Details
- **Tailwind v4:** use CSS vars; co-locate component styles; dark mode `class`.
- **Headless UI:** Dialog, Menu, Listbox, Combobox, Tabs, Transition. Compose with Tailwind UI patterns for forms/nav/tables.
- **Inter:** `import { Inter } from "next/font/google"`; set CSS variables and apply globally.
- **Heroicons v2:** `@heroicons/react/24/outline` as default; wrap in `<Icon>` primitive for size/aria.
- **Command Menu:** Headless UI `Combobox` bound to actions (navigate, add set, swap exercise). Expose `Cmd/Ctrl-K`.
- **Accessibility:** ARIA on controls, focus rings, reduced-motion support, color-contrast AA+.
- **Perf:** Edge for read paths; stream RSC where beneficial; optimistic UI for writes; defer non-critical JS; image `sizes` attrs.

## Deliverables
1. Repo scaffold with Next + Tailwind v4 + Clerk + Supabase wired.
2. Supabase SQL + RLS + seeds.
3. Component library (Headless UI + Tailwind UI comps) + design tokens.
4. Algorithm module with tests.
5. PWA (manifest + SW) for offline workouts.
6. CI (GitHub Actions) with required checks.
7. Minimal marketing site (Linear-like polish) with clear, YC-style copy.

**Guardrails:** Don’t use any RP copy/assets. Keep algorithms explainable and user-tunable. Prioritize fast iteration and small PRs.

---

If you want, I can output the **initial repo structure + Tailwind v4 config + Clerk wiring + Supabase schema/RLS** in one go.


## See Also
- [[chatgpt/chatgpt_admin-dashboard-prompt]]
- [[chatgpt/chatgpt_agent-mode-prompt]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part1]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part2]]
- [[chatgpt/chatgpt_ai-engineering-agent-prompt-part3]]
