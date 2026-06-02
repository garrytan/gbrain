---
title: "YC Demo Planning"
type: essay
created: 2026-04-21
updated: 2026-04-21
source: chatgpt-export
conversation_id: 69e7dc07-2be8-83e8-9165-2a3514032865
message_count: 7
tags: [chatgpt, import, code, long-form]
---
# YC Demo Planning

> Conversation ID: 69e7dc07-2be8-83e8-9165-2a3514032865
> Created: 2026-04-21T20:20:23Z
> Updated: 2026-04-21T21:00:00Z
> Messages: 7

---

## User

I need to report a product demo for YC but also for Endresim and all that. We have a Playwright file in the repo that runs through and does have a demo. There's some context in the ops repo under fundraising but I'm happy to do it as a Loom and narrate it. I have the Playwright just so that I can have an automated way of confirming that all the screens look good and stuff.

I want to work the codebase and the ops repo and everything that we talk about in the YC application. I want to compile everything together into what would be the ideal demo as step one. What are the screens you want to show? How do we keep it concise while still showing all the magic moments and stuff? Work backwards from that to run the Playwright one time and have it actually deal with all of those screens so I can watch it live or have it export a video and then watch that video and make sure all the screens look good. Then I can systematically tackle each one of those issues.

Once that's done I can reproduce it. Ideally it would be better to just have the Playwright properly timed and then I can record a vo we can drop in and dimension resolve or something. I can do a quick edit pass on that to make it look clean. If it's not, that would basically be the ideal situation for that. I need deterministic step-by-step instructions to go from where we are right now. It's kind of unclear which one of these steps has friction in it, which one has slow loading, which one has different issues or poorly mocked data, or anything like that, to get to a full video demo that shows every single one of these screens. We need to highlight public profiles and then we also need to highlight the backend. I think some of the core things that would be important to see would be, well you should work backwards from the YC application, obviously, to figure out exactly what should be shown. 

---

## Assistant

I’ll work backwards from the application/demo goal, then turn that into a concrete demo script and Playwright/video pipeline. I’ll also verify current YC demo expectations rather than relying on memory.

---

## Assistant

I found the strongest product-demo narrative in the prior Jovie materials: one artist moving from fan capture through pre-save, release ops, launch, and audience analytics into compounding growth.

---

## Assistant

Mr. White, the demo should be built as **one deterministic product story**, then exported in two cuts:

1. **YC product demo:** 80–95 seconds, product-only. YC’s founder application video is separate and should be founders talking only; YC explicitly says that video is not the place for a product demo, and product demos belong elsewhere in the application. citeturn292406view0  
2. **Investor / “Endresim” version:** 2:00–2:45, same core story with a little more backend, data flow, and traction/proof. I could not verify “Endresim” as a known investor/fundraising target, so I’d treat it as the broader investor-facing cut unless you meant a specific person or firm.

## The ideal demo narrative

The spine should be:

**“Jovie runs an independent artist’s release from fan capture to launch in one system.”**

Everything in the video should prove one of these claims:

| Claim | Screen that proves it |
|---|---|
| Artists get a beautiful public profile and owned fan hub | Public artist profile |
| Every release has a conversion page | Pre-save / release page |
| Jovie turns a release into an execution plan | Backend release command center |
| The system fills in launch tasks, assets, links, and messaging | Generated plan / campaign tasks |
| The same public URL works before and after release day | Pre-save page → live smart link |
| Artists build owned audience, not platform-only reach | Audience segment / captured fans |
| Jovie tells artists what to do next | Analytics insight / geo-platform insight |
| This compounds across releases | Catalog or compounding chart |

YC emphasizes clear, matter-of-fact explanations over broad marketing language, so the demo should show a concrete workflow, not a category pitch. citeturn292406view2

## Recommended YC cut: 90-second storyboard

| Time | Screen | Action | Magic moment |
|---:|---|---|---|
| 0–6s | Public artist profile, mobile-sized | Show the artist profile immediately | “This is the owned hub an artist sends fans to.” |
| 6–16s | Upcoming release pre-save page | Fan enters email/phone or clicks pre-save | Fan capture is visible, not abstract. |
| 16–28s | Backend release dashboard | Open the release: **“Take Me Over — Apr 24, 2026”** | Same release object powers the public page. |
| 28–42s | Generate launch plan / command center | Click or reveal generated plan | Jovie turns a release into tasks, copy, dates, assets, links. |
| 42–54s | Campaign tasks / notifications | Show tasks already filled and scheduled | The artist does not start from a blank canvas. |
| 54–66s | Public URL after launch | Flip from pre-save to live release smart link | Same URL becomes the launch page automatically. |
| 66–78s | Audience segment | Show “684 pre-saves,” “2,143 contacts,” or real demo-safe equivalent | The artist owns the fan relationship. |
| 78–90s | Analytics insight | Show “Apple Music over-indexing in Berlin” + suggested next action | Jovie tells the artist what to do next. |

Use seeded demo numbers only as product-state examples. Do not imply they are company traction unless they are real.

## Investor cut additions

For the longer investor version, add 45–75 seconds after the YC spine:

| Add-on | Why it matters |
|---|---|
| Backend data object for one release | Shows this is infrastructure, not landing pages. |
| Integration/status panel: Spotify import, links, notification readiness | Shows operational depth. |
| Audience table or segment builder | Shows the CRM layer. |
| Admin/internal queue, if polished | Shows the backend machinery. |
| One metrics screen | Shows the loop: release → capture → notify → learn → next release. |

Avoid pricing, billing, settings, onboarding, OAuth, team management, empty dashboards, raw admin tables, and anything requiring manual typing for more than two seconds.

---

# Deterministic execution plan

## 1. Create a demo branch

From the product repo:

```bash
git checkout -b demo/yc-product-video
```

Create a working directory for all demo artifacts:

```bash
mkdir -p docs/fundraising/demo scripts/demo tests/demo demo-artifacts
```

## 2. Audit the repos for existing material

Run this from the parent folder containing the product repo and ops repo:

```bash
rg -n "YC|Y Combinator|application|fundraising|demo|Loom|investor|a16z|Andreessen|Endresim|public profile|profile|presave|pre-save|smart link|release page|audience|analytics|notifications|Playwright" . \
  --glob '!node_modules' \
  --glob '!dist' \
  --glob '!build' \
  --glob '!coverage'
```

Find the current Playwright demo file:

```bash
find . -iname '*playwright*' -o -path '*e2e*' -o -path '*demo*' | sort
rg -n "test\\(|page\\.goto|recordVideo|video|trace|Take Me Over|demo" . \
  --glob '!node_modules' \
  --glob '!dist' \
  --glob '!build'
```

Create this file:

```bash
touch docs/fundraising/demo/yc-demo-claims.md
```

Paste the claims that the demo must prove:

```md
# YC demo claims

One-sentence demo:
Jovie runs an independent artist’s release from fan capture to launch in one system.

Must show:
- Public artist profile
- Public pre-save / release page
- Backend release command center
- Generated release plan / campaign tasks
- Same public URL before and after launch
- Audience capture / segment
- Analytics insight
- Compounding across releases

Must avoid:
- Homepage
- Pricing
- Billing
- Settings
- Long typing
- OAuth
- Empty states
- Unsupported traction claims
- Secrets or private customer data
```

## 3. Convert the storyboard into a machine-readable manifest

Create:

```bash
touch scripts/demo/yc-demo-manifest.json
```

Use this structure:

```json
{
  "demo": "yc-product-demo",
  "target_duration_seconds": 90,
  "seed": {
    "artist": "Nova Rae",
    "upcoming_release": "Take Me Over",
    "release_date": "2026-04-24",
    "live_release": "Afterglow",
    "contacts": 2143,
    "presaves": 684,
    "insight": "Apple Music is over-indexing in Berlin"
  },
  "scenes": [
    {
      "id": "01-public-profile",
      "route": "/demo/profile",
      "viewport": "mobile",
      "hold_ms": 5500,
      "ready_selector": "[data-demo-ready='public-profile']",
      "must_show": ["artist name", "release card", "fan CTA"]
    },
    {
      "id": "02-presave",
      "route": "/demo/presave",
      "viewport": "mobile",
      "hold_ms": 8500,
      "ready_selector": "[data-demo-ready='presave']",
      "must_show": ["release title", "pre-save CTA", "fan capture"]
    },
    {
      "id": "03-release-command-center",
      "route": "/demo/backend/release",
      "viewport": "desktop",
      "hold_ms": 12000,
      "ready_selector": "[data-demo-ready='release-dashboard']",
      "must_show": ["release date", "status", "public URL", "tasks"]
    },
    {
      "id": "04-generated-plan",
      "route": "/demo/backend/plan",
      "viewport": "desktop",
      "hold_ms": 14000,
      "ready_selector": "[data-demo-ready='generated-plan']",
      "must_show": ["generated launch plan", "copy", "dates", "assets"]
    },
    {
      "id": "05-campaign-tasks",
      "route": "/demo/backend/tasks",
      "viewport": "desktop",
      "hold_ms": 10000,
      "ready_selector": "[data-demo-ready='campaign-tasks']",
      "must_show": ["scheduled reminders", "task completion", "fan notification"]
    },
    {
      "id": "06-live-link",
      "route": "/demo/live-release",
      "viewport": "mobile",
      "hold_ms": 10000,
      "ready_selector": "[data-demo-ready='live-release']",
      "must_show": ["same URL", "listen links", "post-launch state"]
    },
    {
      "id": "07-audience",
      "route": "/demo/backend/audience",
      "viewport": "desktop",
      "hold_ms": 11500,
      "ready_selector": "[data-demo-ready='audience']",
      "must_show": ["contacts", "pre-save segment", "opt-ins"]
    },
    {
      "id": "08-insight",
      "route": "/demo/backend/insight",
      "viewport": "desktop",
      "hold_ms": 13000,
      "ready_selector": "[data-demo-ready='insight']",
      "must_show": ["geo insight", "platform insight", "recommended action"]
    }
  ]
}
```

The `/demo/...` routes can be real routes, query-param scene states, or wrappers around existing routes. The point is that each scene opens directly into the polished state.

## 4. Add deterministic demo mode

Add a single environment flag:

```bash
DEMO_MODE=1
```

Demo mode should do these things:

```ts
const DEMO_MODE = process.env.DEMO_MODE === '1';
```

When enabled:

```ts
// Required demo-mode behavior
// - Freeze current date/time.
// - Use seeded demo data.
// - Disable random loading copy.
// - Disable onboarding popups.
// - Disable upgrade prompts.
// - Use local/static artwork.
// - Use deterministic analytics fixtures.
// - Hide private IDs, emails, tokens, customer secrets.
// - Ensure every scene has a data-demo-ready marker.
```

Use these stable selectors in the UI:

```html
<div data-demo-ready="public-profile"></div>
<div data-demo-ready="presave"></div>
<div data-demo-ready="release-dashboard"></div>
<div data-demo-ready="generated-plan"></div>
<div data-demo-ready="campaign-tasks"></div>
<div data-demo-ready="live-release"></div>
<div data-demo-ready="audience"></div>
<div data-demo-ready="insight"></div>
```

Also add `data-testid` to buttons and key UI regions:

```html
<button data-testid="generate-launch-plan">Generate launch plan</button>
<section data-testid="audience-segment-presaves"></section>
<section data-testid="analytics-geo-insight"></section>
```

## 5. Seed the exact demo story

Create:

```bash
touch scripts/demo/seed-demo.ts
```

