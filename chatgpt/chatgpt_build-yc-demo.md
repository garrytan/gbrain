---
title: "Build YC Demo"
type: essay
created: 2026-04-25
updated: 2026-04-27
source: chatgpt-export
conversation_id: 69ec0fdf-fbdc-83e8-a4ca-1704959fec9b
message_count: 9
tags: [chatgpt, import, code, long-form]
---
# Build YC Demo

> Conversation ID: 69ec0fdf-fbdc-83e8-a4ca-1704959fec9b
> Created: 2026-04-25T00:50:40Z
> Updated: 2026-04-27T23:29:25Z
> Messages: 9

---

## Assistant

Mr. White, I’ll separate the YC demo from the longer-term product roadmap, define the smallest credible build, and structure the broader vision for agent-executable execution.

---

## Assistant

Mr. White, this is the clearest version of Jovie so far:

**Jovie is a release operating system for music creators.**  
It turns songs, profile data, fan preferences, tour/media events, and creative ideas into an adaptive calendar of release moments, then creates the workflows underneath each moment.

The strongest demo framing is already in your script: **release moments** are what fans experience, and **workflows** are the operational work Jovie handles underneath them: artwork, smart links, fan alerts, promo copy, checklist, playlist pitch, and analytics. fileciteturn0file0

## What to build first for the YC demo

Build the smallest slice that makes the product feel inevitable:

### 1. Claim/import flow

Show:

1. Search Spotify artist.
2. Claim profile.
3. Jovie imports catalog, artwork, streaming links.
4. Artist profile appears.

This is your “setup magic.” It proves Jovie can start from public music data and build context fast.

### 2. EP/project screen

Create a project called **All This Noise** with four songs.

Each song should show simple metadata:

| Song | Detected vibe | Release role |
|---|---|---|
| Track 1 | Electronic / club | First single |
| Track 2 | Emotional / vocal | Second single |
| Track 3 | High-energy | Remix candidate |
| Track 4 | Intimate / melodic | Acoustic candidate |

The “analysis” can be mocked for the demo. The viewer only needs to believe Jovie understands the songs well enough to plan around them.

### 3. Generate Release Plan button

This is the main magic moment.

After click, animate into a calendar view with cards like:

| Date | Release moment | Workflow underneath |
|---|---|---|
| This Friday | First single | Smart link, fan alert, promo copy, checklist |
| Next Friday | Club remix concept | Artwork task, remix brief, playlist pitch |
| 3 weeks later | Piano-and-vocal version | Asset task, video idea, fan alert |
| Month 2 | Lyric video | Timed lyrics, YouTube task, promo copy |
| Month 3 | Merch drop | Product concept, announcement copy |
| Month 4 | Tour tie-in | Nearby fan alert, show promotion |

The key line: **“Jovie turns four songs into a year of Fridays.”**

### 4. Calendar view

This is the most important missing product surface.

The calendar should have three visible layers:

**Top layer: release moments**  
Singles, remixes, acoustic versions, lyric videos, merch drops, tour tie-ins.

**Second layer: tasks/workflows**  
Artwork, smart link, notification, promo copy, playlist pitch, analytics review.

**Right sidebar: Jovie chat**  
Use this for one “world-class” interaction:

> “Move the remix closer to the tour date and add a fan notification.”

Then Jovie updates the calendar.

That one interaction makes the product feel alive.

### 5. Release moment detail drawer

When clicking a calendar card, open a drawer with:

**Release Moment:** First single  
**Goal:** Build momentum before the EP  
**Fan notification:** Drafted  
**Smart link:** Ready  
**Tasks:** 5 generated  
**Analytics checkpoint:** 7 days after release

This lets the demo show that Jovie creates both the strategy and the work.

## What to defer for now

Defer the hard automation until after the YC demo:

| Feature | Demo version |
|---|---|
| Stem separation | Show as future workflow task |
| Piano version generation | Show suggested release moment |
| Lyric video generation | Show task/card/detail drawer |
| Real SMS/email sending | Show notification preview |
| Real playlist matching | Use believable mock labels like “electronic playlists” |
| Real analytics feedback loop | Show “analytics checkpoint” and “learns what to release next” |

The demo should feel like Jovie can already plan the year. The actual product can start by creating the calendar, tasks, links, and notifications.

## Recommended YC demo sequence

