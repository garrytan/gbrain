---
title: "YC Demo Plan"
type: note
created: 2026-04-10
updated: 2026-04-10
source: chatgpt-export
conversation_id: 69d8b398-3e1c-83e8-bbda-56ce90f6aff9
message_count: 5
tags: [chatgpt, import, long-form]
---
# YC Demo Plan

> Conversation ID: 69d8b398-3e1c-83e8-bbda-56ce90f6aff9
> Created: 2026-04-10T08:23:53Z
> Updated: 2026-04-10T18:38:20Z
> Messages: 5

---

## User

Figure out based on our repo and yc application and general direcitona nd product what should be shown in our product demo for ycombinator. the goal is to make the best demo taht will get us in. we need exact shots/features to show off and what data to seed it with and how best to stack/order the features and how open and end and whether or not to include auth/homeapage etc or public profiles etc. if we should do comp shots with 4 phones to show all modes at once, or just demo them. if screenrecording of obile is good or bad etc. give us the full plan. right now we have playwright recording that covers some routes but we want to nail this.

---

## Assistant

I’m reviewing the repo and YC application materials to build a concrete demo plan with exact screens, order, seeded data, and recording/edit guidance; if there are multiple branches or app variants, I’ll use the most current one.

---

## Assistant

I’ve pinned down the strongest arc: one artist release moving from pre-save to launch to fan conversion. I’m mapping that to the real public routes and authenticated dashboard flows now.

---

## Assistant

I found a legacy-code mismatch, so I’m biasing the plan toward your current release wedge and excluding stubbed or CRM-era screens. I also found a no-signup demo path plus handle-claim/artist-selection routes worth using.

---

## Assistant

Mr. White,

I couldn’t inspect the repo or the YC application text in this session, so this is based on your live site plus the fact that you already have a scriptable demo flow. Publicly, Jovie currently reads as a release system for independent artists: a mobile artist profile that can switch among growth, tickets, tips, and streams; release destinations that turn a pre-save countdown into a live DSP page; and a command center that generates a release plan, tracks tasks, and notifies fans. Your pricing and privacy pages also point to Spotify auto-sync, public artist pages, audience capture, release notifications, fan CRM, analytics/geographic insights, and optional AI assistant/insights. citeturn680429view0turn686041view1turn686041view0

Feature.fm, Linkfire, and Linktree already market bio links, release links, pre-saves, tour/event links, fan capture, and analytics. My inference is that a demo led by “we have smart links and pre-saves” will feel incremental. The differentiated layer is the workflow: plan the release, ship it, capture the fan, notify them, learn what converts, and make the next release stronger. citeturn951027view0turn951027view1turn951027view3

YC’s own guidance points the same way. They want the first sentence to be clear and matter-of-fact, they treat the founder video as a separate 1-minute founders-only video, and they want a working demo ready to screenshare if you interview. They also say that if you state numbers, they may ask you to verify them. citeturn914009view0turn400621view0turn505419view1

## What the demo should prove

One sentence should anchor the whole cut:

**“Jovie runs an independent artist’s release from fan capture to launch in one system.”**

If your YC application uses a narrower phrase than that, use the application wording instead. The application sentence wins. The first 5 seconds of the demo should visually match that sentence. citeturn914009view0

Make one **80–90 second** application demo and a separate **2-minute live version** for interview screenshare. Same story, same seeded data, same order.

## Exact cut to submit

1. **0:00–0:07 — Open on the fan-facing mobile profile.**  
   Show one artist and one release. Use a clean mobile page with the upcoming single, one show date, and one clear CTA. Tap **Subscribe** once, then flick the mode once so the reviewer understands that the same page can switch among growth / tickets / tips / streams. This gives instant comprehension and anchors the fan-facing surface. citeturn680429view0turn686041view1

2. **0:07–0:15 — Same phone, same release, pre-launch state.**  
   Show the release page in **countdown / pre-save** mode. One tap on pre-save. No scrolling. No extra pages. The reviewer now understands what the fan gets. citeturn680429view0turn686041view1

3. **0:15–0:30 — Cut to desktop command center.**  
   The release brief is already loaded. Click **Generate Release Plan**. Reveal auto-created tasks with useful labels like **Metadata verified**, **Upload Canvas to Spotify**, **Pitch to editorial playlists**, **Fan email queued**. This is the centerpiece. Spend the most time here. citeturn680429view0

4. **0:30–0:42 — Show execution, not more navigation.**  
   Open one task drawer or release detail pane. Trigger one toast or status update like **launch email scheduled in 3 timezones**. If your Spotify import is genuinely beautiful, this is the only place I would allow a 1-second import/autofill moment. citeturn680429view0turn686041view0

5. **0:42–0:52 — Hard cut to the same public URL after launch.**  
   The countdown is gone. The page is now live with Spotify / Apple Music / YouTube buttons. This proves the system ships the release; it is not just a planning tool. citeturn680429view0turn686041view1

6. **0:52–1:05 — Audience and release notifications.**  
   Show the captured fan list and one useful segment. Example: **2,143 fans captured**, **684 pre-saves**, segment = **Pre-saved but hasn’t clicked the live link yet**. Show the launch email or follow-up queue once. This demonstrates owned audience and repeatability. citeturn686041view1turn686041view0

