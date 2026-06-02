---
title: "Jovy Demo Video Creation"
type: essay
created: 2026-05-14
updated: 2026-05-14
source: chatgpt-export
conversation_id: 6a05156a-e0e4-83e8-bba7-cf79b6173a9e
message_count: 7
tags: [chatgpt, import, code, long-form]
---
# Jovy Demo Video Creation

> Conversation ID: 6a05156a-e0e4-83e8-bba7-cf79b6173a9e
> Created: 2026-05-14T00:20:59Z
> Updated: 2026-05-14T01:30:58Z
> Messages: 7

---

## User

For demoing Jovy, what I really would like to see is, like, the whole thing be, like, I wanna play a video or like whatever, you know what I mean, like a playwright screen recording of the whole thing, but I also want it to be, like, you know, efficiently, like, animated and everything, and the, you know, I want the, like, I want the whole chat conversation with Jovy to feel natural and to have, like, the right timing and to have the typing happen, and I wanna see, like, the typing on screen happen and everything. And so I want it to look like a real demo, as if someone's, like, it should look like, um, it should look like the same as if I recorded, uh, you know, a loom or something. Um, and except that whenever I, like the, okay, so the final product, and we'll ship iteratively on this, right, give me the steps, like, first start with X, then go to Y, then go to Z, but basically, the end thing that I want is I want, uh, you know, a Jovy.ie slash demo video or something, right, page, that's just a video embedded into the page. Um. That is, you know, responsive design and everything, and, you know, has nice mobile support. And... I just want it to be... I just want it to be, like... I want it to be so that you arrive on this page and you see a video, and it shows you... And you play the video and you hear a voiceover, and it can be my voice or it could be any voice. I don't really give a shit whose voice it is. But it's easy, like I'm very, I'm have worked professionally as a voiceover artist, like I'm fine to record the voice and then just drop it in, you know, to the repo or something. But it should be basically, you know, this... Yeah, the voiceover gets automatically muxed in. Then you see, like, all those animations should be like tight. Like it's, you shouldn't go wide for the whole thing. And then, you know, so you can see, so you actually like read what's going on, because you're looking at like... You know, like on like a retinal screen, and then it's on an even better video and shit, you know what I mean? It was like super tiny. But, you know, and show me the mouse moving and stuff, you know what I mean? So make it look like it's real. Like, don't make it look fake, like it's, don't make it look fake, it's just a comp job, you know what I mean? Make it look like real, but, you know, smooth and cinematic and stuff, and we don't see like, you know, we don't need to sit there and wait three seconds for a browser refresh and all that kind of shit, you know what I mean? I don't wanna see like the loading states and stuff. I wanna see the whole thing, you know, move pretty smoothly from one side to the other. And then, and then like animate in like a logo thing or something, and then, you know, at the end, and, you know, I can easily build that, or we could just, you know, generate it, you know, with a simple little CSS animation or something, however, it makes sense to do it. But, yeah, so like, let's work backwards from that. What is the way we build that to make it so that you still see the typing, it still feels like you're watching a real chat, but I don't have to sit there and record a, I don't have to sit there and record a screen record session, you know what I mean? Because if I do record a screen record session, it's never gonna be as good, because it's not gonna be the same data. We should be building it in like a way that's like a deterministic demo in that way, you know what I mean? And um. So, can we, can we build that now? Um Because also, if we build that now, um that gives me leverage to get money. And I need money. So, can we ship something like that quickly if we already have playwright demos and everything, but like, how to, what, what needs to happen, what needs to be coded to make all this happen?

---

## Assistant

Mr. White, I’ll work backwards from the finished demo page to the smallest shippable version, then check whether I can implement it directly or provide a drop-in plan.

---

## Assistant

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

  await page.goto("http://localhost:3000/?demo=investor", {
    waitUntil: "networkidle",
  });

  await page.waitForSelector('[data-demo-ready="true"]');

  await moveMouseSmoothly(
    page,
    { x: 720, y: 700 },
    { x: 620, y: 760 },
    500
  );

  await page.locator('[data-testid="chat-input"]').click();

  for (const step of demoScenario.steps) {
    if (step.role === "user") {
      await page
        .locator('[data-testid="chat-input"]')
        .pressSequentially(step.text, {
          delay: step.typingMsPerChar ?? 24,
        });

      await sleep(250);
      await page.keyboard.press("Enter");
    }

    await page.waitForSelector(`[data-demo-step="${step.id}-complete"]`);
    await sleep(step.pauseAfterMs ?? 600);
  }

  await sleep(1000);

  await context.close();
  await browser.close();
}

