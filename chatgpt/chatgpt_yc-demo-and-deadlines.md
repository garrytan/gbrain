---
title: "YC Demo and Deadlines"
type: guide
created: 2026-05-09
updated: 2026-05-09
source: chatgpt-export
conversation_id: 69fe7910-772c-83e8-bc66-1e7d5d393e49
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# YC Demo and Deadlines

> Conversation ID: 69fe7910-772c-83e8-bc66-1e7d5d393e49
> Created: 2026-05-09T00:00:16Z
> Updated: 2026-05-09T00:05:30Z
> Messages: 4

---

## User

OK, so a couple of things that we should break down into issues and tackle is like YC demo has to go in that one we’ve been holding on for a while and we keep waiting to polish demo for it. I would literally just spin up a shitty I would like wait until wait until the cleanup that we just scheduled lands for the public artist profiles just because that DJane is significant but once that lands, I would just fire up a playwright video recording that video demo. I do the thing and I would just submit the application right now and not wait for perfection on it. I have a feeling that wait like it’s already four or five days past deadline waiting at all now, I think it’s just gonna be a recipe for it’s not worth it and we should be focusing on just getting that in like hard that should be in by tomorrow night submitted it done and then if it’s not, it has to be like that and that I would move on from NYC and Circle back with YC in like 30 days or something like we can update it and we can like you know work on an updated application later or something but otherwise we should move on to speed run, which is probably a better fit and is also we’re like nine days away from the deadline on it so I’d get the IC went out of the fucking way so we can move on and then focus on a 16 Z so that being said we basically have between now it’s May 8 and we have we are between now and what would it be it would be it would be it would be May 17 right yeah so May 17 is when it’s gonna win the deadline is so basically we should then focus on OK do we? How do we get a demo video good for May 17 and actually demo something and I think what it should and I don’t particularly know what it should demo or what it should not demo, but that should be a focus is polishing that demo and then we gotta get fucking users using this so I guess fuck I guess like check everything that’s in flight for PR‘s and check everything that’s happening in Linear and help me like give me give me like the plan here for what I should orchestrate and I’ll hit all this off to my chief of staff Wright and like agents are moving along now and stuff, but I’ll handle all over the Chief of Staff but basically like what needs to happen. It should be you know I’d imagine it’s like some go to market stuff. I guess it’s hardening. I guess we need Golden path tests running and I think what I would probably say is that the next 24 hours my value is probably most spent on design iterating through design for the homepage and stuff right I mean, that would be my guess and then probably the next most important thing would be I read through design on the homepage and agents work on pushing through everything else and then I think for like the demo and stuff and then I think that it would be because like hardening becomes like an important thing. I think we should figure out if we can get there . Are there free models that are good enough to run QA would be my question because if we can run if we can run a nightly QA run or something I guess we already do that and see with tests and stuff and tests are free to run. That is a good point so I don’t know I guess like what Crohn’s do we have what CI do we have that does hardening and stuff and then just like catching more testing regression and stuff and then I guess like some of the things that we haven’t been catching lately scroll Janice still seems to be getting through like on the public profiles. The music page is supposed to just look like a native iOS app or you can just scroll through and for some reason it’s still Janky with like weird horizontal trolling stuff. It doesn’t feel natural that’s one that I’ve had trouble with across the board with Test not catching so you wanna catch that we push something they catch conflict markers inside of code that were causing belts to fail and weren’t getting caught for some reason so we pushed that but like are there other things adjacent to that that we should add and I would generally just like to look at like over the last 2448 hours what have been the biggest failures and what have we gotten wrong and how can we harden that testing and stuff ? Yeah just like I want to spend less time on dealing with regressions and so I wanna audit and see if there’s anything that should just generally be hardened like right now or if there’s anything that like where like there’s not enough coverage or something we just have to avoid that . 

---

## Assistant

Mr. White, I’ll inspect GitHub, Linear, recent failures, and accelerator deadlines, then convert the current state into a Chief-of-Staff handoff with owners, dates, and hardening priorities.

---

## Assistant

I found `JovieInc/Jovie` as the active product repo, with meaningful open PRs #7986, #8329, #8330, and #8331. YC is late but still acceptable; Speedrun’s deadline is May 17, 2026.

---

## Assistant

Mr. White, my read: **submit YC by tomorrow night with an imperfect demo, then move the main push to Speedrun.** YC’s on-time S26 deadline was **May 4, 2026 at 8:00 PM PT**, and YC says late applications are still considered, but without the same response timeline. Speedrun SR007 closes **May 17, 2026 at 11:59 PM PT**, which makes that the real hard clock. citeturn359851search0 citeturn528853search0turn528853search1

