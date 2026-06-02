---
title: "Jovy Demo Video Creation"
type: guide
created: 2026-05-14
updated: 2026-05-14
source: chatgpt-export
topic: misc
message_count: 7
tags: [chatgpt, knowledge, misc]
---
**Topic:** [[chatgpt-knowledge/_topics/misc]]

# Jovy Demo Video Creation

> **Source:** ChatGPT conversation
> **Date:** 2026-05-14T00:20:59Z
> **Messages:** 7
> **Topic:** misc

## Question

For demoing Jovy, what I really would like to see is, like, the whole thing be, like, I wanna play a video or like whatever, you know what I mean, like a playwright screen recording of the whole thing, but I also want it to be, like, you know, efficiently, like, animated and everything, and the, you know, I want the, like, I want the whole chat conversation with Jovy to feel natural and to have, like, the right timing and to have the typing happen, and I wanna see, like, the typing on screen happen and everything. And so I want it to look like a real demo, as if someone's, like, it should look like, um, it should look like the same as if I recorded, uh, you know, a loom or something. Um, and except that whenever I, like the, okay, so the final product, and we'll ship iteratively on this, right, give me the steps, like, first start with X, then go to Y, then go to Z, but basically, the end thing that I want is I want, uh, you know, a Jovy.ie slash demo video or something, right, page, t

## Answer

Mr. White, I’ll work backwards from the finished demo page to the smallest shippable version, then check whether I can implement it directly or provide a drop-in plan.

## Answer

Mr. White, yes. Build this as a **deterministic demo-rendering pipeline**, rather than a one-off Loom recording.

The fastest credible version is:

1. **Script the Jovy conversation as data**
2. **Drive the real app with Playwright**
3. **Type and move the mouse programmatically**
4. **Record the browser session**
5. **Post-process the recording into a cinematic video**
6. **Mux in voiceover**
7. **Serve it at `/demo` as a responsive embedded video**

Playwright already gives the core primitives: video recording, real browser control, keyboard typing, and mouse movement. Videos are written after the browser context closes, and Playwright supports character-by-character typing through `locator.pressSequentially()` plus mouse control through `page.mouse`. citeturn498718search0turn498718search2turn650057search0turn650057search5

## Recommended architecture

### 1. Add a `demo-mode` route or query param

Create a deterministic app state:

```txt
https://jov.ie/?demo=investor
```

In demo mode:

```ts
const isDemo = searchParams.get("demo") === "investor";
```

Then disable or stabilize anything that makes the capture inconsistent:

```ts
if (isDemo) {
  // Use fixed seeded data
  // Disable random delays
  // Disable auth redirects
  // Disable nonessential loading states
  // Use deterministic Jovy responses
}
```

The demo should run against the **real UI**, but with demo fixtures:

```ts
export const demoConversation = [
  {
    role: "user",
    text: "Find me 20 senior growth candidates in Los Angeles.",
    typingMsPerChar: 28,
  },
  {
    role: "assistant",
    text: "I found a strong shortlist. I prioritized operators with marketplace, consumer, and AI GTM experience.",
    reveal: "stream",
  },
  {
    role: "user",
    text: "Rank them by founder-fit and likelihood to take a call.",
    typingMsPerChar: 24,
  },
];
```

The key is that Jovy’s responses should feel live, while being fixed.

## 2. Add a Playwright demo runner

Create something like:

```txt
/scripts/render-demo.ts
/demo/scenarios/investor-demo.ts
/public/demo/
```

The Playwright script should:

```ts
import { chromium } from "playwright";
import { demoScenario } from "../demo/scenarios/investor-demo";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function moveMouseSmoothly(page, from, to, duration = 600) {
  const steps = 30;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const eased = 1 - Math.pow(1 - t, 3);

    await page.mouse.move(
      from.x + (to.x - from.x) * eased,
      from.y + (to.y - from.y) * eased
    );

    await sleep(duration / steps);
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    recordVideo: {
      dir: "artifacts/demo/raw",
      size: { width: 1440, height: 900 },
    },
  });

  const page = await context.newPage();

  a

*(Answer truncated — 12031 chars total)*

## Question

jovie. how Can you figure that out? Obviously, it's a speech-to-text thing. Speck out the re-motion. Well, no. Give me Path A. Give me Path A as an implementation spec. Do I need to do the voiceover first, or what's the first step of this? 

## Answer

I’ll make this Path A-only: Playwright capture, deterministic fixtures, FFmpeg mux, static `/demo` page. Voiceover can come after the first silent capture, so start with the deterministic demo script.

## Answer

Mr. White, **you do not need to do the final voiceover first**.

The first step is to create the **deterministic visual demo** with no final audio. Use a placeholder voiceover, scratch timing, or no audio. Once the video flow feels right, record the real voiceover and mux it in.

The order should be:

```txt
1. Script the demo conversation
2. Add demo-mode fixtures to Jovie
3. Make Playwright perform the demo
4. Capture raw video
5. Adjust timing
6. Record final voiceover
7. Mux voiceover into final MP4/WebM
8. Serve it at /demo
```

Path A is:

```txt
Real Jovie UI
+ deterministic demo data
+ Playwright-controlled typing/mouse
+ Playwright video capture
+ FFmpeg mux/export
+ responsive /demo page
```

Playwright supports browser video capture through `recordVideo`, and videos are finalized when the browser context closes. It also supports character-by-character input with `locator.pressSequentially()`, which is what we want for visible typing. citeturn500801search0turn500801search4turn500801search5

---

# Path A implementation spec

## Goal

Ship:

```txt
https://jov.ie/demo
```

with an embedded video that looks like a real Loom-style product demo, but is generated deterministically from code.

The final command should be:

```bash
pnpm demo:render
```

And it should output:

```txt
public/demo/jovie-demo.mp4
public/demo/jovie-demo.webm
public/demo/jovie-demo-poster.jpg
```

---

# The first thing to build

Build the **demo scenario file** first.

Do this before voiceover.

Create:

```txt
demo/scenarios/investor-demo.ts
```

Example:

```ts
export type DemoStep =
  | {
      id: string;
      type: "user-message";
      text: string;
      typingMsPerChar?: number;
      pauseAfterMs?: number;
    }
  | {
      id: string;
      type: "assistant-response";
      text: string;
      streamCharsPerTick?: number;
      streamTickMs?: number;
      pauseAfterMs?: number;
    }
  | {
      id: string;
      type: "wait";
      durationMs: number;
    };

export const investorDemo = {
  id: "investor-demo",
  title: "Jovie Investor Demo",
  viewport: {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
  },
  steps: [
    {
      id: "open",
      type: "wait",
      durationMs: 700,
    },
    {
      id: "find-candidates",
      type: "user-message",
      text: "Find me 20 senior growth candidates in Los Angeles.",
      typingMsPerChar: 24,
      pauseAfterMs: 350,
    },
    {
      id: "find-candidates-response",
      type: "assistant-response",
      text:
        "I found a strong shortlist. I prioritized senior growth operators with marketplace, consumer, and AI go-to-market experience.",
      streamCharsPerTick: 4,
      streamTickMs: 26,
      pauseAfterMs: 800,
    },
    {
      id: "rank-candidates",
      type: "user-message",
      text: "Rank them by founder-fit and likelihood to take a call.",
      typingMsPerChar: 22,
      pauseAfterMs: 350,
    },
    {
      id: "rank-candidates-response",
      type: "assista

*(Answer truncated — 16679 chars total)*

## Question

I want you to check the actual repo for what is available right now so that you're grounding this in a spot of expanding what we have and not rebuilding what's already there. Also, do deep research on this against anything to harden the general plan and give it to me as a handoff that I can give to a coding agent that can just build the whole thing. 