| Time | Screen | What matters |
|---:|---|---|
| 0–5s | Founder/title | “I’m Tim White, DJ/producer from LA.” |
| 5–15s | Claim Spotify profile | Fast import magic |
| 15–25s | Artist profile | One link for music, shows, fan signups |
| 25–35s | Fan opt-in | Fans choose alerts once |
| 35–45s | EP/project screen | Four-song EP problem |
| 45–55s | Generate Release Plan | Main magic click |
| 55–75s | Calendar | Four songs become a year of release moments |
| 75–90s | Detail drawer/sidebar chat | Workflows underneath + adaptive planning |

## Product roadmap doc to put in the repo

Create:

```text
/docs/product/jovie-release-operating-system.md
```

Use this structure:

```md
# Jovie Release Operating System

## Product thesis

Jovie helps music creators release and iterate faster by turning songs, artist context, fan preferences, and real-world events into an adaptive release calendar with automated workflows underneath each release moment.

## Core concept

### Release moments

Fan-facing events:
- Single
- Remix
- Acoustic version
- Lyric video
- Visualizer
- Merch drop
- Tour tie-in
- Interview/media appearance
- Anniversary release

### Workflows underneath

Operational work:
- Artwork
- Smart link
- Fan alert
- Promo copy
- Release checklist
- Playlist pitch
- Analytics review
- YouTube/social scheduling
- Team assignments

## Demo MVP

Goal: make the YC demo feel like Jovie can turn a four-song EP into a year-long release strategy.

Required surfaces:
- Spotify profile claim/import
- Artist profile
- Fan opt-in
- EP/project page
- Generate Release Plan button
- Calendar view
- Release moment drawer
- Workflow task list
- Jovie sidebar chat

## V1 product

Goal: make release planning useful without heavy automation.

Features:
- Real release calendar
- Task generation
- Smart links
- Fan notification preferences
- Basic email/SMS alerts
- Release checklists
- Manual event anchors
- Basic analytics checkpoints

## V2 product

Goal: make Jovie adaptive.

Features:
- Re-plan around tour dates, media appearances, merch drops
- Detect anniversaries
- Suggest remix/acoustic/visualizer opportunities
- Rank release moments by likely impact
- Learn from prior releases
- Suggest fan segments to notify

## V3 product

Goal: make Jovie generative.

Features:
- AI artwork
- Promo copy
- Lyric video generation
- Visualizer generation
- Stem separation
- Acoustic/piano versions
- AI mastering paths
- YouTube/social scheduling

## Long-term vision

Jovie becomes the AI operating system for music creators: it plans the release strategy, creates the assets, coordinates the workflows, notifies fans, measures results, and uses every release to improve the next one.
```

## Build order for the fastest credible demo

### Step 1: Calendar data model

Create core objects:

```ts
ReleasePlan
ReleaseMoment
WorkflowTask
ArtistEvent
FanNotification
```

The most important distinction:

```ts
type ReleaseMoment = {
  id: string
  title: string
  type: 'single' | 'remix' | 'acoustic' | 'lyric_video' | 'visualizer' | 'merch' | 'tour_tie_in'
  date: string
  trackIds: string[]
  goal: string
  tasks: WorkflowTask[]
}
```

### Step 2: Seeded release-plan generator

For the demo, the generator can use deterministic logic:

- First single this Friday.
- Follow-up content every Friday.
- Major release moment every 3–6 weeks.
- Tasks generated backward from each release date.
- Analytics checkpoint 7 days after each release.

This gives the demo reliability.

### Step 3: Calendar UI

Use a simple week-based calendar, even if it is visually styled like a year roadmap.

Cards need clear labels:

- **Release Moment**
- **Workflow**
- **Fan Alert**
- **Analytics Checkpoint**

### Step 4: Detail drawer

Click any moment and show:

- Why Jovie suggested it.
- Tasks underneath.
- Draft fan notification.
- Smart link status.
- Suggested next move.

### Step 5: Sidebar chat

Add one impressive command:

> “Add a tour date in LA on August 12 and rework the plan around it.”

Then show:

- Tour tie-in inserted.
- Fan notification added.
- Nearby release moved earlier.
- Merch/ticket moment added after the show.

That proves adaptive planning.

## The best product sentence

Use this internally:

> **Jovie turns songs into release systems.**

Use this in the demo:

> **Jovie turns four songs into a year of Fridays, and every Friday teaches me what to release next.**