main();
```

Use `pressSequentially()` rather than `fill()` when the goal is visible typing. Playwright’s docs specifically call out character-by-character typing for cases where the typing itself matters. citeturn650057search5turn650057search9

## 3. Make Jovy stream deterministically

Inside the app, add a demo response streamer:

```ts
export async function streamDemoResponse({
  text,
  onToken,
  charsPerTick = 4,
  tickMs = 28,
}: {
  text: string;
  onToken: (chunk: string) => void;
  charsPerTick?: number;
  tickMs?: number;
}) {
  for (let i = 0; i < text.length; i += charsPerTick) {
    onToken(text.slice(i, i + charsPerTick));
    await new Promise((r) => setTimeout(r, tickMs));
  }
}
```

This gives the video the feeling of a real chat without depending on API latency.

You want three timing layers:

```ts
user typing speed
assistant streaming speed
inter-scene pause
```

That is what makes it feel real.

## 4. Add demo-only hooks to the UI

Use stable selectors and status markers:

```tsx
<div data-demo-ready="true" />

<textarea data-testid="chat-input" />

<Message
  data-demo-step={`${step.id}-complete`}
/>
```

Avoid selecting by text. The script should not break when copy changes.

Also add cinematic affordances only in demo mode:

```tsx
<body className={isDemo ? "demo-mode" : ""}>
```

```css
.demo-mode * {
  scroll-behavior: smooth;
}

.demo-mode [data-demo-hide] {
  display: none;
}

.demo-mode .chat-shell {
  max-width: 960px;
}
```

## 5. Use Playwright for the real capture, then FFmpeg or Remotion for polish

There are two good paths.

### Path A: fastest version

Use Playwright video capture, then FFmpeg.

Playwright records the browser session, and FFmpeg can mux audio/video and transcode outputs. FFmpeg describes itself as a universal media converter that can read inputs and transcode them into output formats. citeturn498718search1

Example:

```bash
ffmpeg \
  -i artifacts/demo/raw/demo.webm \
  -i demo/audio/voiceover.wav \
  -map 0:v:0 \
  -map 1:a:0 \
  -c:v libx264 \
  -c:a aac \
  -shortest \
  -movflags +faststart \
  public/demo/jovy-demo.mp4
```

Then generate WebM too:

```bash
ffmpeg \
  -i public/demo/jovy-demo.mp4 \
  -c:v libvpx-vp9 \
  -c:a libopus \
  public/demo/jovy-demo.webm
```

This ships quickly.

### Path B: best-looking version

Use Playwright to capture clean browser footage, then use **Remotion** for camera zooms, intro logo animation, overlays, captions, crops, and final render. Remotion is built for programmatic video with React and renders MP4s from compositions via CLI. citeturn498718search5turn498718search19

This gives you the “cinematic but real” look:

```txt
Playwright raw capture
        ↓
Remotion composition
        ↓
Camera zooms / crops / logo / timing
        ↓
Voiceover / captions
        ↓
Final MP4 + WebM
```

I would start with Path A, then graduate to Path B once the demo narrative is locked.

## 6. Add a simple `/demo` page

Assuming Next.js, static files can be served from `public`, and Next’s docs show direct video embedding with the `<video>` tag. citeturn650057search3turn650057search6

Example:

```tsx
// app/demo/page.tsx