Seed one complete artist universe:

```ts
export const demoSeed = {
  artist: {
    name: 'Nova Rae',
    handle: 'novarae',
    genre: 'indie pop',
    profileUrl: '/novarae'
  },
  upcomingRelease: {
    title: 'Take Me Over',
    releaseDate: '2026-04-24',
    state: 'prelaunch',
    publicUrl: '/novarae/take-me-over'
  },
  liveRelease: {
    title: 'Afterglow',
    releaseDate: '2026-04-04',
    state: 'live',
    publicUrl: '/novarae/afterglow'
  },
  audience: {
    contacts: 2143,
    presaves: 684,
    optedInSms: 391,
    optedInEmail: 1732
  },
  insight: {
    city: 'Berlin',
    platform: 'Apple Music',
    message: 'Apple Music is over-indexing in Berlin. Schedule a Berlin-focused follow-up.'
  }
};
```

Wire it into whatever seed system the repo already uses:

```bash
pnpm demo:seed
```

If that script does not exist yet, add it to `package.json`:

```json
{
  "scripts": {
    "demo:seed": "tsx scripts/demo/seed-demo.ts"
  }
}
```

## 6. Create a dedicated Playwright demo config

Create:

```bash
touch playwright.demo.config.ts
```

Use one worker, fixed viewport, video, trace, and stable screenshot behavior:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/demo',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'demo-artifacts/playwright-report', open: 'never' }],
    ['list']
  ],
  use: {
    baseURL: process.env.DEMO_BASE_URL || 'http://localhost:3000',
    headless: false,
    viewport: { width: 1440, height: 900 },
    video: {
      mode: 'on',
      size: { width: 1440, height: 900 }
    },
    trace: 'on',
    screenshot: 'on',
    actionTimeout: 15_000,
    navigationTimeout: 30_000
  },
  projects: [
    {
      name: 'demo-desktop',
      use: {
        viewport: { width: 1440, height: 900 }
      }
    },
    {
      name: 'demo-mobile',
      use: {
        ...devices['iPhone 14'],
        viewport: { width: 390, height: 844 }
      }
    }
  ]
});
```

Playwright can record videos through the `video` option, and video files appear in the test output directory after the browser context closes. citeturn902551view0 Traces are useful because they let you inspect the action timeline, DOM snapshots, network, and console after the run. citeturn902551view1

## 7. Create the demo Playwright file

Create:

```bash
touch tests/demo/yc-demo.spec.ts
```

Skeleton:

```ts
import { test, expect, Page } from '@playwright/test';
import manifest from '../../scripts/demo/yc-demo-manifest.json';

async function waitForDemoReady(page: Page, selector: string) {
  await expect(page.locator(selector)).toBeVisible({ timeout: 20_000 });
}

async function holdScene(page: Page, ms: number) {
  // Intentional hold for video pacing. Do not use this for readiness.
  await page.waitForTimeout(ms);
}

async function assertNoObviousErrors(page: Page) {
  const body = page.locator('body');
  await expect(body).not.toContainText(/500|Internal Server Error|Something went wrong/i);
}

test.describe('YC product demo', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', msg => {
      if (['error'].includes(msg.type())) {
        console.log(`[browser console error] ${msg.text()}`);
      }
    });
  });

  for (const scene of manifest.scenes) {
    test(`${scene.id}`, async ({ page }) => {
      await test.step(`open ${scene.id}`, async () => {
        await page.goto(scene.route, { waitUntil: 'domcontentloaded' });
        await waitForDemoReady(page, scene.ready_selector);
        await assertNoObviousErrors(page);
      });

      await test.step(`verify required copy for ${scene.id}`, async () => {
        for (const text of scene.must_show) {
          await expect(page.locator('body')).toContainText(new RegExp(text, 'i'));
        }
      });

      await test.step(`capture ${scene.id}`, async () => {
        await page.screenshot({
          path: `demo-artifacts/screenshots/${scene.id}.png`,
          fullPage: false
        });
        await holdScene(page, scene.hold_ms);
      });
    });
  }
});
```

Playwright auto-waits for actionability checks and assertions can wait for expected UI state, so use selectors and assertions for readiness rather than arbitrary sleeps. Use `waitForTimeout` only for intentional video pacing. citeturn902551view3

## 8. Run the first audit pass

Terminal 1:

```bash
DEMO_MODE=1 pnpm dev
```

Terminal 2:

```bash
DEMO_MODE=1 pnpm demo:seed
DEMO_MODE=1 npx playwright test -c playwright.demo.config.ts --project=demo-desktop
```

Open the report:

```bash
npx playwright show-report demo-artifacts/playwright-report
```

Open a trace if needed:

```bash
npx playwright show-trace path/to/trace.zip
```

Find generated videos:

```bash
find test-results demo-artifacts -iname '*.webm' -o -iname '*.mp4' | sort
```

## 9. Build the issue ledger

Create:

```bash
touch demo-artifacts/demo-issues.csv
```

Use this schema:

```csv
scene_id,timestamp,priority,type,issue,fix,status
01-public-profile,00:03,A,visual,Profile card clipped on mobile,Fix responsive card height,open
03-release-command-center,00:21,A,loading,Dashboard skeleton visible too long,Preload release fixture or wait for ready marker,open
04-generated-plan,00:35,B,copy,Generated task labels too generic,Seed stronger demo copy,open
07-audience,01:10,A,data,Audience numbers mismatch VO,Use single seed source,open
08-insight,01:24,B,narrative,Insight screen unclear,Add highlighted recommended action,open
```

Priority definitions:

| Priority | Meaning | Fix before final? |
|---|---|---|
| A | Breaks narrative, wrong data, visible error, slow load, private info, ugly enough to distract | Yes |
| B | Polish issue, weak copy, awkward spacing, unclear highlight | Usually |
| C | Nice-to-have improvement | Only if cheap |

Fix order:

1. **Data determinism**
2. **Route readiness**
3. **Loading states**
4. **Visual layout**
5. **Copy clarity**
6. **Timing**
7. **Final narration**

## 10. Add visual regression checks after the first good pass

Once each scene looks good, add screenshot assertions. Playwright supports `expect(page).toHaveScreenshot()` and can generate reference screenshots on first run, then compare later runs against them. citeturn902551view2

Example:

```ts
await expect(page).toHaveScreenshot(`${scene.id}.png`, {
  maxDiffPixels: 500
});
```

First baseline run:

```bash
DEMO_MODE=1 npx playwright test -c playwright.demo.config.ts --project=demo-desktop --update-snapshots
```

Then normal verification:

```bash
DEMO_MODE=1 npx playwright test -c playwright.demo.config.ts --project=demo-desktop
```

Keep baselines stable by using the same OS, browser, viewport, fonts, and headless/headed mode. Playwright notes that screenshots can vary by host OS, browser, hardware, power source, and headless mode. citeturn902551view2

## 11. Export a rough cut from Playwright videos

Create a concat list:

```bash
find test-results -iname '*.webm' | sort | awk '{print "file \x27" $0 "\x27"}' > demo-artifacts/video-list.txt
```

Concatenate and transcode:

```bash
ffmpeg -f concat -safe 0 -i demo-artifacts/video-list.txt \
  -c:v libx264 -pix_fmt yuv420p -r 30 -movflags +faststart \
  demo-artifacts/jovie-yc-demo-rough.mp4
