---
conversation_id: 6a13ae33-59c4-83e8-be9e-b6e5ec8ac17e
created: 2026-05-25
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: iOS performance and Gmail
type: guide
updated: 2026-05-25
---

# iOS performance and Gmail

**Related:** [[coding_mobile]]

> Conversation ID: 6a13ae33-59c4-83e8-be9e-b6e5ec8ac17e
> Created: 2026-05-25T02:04:35Z
> Updated: 2026-05-25T02:09:21Z
> Messages: 6

---

## User

explain ios perfoamnce. can i /perf-loop it with 100ms gmail rule?

---

## Assistant

I’ll clarify the ambiguous terms, then separate iOS app responsiveness from Gmail/backend automation latency to judge whether a 100 ms `/perf-loop` target is realistic.

---

## User

100ms ericeng latency the gmail test

---

## User

paul briehegiht

---

## Assistant

I found the 100ms Gmail rule as Paul Buchheit’s perceived-instant interaction heuristic. For iOS, I’ll treat it as an action-response budget, separate from tighter frame-rendering budgets.

---

## Assistant

Mr. White, yes: you can **/perf-loop iOS performance using the 100ms Gmail rule**, with one caveat.

## What you meant

The “100ms Gmail rule” is usually attributed to **Paul Buchheit**, Gmail’s creator: interactions under roughly **100ms** feel instantaneous. I found no credible “Eric Eng” attribution for that rule; the common attribution is Buchheit. citeturn649896search5turn649896search12

Apple’s iOS guidance lines up with this: Apple says discrete UI delays start becoming noticeable around **50–100ms**, and main-thread work longer than **100ms** risks feeling like a hang. citeturn892567search5turn892567search3

## The right iOS interpretation

Use **100ms as the tap-to-feedback budget**, not the full operation budget.

Example:

| Action | 100ms target should cover | Can exceed 100ms? |
|---|---:|---:|
| Tap button | pressed state, spinner, optimistic UI, screen transition start | Backend/network completion |
| Open thread | immediate nav/placeholder/skeleton | Message fetch/render |
| Send action | local “sent/sending” state | Server confirmation |
| Search | input echo + debounce feedback | Full results |

For iOS, also respect the frame budget:

| Display | Frame budget |
|---|---:|
| 60Hz | ~16.7ms/frame |
| 120Hz ProMotion | ~8.3ms/frame |

So the deeper rule is:

> **No main-thread blocking. First meaningful feedback under 100ms. Smooth frames during the transition.**

## How to `/perf-loop` it

Define a repeatable loop around the user action:

1. **Pick one path**
   - Example: `tap inbox item → thread screen first meaningful paint`
   - Or: `tap composer send → sending state appears`

2. **Set measurement boundaries**
   - Start: user tap event received.
   - End: first meaningful UI feedback appears.
   - Separate metric: full data loaded.

3. **Track p95/p99, not average**
   - Pass condition: `p95 tap-to-feedback < 100ms`
   - Better: `p99 < 150ms`
   - Fail any main-thread stall over 100ms.

4. **Run on real devices**
   - Release build.
   - Same device class.
   - Warm and cold states.
   - Good network and bad network.
   - Low Power Mode separately.

5. **Profile with Apple tools**
   - Instruments: Time Profiler, Hitches, Hangs.
   - XCTest performance tests for repeatability.
   - Xcode Organizer / MetricKit for field data. Apple specifically recommends Instruments templates like Time Profiler, CPU Profiler, and Hitches for responsiveness work. citeturn892567search0turn892567search1

## Practical pass/fail budget

Use this:

```text
Tap → first visible response:      < 100ms p95
Main-thread continuous work:       < 50ms preferred, < 100ms hard cap
Animation frame work at 60Hz:      < 16ms/frame
Animation frame work at 120Hz:     < 8ms/frame
Network/data completion:           separate budget
Cold screen load:                  separate budget
```

## What usually breaks the 100ms rule on iOS

- JSON decoding on main thread
- image decoding/resizing on main thread
- SwiftUI body churn from oversized state updates
- synchronous database reads
- synchronous keychain/file access
- layout thrash
- huge list diffing
- blocking analytics/logging
- waiting for network before showing UI feedback

## The corrected framing

**Yes, `/perf-loop` it.**

Use the **Paul Buchheit 100ms rule** as the UX latency test:

```text
Every user action must produce meaningful visual feedback in under 100ms.
Anything slower must be async, optimistic, skeletonized, cached, prefetched, or moved off main thread.
```

For iOS specifically, the stricter internal target is:

```text
Keep the main thread free enough to render every frame,
and keep tap-to-feedback under 100ms at p95 or better.
```


**Topic:** [[chatgpt-clusters/coding_mobile]]