That line captures the whole company.

---

## User

Okay, I’ve been granted access to the Jovie repo. Please analyze the product as it stands today and determine what needs to be done to reach this goal. Much already exists, including a Playwright video demo generator. It’s mostly a matter of moving this closer to completion.

---

## Assistant

Mr. White, I’ll inspect the repo, locate the existing product and Playwright demo surfaces, then map demo-critical gaps into a prioritized build plan for the YC release-calendar video.

---

## Assistant

I’m seeing mixed access signals across attempts: one path can read the public repo/docs, while others lack the private filesystem. I’ll ground the plan in confirmed public surfaces and clearly flag repo-specific assumptions.

---

## Assistant

Mr. White, the repo is much closer than the product narrative suggests. The core gap is **not** “build Jovie.” The gap is **add a release-planning operating layer on top of the release/profile/tasks/notification system that already exists**.

I could inspect the public repo and demo scripts, but I did not run the app or tests locally, so this is a static product/code audit rather than runtime QA.

## Bottom line

Today, Jovie still reads in the repo as a **modern artist profile and link-in-bio platform** with strong release, analytics, smart-link, notification, and task primitives. The YC goal is to make it read as a **release operating system for music creators**: songs go in, Jovie generates a calendar of release moments, and each moment has workflows underneath it. The product direction in your demo notes is exactly right: separate **release moments** from the **workflows underneath them**. fileciteturn0file0

The fastest path is to build a thin, deterministic demo layer:

> **EP / project → Generate Release Plan → Calendar → Release Moment Drawer → Workflow Tasks → Sidebar Chat Update**

Do this with seeded data and deterministic logic. Do not make audio analysis, stem separation, lyric video generation, or real SMS required for the YC demo.

---

## What already exists

### 1. Strong app foundation

The repo is a modern Next.js monorepo with `apps/web`, `packages/ui`, docs, scripts, tests, Turborepo, Clerk auth, Neon/Postgres with Drizzle, Stripe/RevenueCat, Statsig, Sentry/Vercel analytics, Tailwind, Radix/Headless UI, Vitest, and Playwright. The README currently describes the product as “a modern artist profile and link-in-bio platform,” which is accurate for the current surface but behind the new release-OS positioning. citeturn351362view0turn274471view0

### 2. The dashboard already has the right primitives

The app has authenticated dashboard routes for releases, tasks, tour dates, audience, chat, insights, links, profile, contacts, earnings, and presence. That means the “release OS” can be added as a new orchestration surface rather than a wholesale rebuild. citeturn524841view0

The releases area already has a releases dashboard, release actions, catalog task actions, per-release routes, and per-release task routes. The tasks area and tour-date area also exist as dashboard sections. citeturn323279view0turn623312view0turn323279view1turn323279view2

### 3. Release tasks already exist

There is a dedicated `lib/release-tasks` module with applicability, default templates, task selection, task normalization, clustering, and types. This is directly reusable as the **workflow underneath each release moment**. citeturn877206view0

The demo seed script already inserts release tasks from `DEFAULT_RELEASE_TASK_TEMPLATE`, marks AI-workflow tasks as done, marks the rest as todo, and computes due dates from the release date. That is already very close to the workflow side of the YC demo. citeturn492483view1

### 4. Notifications are already a real subsystem

The repo has notification modules for analytics, client/service logic, config, domain, preferences, quota, release eligibility, reputation, sender policy, suppression, validation, OTP, and provider code. This supports the fan-notification part of the story. citeturn877206view2

One important caveat: the Linear issues note says SMS notifications are gated behind Growth and that the SMS channel toggle exists on public profiles while SMS itself is stubbed or not implemented. For the YC demo, show SMS as a preview or state “email/SMS-ready” unless SMS is actually wired before recording. citeturn618903view1

### 5. Tour dates and event anchors already exist

There are dashboard routes for tour dates and a `lib/tour-dates` module. That gives you the anchor needed for the adaptive calendar demo: “move this remix closer to the LA show” or “add a tour tie-in after the performance.” citeturn323279view2turn367401view0

### 6. The Playwright demo generator is a major asset

There is already a `demo:record` package script that runs `scripts/record-yc-demo.sh`. The recording script builds the production app, starts it on port `3100`, runs the YC demo Playwright config, records 1280×720 video, transcodes to MP4, validates dimensions, and generates a contact sheet. citeturn921642view0turn492483view0