export default function DemoPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <section className="mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center px-4 py-10">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-semibold tracking-tight md:text-5xl">
            See Jovy in action
          </h1>
          <p className="mt-3 text-sm text-white/70 md:text-base">
            A deterministic product demo showing how Jovy works end to end.
          </p>
        </div>

        <div className="w-full overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 shadow-2xl">
          <video
            className="aspect-video w-full"
            controls
            playsInline
            preload="metadata"
            poster="/demo/jovy-demo-poster.jpg"
          >
            <source src="/demo/jovy-demo.webm" type="video/webm" />
            <source src="/demo/jovy-demo.mp4" type="video/mp4" />
          </video>
        </div>
      </section>
    </main>
  );
}
```

## 7. Add one command to generate the demo

Add this to `package.json`:

```json
{
  "scripts": {
    "demo:serve": "next dev",
    "demo:capture": "tsx scripts/render-demo.ts",
    "demo:mux": "ffmpeg -i artifacts/demo/raw/demo.webm -i demo/audio/voiceover.wav -map 0:v:0 -map 1:a:0 -c:v libx264 -c:a aac -shortest -movflags +faststart public/demo/jovy-demo.mp4",
    "demo:render": "pnpm demo:capture && pnpm demo:mux"
  }
}
```

Better version:

```json
{
  "scripts": {
    "demo:render": "tsx scripts/render-demo.ts && tsx scripts/mux-demo.ts"
  }
}
```

This lets you regenerate the whole video whenever the UI, copy, or voiceover changes.

## What needs to be coded

### Required for MVP

```txt
/demo/scenarios/investor-demo.ts
```

A deterministic script:

```ts
export const demoScenario = {
  name: "investor-demo",
  steps: [
    {
      id: "find-candidates",
      role: "user",
      text: "Find me 20 senior growth candidates in Los Angeles.",
      typingMsPerChar: 26,
      pauseAfterMs: 500,
    },
    {
      id: "rank-candidates",
      role: "user",
      text: "Rank them by founder-fit and likelihood to take a call.",
      typingMsPerChar: 22,
      pauseAfterMs: 600,
    },
  ],
};
```

```txt
/scripts/render-demo.ts
```

The Playwright actor.

```txt
/scripts/mux-demo.ts
```

Finds the raw Playwright video, normalizes it, adds voiceover, exports final files.

```txt
/app/demo/page.tsx
```

Responsive video page.

```txt
/demo/audio/voiceover.wav
```

Your voiceover file.

```txt
/public/demo/jovy-demo.mp4
/public/demo/jovy-demo.webm
/public/demo/jovy-demo-poster.jpg
```

Final assets.

### Required inside the app

```txt
?demo=investor
```

Demo mode.

```txt
data-testid="chat-input"
data-demo-ready="true"
data-demo-step="..."
```

Stable Playwright hooks.

```txt
demo response fixtures
```

Predefined assistant outputs.

```txt
demo timing helpers
```

Typing, streaming, pauses, and scroll control.

## The right first implementation

Build it in this order:

### Step 1 — Deterministic chat script

Get the demo conversation rendering inside the actual app with fixed Jovy responses.

Success condition:

```txt
You can load /?demo=investor and manually click through a polished scripted conversation.
```

### Step 2 — Playwright actor

Make Playwright open the page, move the mouse, type the prompts, submit them, and wait for each deterministic response.

Success condition:

```txt
The browser performs the demo by itself with real typing and real UI.
```

### Step 3 — Raw video capture

Turn on Playwright video recording and save the browser session.

Success condition:

```txt
pnpm demo:capture produces a raw video file.
```

### Step 4 — Audio mux

Add your voiceover file and mux it into the final output.

Success condition:

```txt
pnpm demo:render produces public/demo/jovy-demo.mp4.
```

### Step 5 — `/demo` page

Embed the video with responsive layout, poster frame, mobile support, and fallback sources.

Success condition:

```txt
jov.ie/demo shows a clean page with the video.
```

### Step 6 — Cinematic polish

Add:

```txt
smooth cursor motion
scroll easing
zoom/crop scenes
intro logo animation
outro CTA
captions
poster frame
```

This is where Remotion becomes useful.

## My recommended MVP cut

For the first shipped version, do this:

```txt
Playwright + deterministic fixtures + FFmpeg + /demo page
```

Skip Remotion initially unless the raw capture looks too flat.

The first cut should be real UI, real typing, real mouse movement, and no visible waiting. Then use Remotion or FFmpeg filters to make it more cinematic.

## The key implementation rule

Do **not** fake the whole thing as a static animation.

Use the real Jovy interface and make the browser perform a scripted demo. Fake only the unstable parts:

```txt
network latency
LLM response timing
candidate data
loading states
refreshes
auth
random UI behavior
```

That gives you the Loom feeling without the Loom fragility.

---

## User

jovie. how Can you figure that out? Obviously, it's a speech-to-text thing. Speck out the re-motion. Well, no. Give me Path A. Give me Path A as an implementation spec. Do I need to do the voiceover first, or what's the first step of this? 

---

## Assistant

I’ll make this Path A-only: Playwright capture, deterministic fixtures, FFmpeg mux, static `/demo` page. Voiceover can come after the first silent capture, so start with the deterministic demo script.

---

## Assistant

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
      type: "assistant-response",
      text:
        "Here are the top candidates ranked by fit, relevance, and probability of engagement. I also included the recommended outreach angle for each one.",
      streamCharsPerTick: 4,
      streamTickMs: 24,
      pauseAfterMs: 1000,
    },
  ],
} as const;
```