## Priority decision

**P0: YC late submission, done by May 10 night.**  
Stop waiting for the ideal demo. Once the public artist profile cleanup lands, record the shortest acceptable Playwright demo: public profile → music/listen surface → fan alert or demand CTA → claim/onboarding or admin Ops proof. Submit, then use YC updates later.

**P0: Speedrun demo pack, May 17 hard deadline.**  
The Speedrun demo should be higher quality than YC. The demo should show one wedge clearly: Jovie turns public artist profiles and fan demand into activation infrastructure. The product story should be: artist profile looks credible, fans can take action, artist can claim/activate, Jovie compounds into GTM data.

**Your next 24h should be mostly design and narrative, not regression chasing.**  
Your highest-value work is homepage/demo polish, founder video, final application facts, and judging whether the demo feels investable. Agents and Chief of Staff should own PR triage, hardening, and QA lanes.

## PR audit: what to do now

| PR | Decision | Reason |
|---|---:|---|
| **#8331 — AgentOS admin bot review fixes** | **Merge after quick human glance** | Small follow-up, mergeable, non-draft, 1 commit, 6 files, and explicitly addresses CodeRabbit, Greptile, and Sentry review findings with typecheck, focused Vitest, git diff check, and pre-push evidence. fileciteturn5file0 |
| **#8329 — HUD shipping velocity chart** | **Clear CodeRabbit pending, then merge if clean** | Useful for Ops visibility and Speedrun/YC “we ship fast” narrative. It is mergeable and focused on `/app/admin/ops`, but CodeRabbit was still pending in the status scan. fileciteturn4file0 |
| **#8330 — AgentRunArtifact panel draft** | **Close or mark superseded** | Draft, unmergeable, 15 files, 1,234 additions. It appears superseded by the already-landed/near-landed AgentOS panel work plus #8331’s focused fix. fileciteturn6file0 |
| **#7986 — waitlist chat access gate** | **Do not rush before YC unless required for the demo** | It is mergeable and heavily tested, but it touches onboarding, access gating, waitlist flow, CTAs, and visit-token behavior across 41 files. That is launch-useful but demo-risky. fileciteturn7file0 |

## Linear audit: the main problem

The current cycle is overloaded. There are too many active threads: YC, Speedrun, GTM, AgentOS, Design V1, reliability, HUD, finance ops, and many Cursor-created error issues. That creates founder attention fragmentation.

For the next 9 days, collapse everything into four lanes:

1. **Accelerators:** YC late submission, Speedrun application, founder video, product demo.
2. **Demo-critical product:** homepage, public artist profiles, music/listen scroll, claim/alert flow.
3. **GTM:** 20-artist manual activation sprint, outreach drafts, lead tracker, claim links.
4. **Hardening:** golden-path canaries, horizontal overflow tests, conflict-marker CI, nightly deterministic QA.

Everything else gets parked unless it directly supports one of those four.

## What to freeze

Park these until YC is submitted and Speedrun demo script is locked:

- AgentOS roadmap parser / issue brief generator / Linear app-user identity unless needed for orchestration this week.
- Creative Agent System, Design Lab, Visual QA/Pixel Diff as standalone productized systems.
- Design V1 long-tail issues like right rail parity, drawer flattening, release audio parity, CTA sweeps.
- Electron/dependency PRs and non-demo desktop polish.
- Email signature generator and secondary dashboard enhancements.

Keep only AgentOS work that helps the **Ops HUD, approval queue, or QA reporting**.

## Hardening plan for the failures you called out

**1. Public profile / music page scroll jank**

Add a Playwright detector specifically for the public profile music/listen path. Current scroll coverage is not enough.

Routes to cover:

- DJane public profile after cleanup.
- `/dualipa`
- `/dualipa?mode=listen`
- One internal seeded profile with releases.
- One empty/edge profile.

Assertions:

```ts
expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
  await page.evaluate(() => document.documentElement.clientWidth + 1)
);
```

Also assert:

- No horizontal overflow at 390×844, 430×932, 768×1024, and desktop.
- Vertical touch-like scroll works naturally on the intended scroll container.
- No horizontal wheel/trackpad drift.
- Music/listen page keeps native iOS-like vertical scroll behavior.
- Trace/video artifact is saved on failure.

This should become a **demo-blocking canary**, not a generic visual test.

**2. Conflict markers**