7. **1:05–1:18 — Analytics and one insight.**  
   Show top cities, top DSPs, and one AI-powered recommendation card. Example: **Berlin over-indexes on Apple Music; move Apple to slot one for EU traffic.** Use one crisp insight. Do not show a long chat session. citeturn686041view1turn686041view0

8. **1:18–1:25 — End on compounding.**  
   Show a tiny history of three releases or an audience-growth chart: **412 → 986 → 2,143 contacts**. End on the line: **“Every release grows the next one.”** That lands the business logic and the wedge. citeturn680429view0

## Seed the demo with one believable story

Use **one artist, one upcoming release, one live release, one audience segment, one insight**.

Use data like this:

- Artist: one real artist you have permission to show, or one fictional-but-plausible artist.
- Upcoming single: **Take Me Over**, release date **Friday, April 24, 2026**.
- One show date: **Academy LA, Los Angeles, April 25**.
- Tasks: metadata verified, Canvas upload, editorial pitch, fan email queued, post-launch follow-up scheduled.
- Audience: **2,143 contacts**, **684 pre-saves**.
- Email result: **61% open**, **24% click**.
- DSP split: **Spotify 49% / Apple 27% / YouTube 13% / other 11%**.
- Top cities: **Los Angeles 22% / Berlin 9% / Mexico City 8% / London 6%**.
- Insight: **Apple Music over-performs in Berlin; reorder DSP buttons for EU traffic**.

Use real internal numbers if you have them. If any of the on-screen numbers are seeded demo data, say so in the application notes. YC explicitly says they may ask you to verify metrics. citeturn505419view1

## What to include and what to cut

Include:
- public profile
- public release page in both pre-launch and live states
- command center
- generated plan + task statuses
- audience / notifications
- analytics / one insight

Skip:
- homepage
- pricing
- settings
- billing
- team management
- API / webhooks
- long profile editing
- long AI chat typing
- any manual data entry that takes more than 2 seconds

Auth gets **one exception**: include a 1–2 second Spotify-connect moment only if it instantly imports the artist and makes the magic obvious. Otherwise start already signed in. Jovie’s public docs make clear that Google/Spotify sign-in and Spotify metadata sync exist, but those are setup, not the product story. citeturn686041view0

Public profiles should be in the demo. The homepage should not. The profile is the fastest way for a reviewer to understand who the user is and what the fan sees. The homepage is marketing. YC wants clarity fast. citeturn914009view0

## 4-phone comp shots and mobile recording

Use **one desktop capture + one clean phone frame** as the main visual language.

A **4-phone comp** is acceptable as a **1-second insert** after the reviewer already understands the profile. It is not a good primary format. It makes the cut feel like ad creative instead of proof.

**Mobile screen recording is good** when it is:
- simulator/browser-device capture
- sharp
- steady
- readable
- one tap, maybe one short scroll

It is bad when it is:
- handheld camera footage of a physical phone
- shaky
- reflective
- full of phone chrome / notifications
- edited like a commercial

For YC, crisp screen capture beats cinematic device footage.

## How to use Playwright

Keep Playwright. Change how you use it.

Use it to drive **6 short deterministic scenes**, not one long route crawl.

Build or tighten a YC-specific demo state like:

- `/demo?scene=profile`
- `/demo?scene=presave`
- `/demo?scene=plan`
- `/demo?scene=launch`
- `/demo?scene=audience`
- `/demo?scene=insight`

Then:

- freeze time for **T-7 days**, **launch day**, and **T+1 day**
- seed mock data shaped like production data
- reuse real production components
- pre-open drawers / tabs where useful
- remove dead time, spinners, and cursor travel
- record each scene separately
- cut them together with founder voiceover and captions
- no background music

That gives you a product demo that also becomes your live interview backup, which matches YC’s advice to have a working version ready to screenshare. citeturn505419view1

## Two things to fix before you send it

1. **Align the product sentence everywhere.**  
   Your site currently says “the release system for independent artists.” Your demo opener, application first sentence, and live interview answer should all use the same noun phrase. YC explicitly rewards clarity and matter-of-fact framing. citeturn680429view0turn914009view0

2. **Fix the pricing / legal mismatch on the public site.**  
   Your pricing page shows **Free** and **Pro at $20/month**, while the Terms still say **Jovie is currently free for all creators** and paid upgrades are future products. A reviewer who clicks around can notice that instantly. citeturn686041view1turn662017view0

The version I would actually submit is:

**mobile profile → pre-save page → command center generate plan → tasks auto-filled → same URL live after launch → audience segment → geo insight → compounding chart**

That is the clearest story, the strongest proof, and the best use of the product surface you publicly show today.


## See Also
- [[chatgpt/chatgpt_10k-mrr-plan]]
- [[chatgpt/chatgpt_ai-coding-plan-comparison]]
- [[chatgpt/chatgpt_ai-lead-plan-for-linktree]]
- [[chatgpt/chatgpt_ai-plan-for-ios-refactor]]
- [[chatgpt/chatgpt_ai-task-automation-plan]]