```

If scene order is wrong, manually create `demo-artifacts/video-list.txt` in the manifest order.

## 12. Record the final version

Best workflow:

1. Run the deterministic Playwright demo headed.
2. Record the browser window with Loom, Screen Studio, or QuickTime.
3. Use Playwright’s exported video as the QA artifact.
4. Use the screen recording as the final visual base if it looks cleaner.
5. Drop VO into DaVinci Resolve.
6. Cut pauses, hide waits, add 2–3 zooms max, export 1080p MP4.

Final headed run:

```bash
DEMO_MODE=1 npx playwright test -c playwright.demo.config.ts --project=demo-desktop --headed
```

For a fully automated final capture, rely on the Playwright videos and transcode to MP4. For the cleanest investor-facing polish, record the deterministic headed run and edit in Resolve.

---

# Draft YC voiceover

Target: ~85–95 seconds.

> Jovie is a release command center for independent artists.  
>  
> This is the public artist profile: one owned hub where fans can find the artist, join the audience, and follow each release.  
>  
> For an upcoming song, Jovie creates a pre-save page that captures fans before release day instead of sending all that demand back to the platforms.  
>  
> In the backend, the artist sees the same release as a launch workspace. Jovie knows the release date, assets, links, fan activity, and what needs to happen next.  
>  
> The magic is that Jovie turns the release into an execution plan: tasks, launch copy, reminders, dates, and fan messaging are already filled in.  
>  
> On release day, the same public URL turns into a live smart link, so the campaign does not reset.  
>  
> Every fan captured through the campaign becomes part of the artist’s owned audience, so the next launch starts with more leverage.  
>  
> After launch, Jovie shows what is working: which fans converted, which platforms are over-performing, and what follow-up the artist should send next.  
>  
> The result is that an independent artist can run a professional release cycle without stitching together five different tools.

## Final acceptance checklist

The demo is ready when all of these are true:

```md
- [ ] YC cut is under 95 seconds.
- [ ] First screen is product, not homepage.
- [ ] Public artist profile is visible.
- [ ] Pre-save / release page is visible.
- [ ] Backend release command center is visible.
- [ ] Generated launch plan or automated task moment is visible.
- [ ] Same URL before/after launch is obvious.
- [ ] Audience capture is obvious.
- [ ] Analytics insight is obvious.
- [ ] No secrets, private customer data, tokens, internal IDs, or unsupported traction claims.
- [ ] No OAuth, onboarding, pricing, billing, settings, or empty states.
- [ ] No visible loading skeletons longer than ~1 second.
- [ ] No console errors that correspond to broken UI.
- [ ] No 4xx/5xx network errors for visible product surfaces.
- [ ] Text is readable at 1080p.
- [ ] VO matches exactly what is on screen.
- [ ] Investor cut adds backend proof without changing the core story.
```

The practical next move is to create the manifest, seed the demo state, then make the existing Playwright file drive those exact scenes one at a time. Once that first run produces video, traces, and screenshots, every flaw becomes a row in `demo-issues.csv` instead of an ambiguous “the demo feels off” problem.

---

## User

Yeah that's cool. My main concern is you do want manual typing when it comes to, like, I actually need to see someone fill out one of those forms, the OTP, and how it walks you through, because that conversion is one of the core value propositions. If you don't see that conversion then you don't understand it. You need to actually see:
- hit the page
- fire in that input
- walk through the stepwise motion of the OTP and the follow-up questions and stuff
- and then hit the conversion
As long as that's included I'm cool with that.
For AI capability it would be good to show at least one or two things on the release creation and maybe on the, because you want to talk, the automation is the core prop, right, so I never have to create anything. We should be showing some kind of population and stuff, and we want some kind of, maybe, one shot of an empty state detecting something.
Anyway we need to work through this in a good iterative process. I want to see the minimum; give me an MVP of it and then walk through additional so you can break out a plan that works as an MVP and then I can just iterate stepwise through it and break out the workload on this so that we can use maximum parallelization to tackle it as fast as possible because there's not enough time for this to be something that we just babysit in a linear fashion.
Can you give it to me in something that I can run through Air Maze, through our Air Maze setup, and then have it orchestrate at least up until the first review point? Break out the workload in an iterative process up until I need to review it. We'll run that and then I'll come back and talk to you about what the plan is to move forward with the next step of that.

---

## Assistant

Mr. White, I’ll center the MVP on the full conversion flow first, then package it as parallel workstreams with acceptance criteria and orchestrator-ready tasks through the first review checkpoint.

---

## Assistant

Mr. White — agreed. The **typed fan conversion is mandatory**. The MVP demo should make the viewer understand this loop:

**public page → typed fan input → OTP → follow-up questions → conversion → backend audience/event proof → AI automation creates the release workspace.**

I don’t have your repos mounted in this chat, and I could not find any specific public context for “Air Maze,” so the packet below is written as a generic parallel-agent orchestration packet. It assumes Air Maze can run isolated agents against branches/worktrees, which is the standard pattern for modern coding-agent orchestrators. citeturn483991search0turn483991search4

---

# Air Maze execution packet: Jovie YC demo MVP

## Mission

Build the **first reviewable MVP product demo** for Jovie.

The MVP ends at the first human review point with:

```txt
1. A deterministic Playwright demo run.
2. A recorded rough video artifact.
3. Screenshots for each scene.
4. Trace artifacts for debugging.
5. A demo issue ledger.
6. A short review doc explaining what works, what is broken, and what needs polish.
```

Stop after producing the first reviewable artifact. Do not over-polish.

---

# MVP demo scope

## MVP narrative

**Jovie converts a fan on a public artist page, proves that conversion in the backend, then shows AI automation creating and populating the release workflow.**

## MVP scene list

| Scene | Target duration | Surface | Required action |
|---|---:|---|---|
| 1 | 5–8s | Public artist profile | Hit profile page and show upcoming release CTA |
| 2 | 35–45s | Fan conversion flow | Type into input, submit, enter OTP, answer follow-up questions, hit success |
| 3 | 8–12s | Backend audience / conversion event | Show the converted fan or aggregate conversion update |
| 4 | 15–20s | Empty release creation state | Show Jovie detecting missing release setup / blank state |
| 5 | 20–30s | AI release automation | Trigger or reveal AI-populated release plan, copy, tasks, dates, assets |
| 6 | 8–12s | Release command center | Show generated release workspace ready to execute |

Target rough cut: **90–120 seconds**.

The MVP does **not** need every final investor screen. It needs the two highest-leverage claims:

1. **Fan conversion is real and guided.**
2. **Release execution gets automated.**

---

# Required magic moments

## Magic moment 1: Typed fan conversion

This must be visible, not implied.

Required sequence:

```txt
1. Land on artist profile or release page.
2. Click CTA: “Pre-save”, “Join”, “Get notified”, or equivalent.
3. Type email or phone into the form.
4. Submit.
5. OTP step appears.
6. Type deterministic OTP.
7. Follow-up questions appear.
8. Answer at least 2 follow-up questions.
9. Success / conversion confirmation appears.
10. Backend later shows that conversion.
```

Recommended demo values:

```txt
Fan email: demo.fan+jovie@example.com
Phone, if needed: +1 415 555 0198
OTP: 424242
Favorite platform: Spotify
Favorite city / market: Los Angeles
Opt-in: Email + SMS, if both exist
```

Use Playwright’s sequential typing for the visible form input and OTP. `locator.pressSequentially()` is specifically useful when you want individual keypresses rather than instantly filling a field. citeturn185487search8

## Magic moment 2: AI release automation

Required sequence:

```txt
1. Show an empty or incomplete release state.
2. Show Jovie detecting what is missing.
3. Trigger or reveal AI population.
4. Show fields becoming populated:
   - Release title
   - Release date
   - Public page / smart link
   - Launch tasks
   - Campaign copy
   - Fan notification
   - Asset checklist