The demo Playwright config is already purpose-built: it records video, uses a 1280×720 viewport, runs serially, has a five-minute timeout, and matches `yc-demo.spec.ts`. citeturn383927view0turn383927view2

The current `yc-demo.spec.ts` drives this sequence: home page → authenticate demo user → releases dashboard → open several release sidebars → per-release tasks page → public smart link → public artist profile → subscribe mode. That is useful, but it is still a **release/profile demo**, not yet a **release-calendar OS demo**. citeturn297773view3turn297773view4

---

## The core missing product layer

The missing object is:

```ts
ReleasePlan
```

Under it:

```ts
ReleaseMoment
WorkflowTask
ArtistEvent
FanNotificationPreview
AnalyticsCheckpoint
```

Existing releases and tasks are per-release. The new demo needs a **plan-level calendar** that can coordinate singles, remixes, acoustic versions, lyric videos, merch drops, tour tie-ins, interviews, fan alerts, and analytics checkpoints across time.

Today the repo has:

| Area | Status |
|---|---|
| Artist/profile/import story | Mostly present |
| Releases dashboard | Present |
| Per-release drawer/workspace | Present |
| Release tasks | Present |
| Public smart links | Present |
| Public artist profile | Present |
| Fan subscription surface | Present |
| Notifications subsystem | Present |
| Tour dates | Present |
| Demo recorder | Present |
| Release calendar | Missing |
| Release plan object | Missing |
| Release moment object | Missing |
| EP/project planning screen | Missing or insufficient for the new demo |
| Generate Release Plan magic button | Missing |
| Calendar detail drawer for release moments | Missing |
| Sidebar chat that edits the plan | Missing or needs demo-specific binding |

---

## What needs to be built now

### P0: Build the YC demo surface

Create a dedicated YC demo path rather than bending the whole product around the demo:

```txt
/apps/web/app/app/(shell)/dashboard/release-plan/page.tsx
```

or:

```txt
/apps/web/app/app/(shell)/dashboard/calendar/page.tsx
```

The page should show:

1. **Project header**
   - `All This Noise`
   - Four tracks
   - “Studio project”
   - “Goal: turn 4 songs into a year of Fridays”

2. **Track cards**
   - Song title
   - Vibe
   - Suggested release role
   - Example:
     - electronic / club → first single
     - emotional / vocal → acoustic candidate
     - high-energy → remix candidate
     - intimate / melodic → visualizer candidate

3. **Generate Release Plan button**
   - The main magic moment.
   - On click, swap from project view to calendar view.
   - For demo reliability, use deterministic seeded data.

4. **Calendar view**
   - Show 12 months or a roadmap-style year.
   - Friday-oriented moments.
   - Cards labeled clearly:
     - Single
     - Club remix
     - Piano-and-vocal version
     - Lyric video
     - Visualizer
     - Merch drop
     - LA tour tie-in
     - Analytics checkpoint

5. **Release moment drawer**
   - Click a calendar card.
   - Drawer shows:
     - Goal
     - Why Jovie suggested it
     - Smart link status
     - Fan notification preview
     - Workflow tasks
     - Analytics checkpoint

6. **Sidebar chat**
   - One canned high-impact command:
     > Move the remix closer to the LA show and add a fan notification.
   - Then mutate the local calendar state:
     - Move remix card
     - Add tour tie-in card
     - Add fan alert task
     - Show “Plan updated”

This makes the demo feel adaptive without requiring an LLM, audio model, or production calendar planner.

---

## P0 implementation plan

### 1. Add a release-planning fixture

Create:

```txt
/apps/web/lib/release-planning/demo-release-plan.ts
```

Suggested shape:

```ts
export type ReleaseMomentType =
  | 'single'
  | 'remix'
  | 'acoustic'
  | 'lyric_video'
  | 'visualizer'
  | 'merch'
  | 'tour_tie_in'
  | 'fan_alert'
  | 'analytics_checkpoint';

export type ReleaseMoment = {
  id: string;
  title: string;
  type: ReleaseMomentType;
  date: string;
  trackIds: string[];
  goal: string;
  reason: string;
  fanFacing: boolean;
  tasks: DemoWorkflowTask[];
  fanNotificationPreview?: string;
  smartLinkStatus?: 'ready' | 'draft' | 'scheduled';
  analyticsCheckpointDate?: string;
};

export type DemoWorkflowTask = {
  id: string;
  title: string;
  status: 'done' | 'todo' | 'scheduled';
  assignee: 'jovie' | 'creator' | 'team';
  dueDate: string;
};
```