This file becomes the source of truth for the visual demo.

The voiceover should be written against this script later.

---

# Required file structure

Add this:

```txt
demo/
  scenarios/
    investor-demo.ts
  audio/
    voiceover.wav
  posters/
    jovie-demo-poster.jpg

scripts/
  render-demo.ts
  mux-demo.ts

public/
  demo/
    jovie-demo.mp4
    jovie-demo.webm
    jovie-demo-poster.jpg

app/
  demo/
    page.tsx
```

Or if Jovie uses the Pages Router:

```txt
pages/
  demo.tsx
```

---

# Package dependencies

Install:

```bash
pnpm add -D playwright tsx
```

FFmpeg should be installed locally on the machine or CI runner:

```bash
brew install ffmpeg
```

FFmpeg is the right tool here because it can read media inputs, transcode them, and write final output formats. citeturn500801search6

Optional but useful:

```bash
pnpm add -D execa
```

---

# App changes required

## 1. Add demo mode

The app should recognize:

```txt
/?demo=investor
```

or:

```txt
/demo/live?scenario=investor
```

I would use a hidden internal route:

```txt
/demo/live?scenario=investor
```

Then the public page is:

```txt
/demo
```

So the capture route and the viewer route stay separate.

Example:

```ts
const isDemoMode = searchParams.get("demo") === "investor";
```

or:

```ts
const scenario = searchParams.get("scenario");
const isDemoMode = scenario === "investor";
```

Demo mode should stabilize:

```txt
auth
network calls
LLM responses
loading states
random data
timestamps
animations
candidate/person data
```

The app should still use the real UI.

---

## 2. Add demo fixtures

Create deterministic demo data:

```txt
demo/fixtures/candidates.ts
demo/fixtures/conversations.ts
```

Example:

```ts
export const demoCandidates = [
  {
    name: "Maya Chen",
    title: "VP Growth",
    company: "Series B Marketplace Company",
    location: "Los Angeles",
    fitScore: 94,
    reason: "Led marketplace growth from $8M to $42M ARR.",
  },
  {
    name: "Alex Rivera",
    title: "Head of GTM",
    company: "AI Workflow Startup",
    location: "Santa Monica",
    fitScore: 91,
    reason: "Strong consumer AI and founder-led sales experience.",
  },
];
```

Use fake or approved data unless the demo requires real contacts.

---

## 3. Add stable Playwright hooks

Add selectors specifically for the renderer.

```tsx
<textarea
  data-testid="chat-input"
  data-demo="chat-input"
/>

<button
  data-testid="chat-submit"
  data-demo="chat-submit"
/>

<div data-demo-ready="true" />

<div data-demo-step-complete={stepId} />
```

The Playwright script should select elements by these attributes, not by visible text.

---

## 4. Add deterministic assistant streaming

In demo mode, Jovie should stream fixed responses.

Example helper:

```ts
export async function streamDemoText({
  text,
  onChunk,
  charsPerTick = 4,
  tickMs = 24,
}: {
  text: string;
  onChunk: (chunk: string) => void;
  charsPerTick?: number;
  tickMs?: number;
}) {
  for (let i = 0; i < text.length; i += charsPerTick) {
    onChunk(text.slice(i, i + charsPerTick));
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }
}
```

This is what makes the assistant feel live without depending on model latency.

---

# Playwright renderer

Create:

```txt
scripts/render-demo.ts
```

Spec:

```ts
import path from "node:path";
import fs from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { investorDemo } from "../demo/scenarios/investor-demo";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function moveMouseSmoothly(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs = 600
) {
  const steps = 36;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const eased = 1 - Math.pow(1 - t, 3);

    await page.mouse.move(
      from.x + (to.x - from.x) * eased,
      from.y + (to.y - from.y) * eased
    );

    await sleep(durationMs / steps);
  }
}

async function main() {
  const rawDir = path.resolve("artifacts/demo/raw");
  await ensureDir(rawDir);

  const baseUrl = process.env.DEMO_BASE_URL ?? "http://localhost:3000";
  const captureUrl = `${baseUrl}/demo/live?scenario=investor`;

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    viewport: {
      width: investorDemo.viewport.width,
      height: investorDemo.viewport.height,
    },
    deviceScaleFactor: investorDemo.viewport.deviceScaleFactor,
    recordVideo: {
      dir: rawDir,
      size: {
        width: investorDemo.viewport.width,
        height: investorDemo.viewport.height,
      },
    },
  });

  const page = await context.newPage();

  await page.goto(captureUrl, {
    waitUntil: "networkidle",
  });

  await page.waitForSelector('[data-demo-ready="true"]');

  let mouse = { x: 720, y: 720 };

  await moveMouseSmoothly(page, mouse, { x: 650, y: 760 }, 500);
  mouse = { x: 650, y: 760 };

  const input = page.locator('[data-testid="chat-input"]');
  await input.click();

  for (const step of investorDemo.steps) {
    if (step.type === "wait") {
      await sleep(step.durationMs);
      continue;
    }

    if (step.type === "user-message") {
      await input.pressSequentially(step.text, {
        delay: step.typingMsPerChar ?? 24,
      });

      await sleep(250);

      const submit = page.locator('[data-testid="chat-submit"]');

      if (await submit.isVisible()) {
        await submit.click();
      } else {
        await page.keyboard.press("Enter");
      }

      if (step.pauseAfterMs) {
        await sleep(step.pauseAfterMs);
      }

      continue;
    }

    if (step.type === "assistant-response") {
      await page.waitForSelector(
        `[data-demo-step-complete="${step.id}"]`,
        { timeout: 30_000 }
      );

      if (step.pauseAfterMs) {
        await sleep(step.pauseAfterMs);
      }

      continue;
    }
  }

  await sleep(1000);

  const video = page.video();
  const rawVideoPath = video ? await video.path() : null;

  await context.close();
  await browser.close();

  if (!rawVideoPath) {
    throw new Error("No Playwright video was created.");
  }

  const finalRawPath = path.resolve("artifacts/demo/raw/jovie-demo-raw.webm");
  await fs.copyFile(rawVideoPath, finalRawPath);

  console.log(`Raw demo video written to ${finalRawPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Important detail: Playwright video files are finalized after the browser context closes, so the script needs to close the context before treating the video as complete. citeturn500801search4

---

# FFmpeg mux/export script

Create:

```txt
scripts/mux-demo.ts
```

Spec:

```ts
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

const exists = async (file: string) => {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
};

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function main() {
  const rawVideo = path.resolve("artifacts/demo/raw/jovie-demo-raw.webm");
  const voiceover = path.resolve("demo/audio/voiceover.wav");

  const outputDir = path.resolve("public/demo");
  const outputMp4 = path.join(outputDir, "jovie-demo.mp4");
  const outputWebm = path.join(outputDir, "jovie-demo.webm");

  await fs.mkdir(outputDir, { recursive: true });

  if (!(await exists(rawVideo))) {
    throw new Error(`Missing raw video: ${rawVideo}`);
  }

  const hasVoiceover = await exists(voiceover);

  if (hasVoiceover) {
    await run("ffmpeg", [
      "-y",
      "-i",
      rawVideo,
      "-i",
      voiceover,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputMp4,
    ]);
  } else {
    await run("ffmpeg", [
      "-y",
      "-i",
      rawVideo,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputMp4,
    ]);
  }

  await run("ffmpeg", [
    "-y",
    "-i",
    outputMp4,
    "-c:v",
    "libvpx-vp9",
    "-c:a",
    "libopus",
    outputWebm,
  ]);

  console.log(`Wrote ${outputMp4}`);
  console.log(`Wrote ${outputWebm}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

I would **not** use `-shortest` for the first implementation. Let the visual demo determine the video length. If the voiceover is shorter, the final seconds can be silent. If the voiceover is longer, that tells us the script needs trimming or the visual pauses need lengthening.

---

# Package scripts

Add:

```json
{
  "scripts": {
    "demo:capture": "tsx scripts/render-demo.ts",
    "demo:mux": "tsx scripts/mux-demo.ts",
    "demo:render": "pnpm demo:capture && pnpm demo:mux"
  }
}
```

If the app needs to be running locally:

```json
{
  "scripts": {
    "demo:dev": "next dev",
    "demo:capture": "tsx scripts/render-demo.ts",
    "demo:mux": "tsx scripts/mux-demo.ts",
    "demo:render": "pnpm demo:capture && pnpm demo:mux"
  }
}
```

Later, make a script that starts the server automatically:

```json
{
  "scripts": {
    "demo:render": "start-server-and-test 'pnpm dev' http://localhost:3000 'pnpm demo:capture && pnpm demo:mux'"
  }
}
```

---

# `/demo` page

Create:

```tsx
// app/demo/page.tsx

export default function DemoPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <section className="mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center px-4 py-10">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-semibold tracking-tight md:text-5xl">
            See Jovie in action
          </h1>

          <p className="mt-3 text-sm text-white/70 md:text-base">
            Watch how Jovie helps find, rank, and act on high-fit people.
          </p>
        </div>

        <div className="w-full overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 shadow-2xl">
          <video
            className="aspect-video w-full"
            controls
            playsInline
            preload="metadata"
            poster="/demo/jovie-demo-poster.jpg"
          >
            <source src="/demo/jovie-demo.webm" type="video/webm" />
            <source src="/demo/jovie-demo.mp4" type="video/mp4" />
          </video>
        </div>
      </section>
    </main>
  );
}
```

Next.js serves files from `public` at root-relative URLs, and its docs show direct video embedding with the native `<video>` tag. citeturn500801search3turn500801search7

---

# Internal capture route

Create:

```txt
app/demo/live/page.tsx
```

This route renders the real Jovie app shell, but with demo fixtures.

Conceptually:

```tsx
import { JovieApp } from "@/components/JovieApp";
import { investorDemo } from "@/demo/scenarios/investor-demo";

export default function DemoLivePage() {
  return (
    <JovieApp
      demoMode
      demoScenario={investorDemo}
    />
  );
}
```

The public user never needs to visit this route. It exists for Playwright.

---

# Voiceover workflow

Do **not** start with the final voiceover.

Use this order:

## 1. Draft narration text

Example:

```txt
Jovie helps founders find and act on the right people faster.

In this demo, we ask Jovie to find senior growth candidates in Los Angeles.

Jovie searches, ranks, and explains why each person is relevant.

Then we ask it to rank the candidates by founder-fit and likelihood to take a call.
```

## 2. Render silent video

```bash
pnpm demo:render
```

At first, `demo/audio/voiceover.wav` can be missing.

## 3. Watch the silent video

Tune:

```txt
typing speed
assistant streaming speed
pause lengths
scrolling
mouse movement
screen framing
```

## 4. Record voiceover

Record once the visuals are close.

Save:

```txt
demo/audio/voiceover.wav
```

## 5. Re-run

```bash
pnpm demo:render
```

The same visual demo gets muxed with the new audio.

---

# Acceptance criteria

The MVP is done when:

```txt
pnpm demo:render
```

does all of this:

```txt
opens Jovie in demo mode
types the scripted user prompts
shows deterministic assistant responses
records the browser
exports MP4
exports WebM
puts final assets in public/demo
```

And:

```txt
/demo
```

shows a responsive video page on desktop and mobile.

---

# What I would code first

Start here:

```txt
demo/scenarios/investor-demo.ts
```

Then add:

```txt
/demo/live?scenario=investor
```

Then add stable selectors:

```txt
data-testid="chat-input"
data-testid="chat-submit"
data-demo-ready="true"
data-demo-step-complete="..."
```

Then write:

```txt
scripts/render-demo.ts
```

After that, the voiceover is just an asset drop:

```txt
demo/audio/voiceover.wav
```

The key thing: **lock the deterministic visual flow before recording final audio**. The voiceover should follow the demo timing, and then you can fine-tune pauses around it.

---

## User

I want you to check the actual repo for what is available right now so that you're grounding this in a spot of expanding what we have and not rebuilding what's already there. Also, do deep research on this against anything to harden the general plan and give it to me as a handoff that I can give to a coding agent that can just build the whole thing. 