5. End on the command center with the release ready to execute.
```

This can be mocked or fixture-backed for MVP, but it must look like the real product behavior.

---

# Parallel workstreams

Run these as separate Air Maze agents in isolated branches/worktrees.

## Agent 0 — Coordinator / integrator

**Branch**

```bash
demo/yc-mvp-coordinator
```

**Goal**

Create the demo spec, own integration, and stop the system at the first review point.

**Prompt**

```txt
You are the coordinator for the Jovie YC demo MVP.

Goal:
Produce the first reviewable MVP demo artifact, not the final polished demo.

Read:
- Product repo
- Ops repo
- Fundraising / YC application materials
- Existing Playwright demo files
- Any demo, e2e, seed, fixture, profile, release, pre-save, OTP, audience, analytics, or AI automation code

Create or update:
- docs/fundraising/demo/yc-demo-mvp.md
- docs/fundraising/demo/demo-review-1.md
- scripts/demo/yc-demo-mvp-manifest.json
- demo-artifacts/demo-issues.csv

Do not implement large product changes unless needed to unblock the demo.
Coordinate other branches and produce a final review checklist.

The MVP must include:
1. Public artist/release page
2. Typed fan conversion form
3. OTP step
4. Follow-up questions
5. Conversion success
6. Backend proof of conversion
7. Empty/incomplete release state
8. AI-populated release workflow
9. Playwright rough video, screenshots, and trace artifacts

Stop after first reviewable Playwright run.
```

**Deliverables**

```txt
docs/fundraising/demo/yc-demo-mvp.md
docs/fundraising/demo/demo-review-1.md
scripts/demo/yc-demo-mvp-manifest.json
demo-artifacts/demo-issues.csv
```

---

## Agent 1 — Repo discovery / route map

**Branch**

```bash
demo/yc-mvp-route-map
```

**Goal**

Find the exact existing files, routes, commands, seed systems, Playwright files, and friction points.

**Prompt**

```txt
Inspect the product repo and ops repo.