Keep it fixture-first for YC. Persist it later.

### 2. Add deterministic generator logic

Create:

```txt
/apps/web/lib/release-planning/generate-demo-release-plan.ts
```

Rules:

```txt
- First single this Friday.
- Follow-up moment every Friday.
- Major release moment every 3–6 weeks.
- Tasks generated backward from each release date.
- Analytics checkpoint 7 days after each major release.
- Tour tie-in placed around seeded LA tour date.
- Remix/acoustic/visualizer suggestions selected from track vibe.
```

The generator should feel smart, but it can be rule-based.

### 3. Reuse release task templates

The existing `DEFAULT_RELEASE_TASK_TEMPLATE` should be mapped into release-moment tasks. The seed script already does this for releases, so the demo can reuse that pattern. citeturn492483view1

For demo UI, label tasks as:

```txt
Artwork
Smart link
Fan notification
Promo copy
Release checklist
Playlist pitch
Analytics review
```

That aligns exactly with the script distinction between release moments and workflows. fileciteturn0file0

### 4. Add the calendar component

Create:

```txt
/apps/web/components/jovie/release-calendar/ReleaseCalendar.tsx
/apps/web/components/jovie/release-calendar/ReleaseMomentCard.tsx
/apps/web/components/jovie/release-calendar/ReleaseMomentDrawer.tsx
/apps/web/components/jovie/release-calendar/ReleasePlanSidebar.tsx
```

Visual requirements:

| UI piece | Purpose |
|---|---|
| Calendar / roadmap | Proves Jovie creates the year |
| Color/tag by type | Makes release moments legible |
| Drawer | Proves each moment has operational depth |
| Sidebar chat | Proves the plan adapts |
| Task stack | Connects new surface to existing product |

Use `data-testid` attributes for every demo-critical element.

### 5. Add a YC-specific demo route or state

The existing `/demo` page renders `DemoReleasesExperience`, and its metadata describes “releases, audience insights, and analytics,” which is the old demo frame. citeturn732897view0

Add either:

```txt
/demo/release-os
```

or an authenticated route:

```txt
/app/dashboard/release-plan
```

I would use the authenticated dashboard route for the video because the YC script wants the viewer to feel this is the actual product.

### 6. Update the Playwright video sequence

Current sequence:

```txt
Home
→ Auth
→ Releases dashboard
→ Release drawers
→ Release tasks
→ Smart link
→ Public profile
→ Subscribe modal
```

New sequence:

```txt
Home / claim/import setup
→ Releases or project screen
→ All This Noise EP
→ Generate Release Plan
→ Calendar
→ Open release moment drawer
→ Sidebar chat updates the plan
→ Public profile / fan opt-in as proof fans receive moments
```

The existing `yc-demo.spec.ts` already has captions, transitions, auth bypass, seeded release lookup, cleanup, and video save behavior. Keep that structure and replace the middle of the demo with the release-plan sequence. citeturn297773view3turn297773view4

Update `record-yc-demo.sh` contact sheet timestamps. The current script samples frames around a shorter demo cadence; a 90-second YC demo should sample the key scenes: import, profile, fan opt-in, project, generate click, calendar, drawer, chat update, final calendar. citeturn492483view0

---

## P1: Make the demo layer real enough for product V1

After the YC video surface works, persist it.

Add tables:

```txt
release_plans
release_moments
release_moment_tracks
release_moment_tasks
release_moment_events
```

Minimum schema:

```ts
release_plans:
- id
- creator_profile_id
- title
- status
- strategy_summary
- start_date
- end_date
- created_at
- updated_at

release_moments:
- id
- release_plan_id
- type
- title
- date
- goal
- reason
- status
- source
- linked_release_id nullable
- linked_tour_date_id nullable
- metadata jsonb

release_moment_tasks:
- id
- release_moment_id
- release_task_id nullable
- title
- status
- assignee_type
- due_date
```

The key product move: **release tasks become children of release moments**, not just children of releases.

---

## P1: Wire existing systems into release moments

Once persisted, connect:

| Existing system | New release-OS role |
|---|---|
| `discogReleases` | Songs/releases used as source material |
| `discogTracks` | Track-level planning input |
| `providerLinks` | Smart-link readiness |
| `releaseTasks` | Workflow tasks underneath moments |
| `fanReleaseNotifications` | Notification preview/send state |
| `tourDates` | Calendar anchors |
| `aiInsights` | “Why Jovie suggested this” |
| analytics/click events | Feedback loop after each release |

The seed script already references `discogReleases`, `discogTracks`, `providerLinks`, `tourDates`, `audienceMembers`, notification subscriptions, fan release notifications, AI insights, and release tasks, which means the demo data model has many of the right pieces already seeded. citeturn492483view1

---

## What to defer

Defer everything that does not make the video clearer.

| Feature | Defer decision |
|---|---|
| Real audio analysis | Mock vibe labels for demo |
| Stem separation | Show as suggested future task |
| Piano/acoustic generation | Show as release moment + task |
| Lyric video generation | Show as planned workflow |
| Real SMS | Use preview unless implementation is ready |
| Real playlist matching | Use believable labels like “electronic playlists” |
| Full smart-link geo/device routing | Product V1/P1, not YC demo blocker |
| Spotify API ingestion overhaul | Important later; current HTTP scraping is already documented as current strategy |
| Extension/browser automation | Future distribution/ops layer |
| Retargeting/ad integrations | Future growth layer |
| Checkout/earnings polish | Not part of the release-OS video |

The repo’s own issue docs already point to SMS as gated/stubbed, smart-link routing as launch-relevant, and Spotify ingestion upgrades as a future confidence improvement. citeturn618903view1turn544251view3

---

## Recommended build order

### Step 1: Product doc in repo

Add:

```txt
/docs/product/jovie-release-operating-system.md
```

This should define:

```txt
- Release OS thesis
- ReleaseMoment vs WorkflowTask
- Demo MVP
- V1 persisted product
- V2 adaptive planner
- V3 generative workflows
```

This becomes the instruction source for agents.

### Step 2: Demo release-plan data

Add fixture + generator:

```txt
/apps/web/lib/release-planning/demo-release-plan.ts
/apps/web/lib/release-planning/generate-demo-release-plan.ts
```

### Step 3: Calendar UI

Add:

```txt
/apps/web/components/jovie/release-calendar/*
```

### Step 4: Dashboard route

Add:

```txt
/apps/web/app/app/(shell)/dashboard/release-plan/page.tsx
```

or:

```txt
/apps/web/app/app/(shell)/dashboard/calendar/page.tsx
```

### Step 5: Sidebar chat mutation

Implement one deterministic interaction:

```txt
“Move the remix closer to the LA show and add a fan notification.”
```

### Step 6: Update Playwright demo

Modify:

```txt
/apps/web/tests/e2e/yc-demo.spec.ts
/apps/web/scripts/record-yc-demo.sh
```

The current demo automation is already well-structured, so this is mostly sequencing and selectors. citeturn383927view2turn297773view3turn492483view0

---

## The demo should prove exactly this

1. **Jovie imports artist context.**
2. **Jovie understands songs as planning inputs.**
3. **Jovie generates release moments.**
4. **Each release moment has workflow tasks underneath.**
5. **The calendar adapts around real-world events.**
6. **Fans get notified automatically.**

That is the whole YC demo.

The strongest final line remains:

> **Jovie turns four songs into a year of Fridays, and every Friday teaches me what to release next.**

---

## User

give me a prompt for office hours gstack skill  to start working on this paln

---

## Assistant

I’ll give you a copy-pasteable prompt that makes the agent produce code/docs immediately, with a clear demo-first scope and guardrails against overbuilding.

---

## Assistant

Mr. White, paste this into Claude Code from the Jovie repo root:

