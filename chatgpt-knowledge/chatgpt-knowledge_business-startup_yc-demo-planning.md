---
title: "YC Demo Planning"
type: guide
created: 2026-04-21
updated: 2026-04-21
source: chatgpt-export
topic: business-startup
message_count: 7
tags: [chatgpt, knowledge, business-startup]
---
**Topic:** [[chatgpt-knowledge/_topics/business-startup]]

# YC Demo Planning

> **Source:** ChatGPT conversation
> **Date:** 2026-04-21T20:20:23Z
> **Messages:** 7
> **Topic:** business-startup

## Question

I need to report a product demo for YC but also for Endresim and all that. We have a Playwright file in the repo that runs through and does have a demo. There's some context in the ops repo under fundraising but I'm happy to do it as a Loom and narrate it. I have the Playwright just so that I can have an automated way of confirming that all the screens look good and stuff.

I want to work the codebase and the ops repo and everything that we talk about in the YC application. I want to compile everything together into what would be the ideal demo as step one. What are the screens you want to show? How do we keep it concise while still showing all the magic moments and stuff? Work backwards from that to run the Playwright one time and have it actually deal with all of those screens so I can watch it live or have it export a video and then watch that video and make sure all the screens look good. Then I can systematically tackle each one of those issues.

Once that's done I can reproduce i

## Answer

I’ll work backwards from the application/demo goal, then turn that into a concrete demo script and Playwright/video pipeline. I’ll also verify current YC demo expectations rather than relying on memory.

## Answer

I found the strongest product-demo narrative in the prior Jovie materials: one artist moving from fan capture through pre-save, release ops, launch, and audience analytics into compounding growth.

## Answer

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

Use seeded demo numbers only 

*(Answer truncated — 20176 chars total)*

## Question

Yeah that's cool. My main concern is you do want manual typing when it comes to, like, I actually need to see someone fill out one of those forms, the OTP, and how it walks you through, because that conversion is one of the core value propositions. If you don't see that conversion then you don't understand it. You need to actually see:
- hit the page
- fire in that input
- walk through the stepwise motion of the OTP and the follow-up questions and stuff
- and then hit the conversion
As long as that's included I'm cool with that.
For AI capability it would be good to show at least one or two things on the release creation and maybe on the, because you want to talk, the automation is the core prop, right, so I never have to create anything. We should be showing some kind of population and stuff, and we want some kind of, maybe, one shot of an empty state detecting something.
Anyway we need to work through this in a good iterative process. I want to see the minimum; give me an MVP of it a

## Answer

Mr. White, I’ll center the MVP on the full conversion flow first, then package it as parallel workstreams with acceptance criteria and orchestrator-ready tasks through the first review checkpoint.

## Answer

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
Opt-in: Email +

*(Answer truncated — 22756 chars total)*