The pre-commit hook hardening is directionally right, but it should also run in CI before build/install work. Add a full-tree fail-fast lane:

```bash
git grep -nE '^(<<<<<<<|=======|>>>>>>>)' -- ':!*.md' ':!pnpm-lock.yaml'
git diff --check
```

Run it early in CI, not only in Husky. Local hooks are useful, but CI is the source of truth when agents push from different environments.

**3. Golden path tests**

Create a minimal “application demo gate” that must pass before recording:

- Homepage loads with no console errors and no horizontal overflow.
- Public profile loads.
- Music/listen tab scrolls vertically.
- Alert/demand CTA works or reaches expected gated state.
- Claim/onboarding path reaches expected next step.
- `/app/admin/ops` loads for admin.
- Auth/signup/onboarding smoke passes on preview.

This is cheaper and more useful than broad exhaustive QA right now.

**4. Nightly QA and free models**

Use free models only for **summarizing failures, ranking risk, and drafting Linear follow-ups**. Do not use an LLM as the pass/fail oracle.

Pass/fail should stay deterministic:

- Playwright.
- Vitest.
- Axe.
- Route QA.
- `git diff --check`.
- conflict-marker grep.
- Stryker hotspot lane where already wired.
- Preview deploy smoke.

The nightly agent should emit: failed route, screenshot/video/trace, suspected owner, linked PR, linked Linear issue, and “detector added?” status.

**5. Jank monitoring**

The `chat_jank_monitor` failure mode was a flag-registration failure: the monitor existed, but did not actually route through Statsig. The fix is not only “enable the gate”; the guardrail is “every app flag must be Statsig-mapped or explicitly exempt.” Keep the new guardrail and turn the gate on at 10–20% only after verifying one real event path.

## Chief of Staff handoff

Paste this as the operating plan:

**Objective through May 10 night:** YC submitted, even if imperfect.  
**Objective through May 17:** Speedrun submitted with a stronger demo, clearer GTM traction, and no embarrassing regressions.

**P0 — YC late submission**

- Owner: Tim final; Chief drafts/checks.
- Due: May 10 night.
- Acceptance: application submitted, confirmation captured, founder video uploaded, product demo uploaded, facts checked against current truth.

**P0 — Product demo**

- Owner: Chief coordinates; agents prep; Tim records.
- Due YC: May 10 night.
- Due Speedrun: final by May 17 noon.
- Acceptance: 60–120 second demo showing public artist profile, music/listen surface, fan demand/alert CTA, claim/onboarding or admin proof. No visible scroll jank.

**P0 — PR triage**

- Merge #8331 after human glance.
- Resolve CodeRabbit on #8329, then merge if clean.
- Close/supersede #8330.
- Hold #7986 unless demo requires controlled access.
- No large risky PRs after May 17 noon unless they fix a demo blocker.

**P0 — QA gate**

- Add public profile/music horizontal overflow detector.
- Add full-tree conflict-marker CI check.
- Run demo gate on preview before any recording.
- Save Playwright videos/traces for demo-critical surfaces.

**P0 — GTM**

- Start 20-artist activation sprint.
- Tracker fields: artist, why now, profile URL, contact route, claim link, outreach status, response, activation result.
- First batch can be manual. Automation comes after signal.

**P1 — Speedrun application**

- Draft narrative around: Jovie is artist infrastructure, starting with public profiles and fan-demand activation.
- Include traction honestly: users, leads, PR velocity, reliability improvements, demo progress.
- Final lock: May 17 noon; submit before 11:59 PM PT.

## Your next 24h

Your time should go here:

1. **Homepage/demo design pass.** Make the first screen and public profile flow feel credible enough for investors.
2. **Founder video.** Record a direct one-minute version. No product demo inside that video.
3. **Demo script.** Decide the exact 4–5 clicks the Playwright recording will show.
4. **Application facts.** Ensure cash, runway, users, revenue, deadline status, and demo state are accurate.
5. **Final visual judgment.** You approve whether the public profile/music page is acceptable for recording.

Delegate regression work. You should only inspect the final artifacts and make the product/design call.


## See Also
- [[chatgpt/chatgpt_auto-tune-settings-demo-vocals]]
- [[chatgpt/chatgpt_branch-cinematic-demo-script]]
- [[chatgpt/chatgpt_branch-demo-dashboard-analysis-part1]]
- [[chatgpt/chatgpt_branch-demo-dashboard-analysis-part2]]
- [[chatgpt/chatgpt_branch-demo-dashboard-analysis-part3]]
