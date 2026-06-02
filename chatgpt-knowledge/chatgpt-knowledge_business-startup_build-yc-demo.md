---
title: "Build YC Demo"
type: guide
created: 2026-04-25
updated: 2026-04-25
source: chatgpt-export
topic: business-startup
message_count: 9
tags: [chatgpt, knowledge, business-startup]
---
**Topic:** [[chatgpt-knowledge/_topics/business-startup]]

# Build YC Demo

> **Source:** ChatGPT conversation
> **Date:** 2026-04-25T00:50:40Z
> **Messages:** 9
> **Topic:** business-startup

## Answer

Mr. White, I’ll separate the YC demo from the longer-term product roadmap, define the smallest credible build, and structure the broader vision for agent-executable execution.

## Answer

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
**Analytics

*(Answer truncated — 8259 chars total)*

## Question

Okay, I’ve been granted access to the Jovie repo. Please analyze the product as it stands today and determine what needs to be done to reach this goal. Much already exists, including a Playwright video demo generator. It’s mostly a matter of moving this closer to completion.

## Answer

Mr. White, I’ll inspect the repo, locate the existing product and Playwright demo surfaces, then map demo-critical gaps into a prioritized build plan for the YC release-calendar video.

## Answer

I’m seeing mixed access signals across attempts: one path can read the public repo/docs, while others lack the private filesystem. I’ll ground the plan in confirmed public surfaces and clearly flag repo-specific assumptions.

## Answer

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

### 4. Notification

*(Answer truncated — 16471 chars total)*

## Question

give me a prompt for office hours gstack skill  to start working on this paln

## Answer

I’ll give you a copy-pasteable prompt that makes the agent produce code/docs immediately, with a clear demo-first scope and guardrails against overbuilding.

## Answer

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
6. A repo doc outl

*(Answer truncated — 5872 chars total)*