```md
/office-hours

We are working on Jovie, a music creator release operating system.

Context:
I’m the founder of Jovie. The product already has a Next.js app, dashboard, artist profiles, releases, smart links, fan opt-in/notifications, tour dates, tasks, analytics/insights, and a Playwright YC demo video generator.

The current repo is closer to a modern artist profile / release / smart-link platform. The goal is to move it toward a release operating system for music creators.

Core product thesis:
Jovie helps music creators release and iterate faster by turning songs, artist context, fan preferences, tour dates, media events, and creative ideas into an adaptive release calendar with workflows underneath each release moment.

Important demo concept:
A “release moment” is what fans experience:
- single
- remix
- acoustic version
- lyric video
- visualizer
- merch drop
- tour tie-in
- interview/media appearance
- anniversary moment

A “workflow” is the operational work underneath the release moment:
- artwork
- smart link
- fan notification
- promo copy
- release checklist
- playlist pitch
- analytics review
- team task
- scheduled content

YC demo goal:
Build the fastest credible demo where a creator starts with a four-song EP called “All This Noise,” clicks “Generate Release Plan,” and Jovie turns those four songs into a year of Friday release moments. The demo should show the calendar, release moment drawer, generated tasks/workflows, fan notification preview, and one adaptive planning interaction through a sidebar chat.

The demo should prove:
1. Jovie imports or understands artist context.
2. Jovie accepts songs as planning inputs.
3. Jovie generates a release calendar.
4. Jovie separates release moments from workflows.
5. Each release moment has tasks underneath.
6. The plan can adapt around real-world events like tour dates or media appearances.
7. Fans get notified automatically.

Constraints:
- Do not overbuild.
- Do not require real audio analysis for the first demo.
- Do not require real stem separation, lyric video generation, SMS sending, playlist matching, or full AI automation.
- Use deterministic seeded data where needed.
- Prioritize the YC demo video path.
- The demo must be reliable under Playwright.
- Add data-testid attributes to demo-critical UI.
- Keep all new work aligned with the existing app structure and design system.
- Prefer adding a thin release-planning layer on top of existing releases/tasks/notifications/tour dates rather than rewriting current systems.

What I want from this Office Hours session:
Pressure-test the idea and scope like YC office hours, but end with an actionable design doc that can live in the repo.

Please produce:
1. The narrowest credible wedge for the YC demo.
2. The exact product surface we should build first.
3. What should be mocked vs real.
4. The riskiest assumptions.
5. The fastest implementation path.
6. A repo doc outline for `/docs/product/jovie-release-operating-system.md`.
7. A prioritized build plan for:
   - P0 YC demo
   - P1 real persisted product
   - P2 adaptive planner
   - P3 generative workflows
8. Specific files/routes/components likely needed.
9. A recommendation for how to update the Playwright demo script.
10. A clear definition of done for the first milestone.

Please inspect the repo before finalizing the design doc. Pay special attention to:
- existing dashboard routes
- releases
- release tasks
- notifications
- tour dates
- analytics/insights
- demo/Playwright scripts
- seed demo account scripts
- existing docs and product notes

Proposed P0 implementation direction:
- Add `apps/web/lib/release-planning/demo-release-plan.ts`
- Add `apps/web/lib/release-planning/generate-demo-release-plan.ts`
- Add release calendar components under `apps/web/components/jovie/release-calendar/`
- Add a dashboard route such as `apps/web/app/app/(shell)/dashboard/release-plan/page.tsx`
- Build a deterministic “Generate Release Plan” flow
- Show a calendar/roadmap of release moments
- Add a release moment detail drawer
- Show generated workflow tasks
- Show a fan notification preview
- Add one canned sidebar chat command:
  “Move the remix closer to the LA show and add a fan notification.”
- Update `apps/web/tests/e2e/yc-demo.spec.ts` so the YC demo video centers on this flow.

Do not start by coding randomly. Start by creating the design doc and implementation plan. After that, recommend the next gstack skill to run.
```

The prompt is tuned for `/office-hours` because that skill is designed to pressure-test the idea and save a design doc before planning and implementation; GStack’s documented lifecycle is `office-hours → plan → implement → review → QA → ship → retro`. citeturn752722search0turn752722search2

It also bakes in the key Jovie framing from your current demo notes: **release moments** as fan-facing events and **workflows** as the operational layer underneath them. fileciteturn0file0

After Office Hours produces the doc, run this next:

```md
/plan-ceo-review

Review the Jovie release operating system design doc created by /office-hours.

Focus on:
- YC demo strength
- narrowest useful wedge
- whether this feels inevitable to music creators
- whether the demo proves a real product rather than a dashboard
- what to cut
- what to make more ambitious
- what has to ship first
```

Then:

```md
/plan-eng-review

Review the Jovie release operating system implementation plan.

Focus on:
- whether the P0 demo can be built quickly and reliably
- where to use seeded deterministic data
- where existing releases/tasks/notifications/tour-date code should be reused
- what routes/components/types need to be added
- what should be mocked
- what needs data-testid selectors for Playwright
- risks that could break the demo recording