Find:
- Existing Playwright demo/e2e files
- Public profile routes
- Pre-save / release page routes
- Fan capture forms
- OTP logic
- Follow-up question flow
- Backend audience/conversion views
- Release creation flow
- AI automation / generation features
- Seed scripts / fixtures / mocks
- Existing fundraising or YC application context

Output:
docs/fundraising/demo/repo-route-map.md

Include:
- Exact file paths
- Exact commands to run app/tests
- Current demo/test commands
- Candidate routes for each MVP scene
- Gaps that require implementation
- Any risky areas: auth, OTP providers, network calls, slow loaders, private data
```

**Acceptance criteria**

```txt
- Every MVP scene has a proposed route or identified missing route.
- Existing Playwright file is identified.
- Existing seed/mock mechanism is identified.
- Auth and OTP behavior are documented.
```

---

## Agent 2 — Demo seed and deterministic mode

**Branch**

```bash
demo/yc-mvp-seed
```

**Goal**

Make the demo data deterministic.

**Prompt**

```txt
Implement deterministic demo mode for the YC demo MVP.

Use:
DEMO_MODE=1

Requirements:
- Freeze current date/time for demo surfaces.
- Seed one artist, one upcoming release, one fan, one backend workspace.
- Use deterministic OTP: 424242.
- Disable real SMS/email sending in demo mode.
- Disable random loading copy, onboarding popups, upgrade prompts, and external provider flakiness.
- Hide secrets, internal IDs, customer data, raw tokens, and private emails.
- Add stable selectors for Playwright.

Demo seed:
Artist: Nova Rae
Handle: novarae
Upcoming release: Take Me Over
Release date: 2026-04-24
Fan email: demo.fan+jovie@example.com
OTP: 424242
Audience count before conversion: 2142
Audience count after conversion: 2143
Pre-save count before conversion: 683
Pre-save count after conversion: 684

Create/update:
- scripts/demo/seed-demo.ts or equivalent
- package.json script if appropriate: demo:seed
- docs/fundraising/demo/demo-seed.md

Stable selectors required:
[data-demo-ready='public-profile']
[data-demo-ready='fan-conversion']
[data-demo-ready='otp-step']
[data-demo-ready='followup-questions']
[data-demo-ready='conversion-success']
[data-demo-ready='backend-conversion-proof']
[data-demo-ready='release-empty-state']
[data-demo-ready='ai-release-populated']
[data-demo-ready='release-command-center']
```

**Acceptance criteria**

```txt
DEMO_MODE=1 pnpm demo:seed
DEMO_MODE=1 pnpm dev

The same artist, fan, release, OTP, and backend state appear every run.
No real SMS/email/API side effects occur.
```

---

## Agent 3 — Public profile + fan conversion flow

**Branch**

```bash
demo/yc-mvp-fan-conversion
```

**Goal**

Make the public conversion flow demoable and visually strong.

**Prompt**

```txt
Implement or polish the MVP public fan conversion flow.

Required visual flow:
1. Public artist profile or release page loads directly.
2. CTA is obvious.
3. User types into email or phone input.
4. OTP step appears.
5. User types OTP 424242.
6. Follow-up questions appear.
7. User answers at least two questions.
8. Success state appears.
9. Conversion is persisted or fixture-visible for backend proof.

Use demo mode if needed:
- DEMO_MODE=1
- OTP must be deterministic.
- Avoid real SMS/email sends.
- Avoid CAPTCHA or external auth blockers.
- Avoid long loading states.

Add stable selectors:
[data-demo-ready='public-profile']
[data-demo-ready='fan-conversion']
[data-testid='fan-contact-input']
[data-testid='fan-submit']
[data-demo-ready='otp-step']
[data-testid='otp-input']
[data-testid='otp-submit']
[data-demo-ready='followup-questions']
[data-testid='followup-platform-spotify']
[data-testid='followup-city-los-angeles']
[data-testid='followup-submit']
[data-demo-ready='conversion-success']

Add demo-friendly copy where needed:
- “Get notified when Take Me Over drops”
- “Verify it’s you”
- “Tell Nova Rae where to send updates”
- “You’re on the list”
```

**Acceptance criteria**

```txt
The flow can be completed by Playwright without real external services.
Typing is visibly animated.
OTP step is visible and understandable.
Success state is clear.
Backend can prove the conversion happened.
```

---

## Agent 4 — Backend conversion proof

**Branch**

```bash
demo/yc-mvp-backend-conversion-proof
```

**Goal**

Show that the public fan conversion becomes owned audience data.

**Prompt**

```txt
Implement or polish the backend proof screen for the converted fan.

Required:
- A backend audience or conversion event view.
- It must show the fan conversion from the public flow.
- It must show either the exact demo fan or clear aggregate movement:
  - Audience: 2,142 → 2,143
  - Pre-saves: 683 → 684
  - Source: Take Me Over pre-save
  - Opt-in status
  - Follow-up answers

Stable selector:
[data-demo-ready='backend-conversion-proof']

Possible route:
- Existing audience screen
- Existing campaign analytics screen
- New demo-only wrapper route around existing components

Avoid:
- Raw internal IDs
- Private customer data
- Empty tables
- Confusing admin-only UI
```

**Acceptance criteria**

```txt
After the conversion flow, the backend proof screen clearly shows the conversion.
The screen is readable in 1080p.
No private or production data is visible.
```

---

## Agent 5 — AI release automation scene

**Branch**

```bash
demo/yc-mvp-ai-release-automation
```

**Goal**

Show the automation claim with one empty/incomplete state and one populated state.

**Prompt**

```txt
Implement or polish the AI release automation scene.

Required visual flow:
1. Open release creation or release setup screen.
2. Show an empty/incomplete state:
   - Missing launch plan
   - Missing fan notification
   - Missing campaign copy
   - Missing task schedule
