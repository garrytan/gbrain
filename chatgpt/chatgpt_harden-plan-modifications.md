---
title: "Harden Plan Modifications"
type: guide
created: 2026-04-25
updated: 2026-04-25
source: chatgpt-export
conversation_id: 69ec1c8a-44dc-83e8-9c2d-408df0964acd
message_count: 3
tags: [chatgpt, import, code, long-form]
---
# Harden Plan Modifications

> Conversation ID: 69ec1c8a-44dc-83e8-9c2d-408df0964acd
> Created: 2026-04-25T01:44:42Z
> Updated: 2026-04-25T01:50:34Z
> Messages: 3

---

## User

I just want you to take this plan and tell me how to harden it then list what modifications to make

---

## Assistant

I’ll harden the plan for demo execution by making the filmed interaction deterministic, freezing interfaces, reducing collisions, and adding fallbacks for visual or timing-sensitive pieces.

---

## Assistant

Mr. White, the plan is directionally strong: it keeps P0 demo-only, avoids schema changes, uses deterministic client-state generation, and scopes the YC demo around one legible release-OS interaction. The hardening should focus on removing demo flake, agent collisions, runtime ambiguity, and visual failure points. fileciteturn0file0

## How to harden it

### 1. Make Phase 0 runnable, not stubbed

Change the Phase 0 contract from `throw new Error('not implemented')` stubs to a minimal working implementation.

Agents B, C, and D need to run the app while Agent A finishes polish. Throwing stubs create runtime crashes and block parallel work.

Use this instead:

```ts
export function generateDemoPlan(): DemoMoment[] {
  return DEMO_MOMENTS.map((m) => ({ ...m }));
}
```

Phase 0 should include:

- `EP_TRACKS`
- `DEMO_TOUR_DATES`
- `DEMO_PLAN_START_FRIDAY`
- 12 valid demo moments
- safe placeholder `workflowTaskSlugsForMoment`
- safe placeholder `fanNotificationForMoment`
- `moveRemixNearLAShow` returning a copied array

Agent A can improve the data, but every import should already be safe.

---

### 2. Do not run four agents in the same tree

The plan says the agents can run in the same tree because there are no file collisions. That is the biggest operational risk.

Change it to mandatory worktrees:

```bash
git worktree add ../jovie-agent-a HEAD
git worktree add ../jovie-agent-b HEAD
git worktree add ../jovie-agent-c HEAD
git worktree add ../jovie-agent-d HEAD
```

Each agent gets its own tree. No shared `git reset --hard`, no shared `git clean -fd`, no accidental deletion of another agent’s untracked files.

Modify the plan to say:

> Agents must run in separate worktrees. No agent may run `git reset --hard` or `git clean -fd` in the primary integration tree.

---

### 3. Freeze the demo data completely

Do not let the agents invent slugs, dates, task names, or moment titles independently.

Add a fixed `DEMO_MOMENTS` constant in Phase 0:

```ts
export const DEMO_MOMENTS = [
  {
    slug: 'all-this-noise-single',
    title: 'All This Noise',
    momentType: 'single',
    friday: '2026-05-01',
    trackSlug: 'all-this-noise',
  },
  // ...
] as const satisfies ReadonlyArray<DemoMoment>;
```

Add tests that verify:

- exactly 12 moments
- all dates are Fridays
- slugs are unique
- dates are sorted
- the remix moves to exactly three days before the LA show
- `generateDemoPlan()` returns a fresh copy every call
- mutating one returned plan cannot corrupt the next call

---

### 4. Make the LA show visible on the calendar

The chat command says “move the remix closer to the LA show.” The calendar needs to show the LA show, or the move feels arbitrary.

Modify `ReleaseCalendar.tsx` to render tour markers inside the relevant week column:

```tsx
<div data-testid={`release-tour-date-${tourDate.id}`}>
  LA show · Mon
</div>
```

The viewer should see:

- remix card before move
- LA show marker
- remix card move to the Friday before that LA show

That makes the adaptive replanning claim legible.

---

### 5. Replace “page-level context or event” with one explicit mechanism

The plan currently leaves the chat-to-calendar wiring open: “page-level React context or event.” Pick one before agents start.

For this demo, use a tiny browser event bus. It keeps the command registry decoupled from React state.

Add:

```ts
// apps/web/lib/release-planning/demo-events.ts
export const RELEASE_PLAN_MOVE_REMIX_NEAR_LA =
  'jovie:release-plan:move-remix-near-la';

export function dispatchMoveRemixNearLAShow() {
  window.dispatchEvent(new CustomEvent(RELEASE_PLAN_MOVE_REMIX_NEAR_LA));
}
```

`ReleaseCalendar` subscribes to the event. `command-registry.ts` dispatches it.

This avoids Zustand setup risk and avoids importing page state into the chat registry.

---

### 6. Normalize the canned chat command

Literal substring match is fine, but normalize the input so the demo does not fail because of casing or punctuation.

Support:

- `move the remix closer to the la show`
- `Move the remix closer to the LA show`
- `move the remix closer to the L.A. show`
- extra spaces

Add a helper:

```ts
function normalizeCommand(input: string) {
  return input
    .toLowerCase()
    .replace(/\bl\.a\.\b/g, 'la')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
```

Then match against the normalized string.

---

### 7. Move workflow task titles into a static demo map

The plan says Agent C should read task titles from `release_task_catalog`, with a fallback to inline constants. For P0, make inline constants the default.

Client-side DB/catalog plumbing is unnecessary demo risk.

Add:

```ts
// apps/web/lib/release-planning/demo-workflow-tasks.ts
export const DEMO_WORKFLOW_TASKS_BY_SLUG = {
  upload_to_distributor: 'Upload release to distributor',
  finalize_artwork: 'Finalize cover artwork',
  schedule_smart_link: 'Schedule smart link',
  // ...
} as const;
```

Then have `workflowTaskSlugsForMoment()` return slugs and the drawer resolve display names locally.

This still represents real workflow titles, but removes async loading, DB access, and server/client boundary risk.

---

### 8. Show dependent dates moving, not just the card

The OS claim becomes stronger if replanning updates the workflow and notification preview.

Modify the drawer so workflow tasks render relative due dates:

```tsx
T-21 · Finalize cover artwork
T-14 · Upload release to distributor
T-7 · Schedule fan notification
```

After the remix moves, the drawer should recompute:

- release Friday
- task due dates
- notification `sendsAt`

Add one Playwright assertion:

```ts
await expect(page.getByTestId('fan-notification-preview')).toContainText(targetFriday);
```

This proves the system replans dependent work, rather than merely moving a card.

---

### 9. Make the animation resilient

Framer Motion layout animations can fail silently when elements move between different containers.

Use:

```tsx
<LayoutGroup>
  <motion.div
    layout
    layoutId={`release-moment-${moment.slug}`}
    data-testid={`release-moment-card-${moment.slug}`}
  >
```

Also add a visible fallback state:

- pulse/highlight the moved card for 1.5 seconds
- scroll the target week into view
- show a small “Moved near LA show” badge

That way the demo still reads correctly even if the slide animation is subtle.

---

### 10. Test final state, not animation timing

Playwright should verify the outcome, not depend on animation frames.

Add attributes:

```tsx
data-release-date={moment.friday}
data-moment-type={moment.momentType}
```

Then test:

```ts
await expect(remixCard).toHaveAttribute('data-release-date', '2026-06-12');
```

Use animation only for the recording. Use deterministic DOM state for CI.

---

## Specific modifications to make

### Modify the file map

Change from:

```md
7 new + 2 edited + 1 doc
```

To:

```md
9 new + 3 edited + 1 doc
```

Add these files:

```md
apps/web/lib/release-planning/demo-events.ts
apps/web/lib/release-planning/demo-workflow-tasks.ts
```

Add this edited file:

```md
apps/web/app/app/(shell)/dashboard/page.tsx
```

The dashboard CTA is in Definition of Done, so it should be in the file map.

---

### Modify Phase 0

Replace:

```md
all exported symbols with throw new Error('not implemented') or placeholder returns
```

With:

```md
all exported symbols return safe deterministic baseline values. No exported function throws during normal UI execution.
```

Add:

```md
Phase 0 also defines the event contract in demo-events.ts and the static workflow task title map in demo-workflow-tasks.ts.
```

---

### Modify Phase 1 agent plan

Change the same-tree language to:

```md
Each agent works in a separate git worktree. Agents may reset and clean only inside their own worktree. The integration tree is touched only during Phase 2.
```

Add a fifth tiny ownership block or move this into Agent B:

| Agent | Owns |
|---|---|
| E or Phase 0 | `demo-events.ts`, `demo-workflow-tasks.ts`, event contract, command trigger helper |

I would put this in Phase 0 to avoid another agent.

---

### Modify Agent B scope

Add:

```md
Calendar also renders tour-date markers from DEMO_TOUR_DATES, especially the LA show marker. When the remix moves, the target week scrolls into view and the moved card receives a temporary highlight.
```

Add test IDs:

```md
release-tour-date-{id}
release-calendar-moved-badge-{slug}
```

---

### Modify Agent C scope

Replace:

```md
read catalog titles from release_task_catalog
```

With:

```md
resolve task titles from demo-workflow-tasks.ts, copied from release_task_catalog for P0 reliability
```

Add:

```md
Workflow tasks render relative due dates derived from the moment Friday. Fan notification preview recomputes from the selected DemoMoment every render.
```

---

### Modify Agent D scope

Add assertions for:

```md
- remix card has original Friday before command
- chat response contains target Friday
- remix card has new Friday after command
- LA tour marker exists
- notification preview updates to the new send date
- no duplicate remix cards exist after move
```

Avoid assertions that require animation timing.

---

### Modify `demo-plan.ts` contract

Rename this comment:

```ts
export function moveRemixNearLAShow(plan: DemoMoment[]): DemoMoment[]; // pure mutation
```

To:

```ts
export function moveRemixNearLAShow(plan: DemoMoment[]): DemoMoment[]; // pure transform; never mutates input
```

Add:

```ts
export function isFriday(isoDate: string): boolean;
export function addDaysIso(isoDate: string, days: number): string;
```

Keep date math local and UTC-safe. Avoid browser-local timezone formatting for demo dates.

---

### Modify the command behavior

Add route-safe behavior:

```md
If the command is run on /app/dashboard/release-plan, dispatch the move event.
If run elsewhere, return: “Open Release Plan and I’ll move it next to the LA show.”
```

This avoids a silent no-op if the sidebar command is tested from the wrong page.

---

### Modify Definition of Done

Add these bullets:

```md
- LA show marker is visible in the release calendar before the chat command.
- Remix card has a stable pre-move and post-move Friday verified by Playwright.
- Workflow due dates and fan notification preview update after the remix move.
- All demo date math is UTC/date-string based; no local timezone formatting changes the visible Friday.
- Agents ran in separate worktrees; final integration happened from clean diffs.
- Production build smoke test passes before recording.
```

---

### Modify Verification

Add:

```bash
pnpm --filter web build
pnpm --filter web start
```

Then run the Playwright test against production mode.

Also add:

```bash
pnpm --filter web test -- release-planning
pnpm --filter web exec playwright test tests/e2e/yc-demo.spec.ts --project=chromium
```

For determinism, keep the 5x loop, but test final DOM state rather than animation timing.

---

### Modify the demo recording checklist

Add a short recording runbook:

```md
Recording checklist:
- production build only
- viewport locked to 1920×1080
- authenticated demo account already logged in
- browser zoom 100%
- no dev server hot reload
- no inspector overlays
- start from /app/dashboard
- use exact command: “Move the remix closer to the LA show”
- fallback: click visible “Apply LA move” action if sidebar command fails during rehearsal
```

The fallback can be a small product-plausible button in the drawer:

```md
Apply suggested move
```

Hide it behind demo mode if you do not want it in the main take.

---

## Highest-priority changes

Make these first:

1. **Use worktrees for agents.**
2. **Replace throwing stubs with runnable baseline exports.**
3. **Add explicit `demo-events.ts` for chat-to-calendar wiring.**
4. **Render the LA show marker on the calendar.**
5. **Move workflow titles into static demo constants.**
6. **Make workflow dates and notification preview update after the move.**
7. **Test final state, not animation timing.**
8. **Add production-build verification before recording.**

These changes preserve the plan’s core constraint: ship the YC demo wedge without schema changes, persistence, LLM parsing, or broad product work.


## See Also
- [[chatgpt/chatgpt_audit-and-harden-prompt]]
- [[chatgpt/chatgpt_harden-agents-file]]
- [[chatgpt/chatgpt_improve-and-harden-prompt-part1]]
- [[chatgpt/chatgpt_improve-and-harden-prompt-part2]]
- [[chatgpt/chatgpt_improve-and-harden-prompt-part3]]