3. Show Jovie detecting the missing setup.
4. Trigger or reveal AI population.
5. Show generated/populated output:
   - Release title: Take Me Over
   - Release date: Apr 24, 2026
   - Launch plan
   - Fan notification copy
   - Campaign tasks
   - Asset checklist
   - Public release page / smart link

Stable selectors:
[data-demo-ready='release-empty-state']
[data-testid='generate-release-plan']
[data-demo-ready='ai-release-populated']
[data-demo-ready='release-command-center']

Demo mode may use deterministic fixtures.
Do not call paid or flaky AI APIs during Playwright demo runs.
If the real AI call exists, preserve it for normal product usage and use fixture output only in DEMO_MODE=1.
```

**Acceptance criteria**

```txt
The viewer understands: “I never have to create all this manually.”
The scene shows before/after automation.
The generated output is specific enough to feel real.
No spinner or AI wait dominates the demo.
```

---

## Agent 6 — Playwright demo runner + video artifacts

**Branch**

```bash
demo/yc-mvp-playwright-runner
```

**Goal**

Create the deterministic Playwright run for the MVP scenes.

**Prompt**

```txt
Build the YC demo MVP Playwright runner.

Use the existing Playwright setup where possible.

Create/update:
- playwright.demo.config.ts
- tests/demo/yc-demo-mvp.spec.ts
- scripts/demo/yc-demo-mvp-manifest.json
- package.json scripts if appropriate:
  - demo:seed
  - demo:run
  - demo:video
  - demo:review

Requirements:
- One deterministic test run.
- Headed mode supported.
- Video recording enabled.
- Trace recording enabled.
- Screenshots saved per scene.
- Explicit waits based on demo-ready selectors.
- Use visible sequential typing for fan input and OTP.
- Use intentional holds only for video pacing.
- Export artifacts under demo-artifacts/.

Use Playwright video recording. Playwright records videos through the config `video` option, and files are written to the test output directory after the browser context closes. citeturn185487search1

Use Playwright traces for debugging. Trace Viewer lets us inspect actions, snapshots, console, and network after the run. citeturn185487search0
```

**Required Playwright flow**

```ts
await page.goto('/demo/novarae');
await expect(page.locator("[data-demo-ready='public-profile']")).toBeVisible();

await page.getByRole('link', { name: /pre-save|get notified|join/i }).click();

const contact = page.getByTestId('fan-contact-input');
await contact.pressSequentially('demo.fan+jovie@example.com', { delay: 45 });
await page.getByTestId('fan-submit').click();

await expect(page.locator("[data-demo-ready='otp-step']")).toBeVisible();

const otp = page.getByTestId('otp-input');
await otp.pressSequentially('424242', { delay: 90 });
await page.getByTestId('otp-submit').click();

await expect(page.locator("[data-demo-ready='followup-questions']")).toBeVisible();

await page.getByTestId('followup-platform-spotify').click();
await page.getByTestId('followup-city-los-angeles').click();
await page.getByTestId('followup-submit').click();

await expect(page.locator("[data-demo-ready='conversion-success']")).toBeVisible();

await page.goto('/demo/backend/conversion-proof');
await expect(page.locator("[data-demo-ready='backend-conversion-proof']")).toBeVisible();

await page.goto('/demo/backend/release-empty');
await expect(page.locator("[data-demo-ready='release-empty-state']")).toBeVisible();

await page.getByTestId('generate-release-plan').click();
await expect(page.locator("[data-demo-ready='ai-release-populated']")).toBeVisible();

await page.goto('/demo/backend/release-command-center');
await expect(page.locator("[data-demo-ready='release-command-center']")).toBeVisible();
```

**Acceptance criteria**

```txt
Command produces:
- demo-artifacts/screenshots/*.png
- demo-artifacts/videos/*.webm or *.mp4
- demo-artifacts/traces/*.zip
- demo-artifacts/demo-issues.csv
- docs/fundraising/demo/demo-review-1.md
```

---

## Agent 7 — QA / demo issue ledger

**Branch**

```bash
demo/yc-mvp-qa-ledger
```

**Goal**

Run the demo, identify blockers, and produce the first review ledger.

**Prompt**

```txt
Run the YC demo MVP and create the review ledger.

Check:
- Does every scene load?
- Does the typed conversion look clear?
- Does OTP appear and resolve?
- Do follow-up questions appear?
- Does success state appear?
- Does backend prove the conversion?
- Does AI automation have a clear empty → populated moment?
- Are there slow loaders?
- Are there console errors?
- Are there 4xx/5xx network errors?
- Is any private data visible?
- Is any copy confusing?
- Is anything unreadable at 1080p?

Create/update:
demo-artifacts/demo-issues.csv
docs/fundraising/demo/demo-review-1.md

Issue ledger columns:
scene_id,timestamp,priority,type,issue,fix_owner,suggested_fix,status

Priorities:
A = blocks first review / breaks narrative / privacy risk / flow fails
B = should fix before final video
C = polish
```

**Acceptance criteria**

```txt
The review doc tells Tim exactly:
1. What works
2. What is broken
3. Which issues block final video
4. Which issues can wait
5. Which branch owns each fix
```

---

# Shared manifest for all agents

Create this as:

```txt
scripts/demo/yc-demo-mvp-manifest.json
```

```json
{
  "demo": "jovie-yc-demo-mvp",
  "target_duration_seconds": 110,
  "seed": {
    "artist": "Nova Rae",
    "handle": "novarae",
    "upcoming_release": "Take Me Over",
    "release_date": "2026-04-24",
    "fan_email": "demo.fan+jovie@example.com",
    "otp": "424242",
    "audience_before": 2142,
    "audience_after": 2143,
    "presaves_before": 683,
    "presaves_after": 684
  },
  "scenes": [
    {
      "id": "01-public-profile",
      "route": "/demo/novarae",
      "ready_selector": "[data-demo-ready='public-profile']",
      "target_seconds": 7,
      "must_show": [
        "Nova Rae",
        "Take Me Over",
        "Get notified"
      ]
    },
    {
      "id": "02-fan-conversion",
      "route": "/demo/novarae/take-me-over",
      "ready_selector": "[data-demo-ready='fan-conversion']",
      "target_seconds": 45,
      "must_show": [
        "typed email or phone",
        "OTP",
        "follow-up questions",
        "success"
      ]
    },
    {
      "id": "03-backend-conversion-proof",
      "route": "/demo/backend/conversion-proof",
      "ready_selector": "[data-demo-ready='backend-conversion-proof']",
      "target_seconds": 12,
      "must_show": [
        "demo fan",
        "Take Me Over",
        "pre-save",
        "owned audience"
      ]
    },
    {
      "id": "04-release-empty-state",
      "route": "/demo/backend/release-empty",
      "ready_selector": "[data-demo-ready='release-empty-state']",
      "target_seconds": 15,
      "must_show": [
        "missing launch plan",
        "missing campaign copy",
        "missing fan notification"
      ]
    },
    {
      "id": "05-ai-release-populated",
      "route": "/demo/backend/release-ai",
      "ready_selector": "[data-demo-ready='ai-release-populated']",
      "target_seconds": 25,
      "must_show": [
        "generated launch plan",
        "generated copy",
        "scheduled tasks",
        "fan notification"
      ]
    },
    {
      "id": "06-release-command-center",
      "route": "/demo/backend/release-command-center",
      "ready_selector": "[data-demo-ready='release-command-center']",
      "target_seconds": 10,
      "must_show": [
        "Take Me Over",
        "Apr 24, 2026",
        "ready to launch"
      ]
    }
  ]
}
```

---

# Integration sequence

Run this in Air Maze as the dependency order.

## Phase 1 — Discovery and spec

Run in parallel:

```txt
Agent 0 — Coordinator
Agent 1 — Repo discovery / route map
```

Expected output:

```txt
docs/fundraising/demo/repo-route-map.md
docs/fundraising/demo/yc-demo-mvp.md
scripts/demo/yc-demo-mvp-manifest.json
```

## Phase 2 — Parallel implementation

Start after route map exists.

Run in parallel:

```txt
Agent 2 — Demo seed and deterministic mode
Agent 3 — Public profile + fan conversion flow
Agent 4 — Backend conversion proof
Agent 5 — AI release automation scene
Agent 6 — Playwright demo runner
```

Rules:

```txt
- Each agent uses its own branch/worktree.
- Do not rename shared routes without updating the manifest.
- Do not hardcode production data.
- Do not make real SMS/email/AI calls in DEMO_MODE=1.
- Add selectors rather than relying on brittle text when possible.
- Preserve normal product behavior outside DEMO_MODE=1.
```

## Phase 3 — Integration

Run:

```txt
Agent 0 — Coordinator / integrator
Agent 7 — QA / demo issue ledger
```

Integrator merges the minimum set of changes needed to produce the first reviewable run.

Stop at first review.

---

# Recommended package scripts

Agents should add these only if they fit your repo conventions.

```json
{
  "scripts": {
    "demo:seed": "DEMO_MODE=1 tsx scripts/demo/seed-demo.ts",
    "demo:run": "DEMO_MODE=1 playwright test -c playwright.demo.config.ts --project=demo-desktop",
    "demo:run:headed": "DEMO_MODE=1 playwright test -c playwright.demo.config.ts --project=demo-desktop --headed",
    "demo:review": "npx playwright show-report demo-artifacts/playwright-report"
  }
}
```

---

# First review command sequence

The final integrated branch should support this sequence:

```bash
git checkout demo/yc-mvp-integrated

pnpm install

DEMO_MODE=1 pnpm demo:seed

DEMO_MODE=1 pnpm dev
```

In another terminal:

```bash
DEMO_MODE=1 pnpm demo:run:headed
```

Then:

```bash
find demo-artifacts test-results -iname '*.png' -o -iname '*.webm' -o -iname '*.mp4' -o -iname '*.zip' | sort
```

Open the Playwright report:

```bash
pnpm demo:review
```

Open trace manually if needed:

```bash
npx playwright show-trace path/to/trace.zip
```

---

# MVP acceptance checklist

The first review artifact is acceptable when:

```txt
[ ] Public artist/release page loads directly.
[ ] Fan input is visibly typed.
[ ] OTP step appears.
[ ] OTP 424242 is visibly typed.
[ ] Follow-up questions appear.
[ ] At least two follow-up questions are answered.
[ ] Conversion success state appears.
[ ] Backend shows the conversion or updated aggregate.
[ ] Empty/incomplete release state is visible.
[ ] AI automation populates release plan/copy/tasks.
[ ] Final command center looks ready to execute.
[ ] Screenshots exist for all scenes.
[ ] Video artifact exists.
[ ] Trace artifact exists.
[ ] demo-issues.csv exists.
[ ] No real SMS/email/AI call is required in demo mode.
[ ] No private data or secrets are visible.
```

---

# What to defer until after first review

Keep these out of the MVP unless they are already easy:

```txt
- Full investor cut
- Full analytics deep dive
- Multi-release compounding story
- Polished VO
- Resolve edit
- Animated zooms
- Final music/sound design
- Visual regression baselines
- Admin/backend internals beyond one clean proof screen
- Every possible public profile variant
```

---

# Post-review iteration plan

After you review the first artifact, the next work should split into three tracks:

| Track | Goal |
|---|---|
| Conversion polish | Make OTP/follow-up/success feel like the core magic moment |
| Automation polish | Make empty → AI-populated release workflow undeniable |
| Video polish | Tighten timing, add VO, remove waits, export final YC and investor cuts |

The MVP should answer only one question:

**“Can we run one deterministic demo that visibly converts a fan and visibly automates release execution?”**
