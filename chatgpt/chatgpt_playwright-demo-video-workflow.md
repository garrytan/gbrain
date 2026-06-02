---
title: "Playwright Demo Video Workflow"
type: guide
created: 2026-04-25
updated: 2026-04-25
source: chatgpt-export
conversation_id: 69ec04fd-f468-83e8-8a09-69758321ce0c
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Playwright Demo Video Workflow

> Conversation ID: 69ec04fd-f468-83e8-8a09-69758321ce0c
> Created: 2026-04-25T00:04:15Z
> Updated: 2026-04-25T00:11:59Z
> Messages: 4

---

## User

Hey, I’m about to record my YC demo. The product includes a consumer-facing surface on my artist profile, plus an artist-facing surface, and a label and manager team-facing surface that’s still in the management system. I need to showcase a demo video of the profiles and everything, then demonstrate the product and assemble it into a demo.

I have a voiceover ready to record. For the phone mockups, I want a repeatable approach so we can iterate on the demo. Can Playwright drive the screens and animate the phone? It’s just a mobile website. Can Playwright record the screens? Can it simulate the tap indicators or pulse/radar ripple effects to show where the tabs are? Can I generate the video sequence with Playwright, produce the video files, and then edit them in a video editor?

Is it possible to feed my audio file to Claude or another service and have it drop into the repo, then automatically generate videos with audio already embedded? If so, I’ll produce a slick voiceover with sound design and have Playwright insert timing cues. Is that the best approach, or how should I think about this? Are there other platforms that would do this better or faster? It doesn’t need to be flashy; it just needs to clearly and concisely show a phone screen. A Playwright video is fine as long as it’s smooth and glitch-free.

---

## Assistant

Mr. White, I’ll separate what Playwright can handle reliably from what belongs in FFmpeg or an editor, then outline a repeatable YC-demo production workflow.

---

## Assistant

Playwright can likely provide the raw driven screen recordings and action highlights; the decision point is whether to stop there or add Remotion/editor polish for audio, framing, timing, and export.

---

## Assistant

Mr. White, yes. **Playwright is viable for this**, especially because it is a mobile website. The best setup is to use Playwright as the deterministic **screen driver/recorder**, then use Remotion, FFmpeg, Screen Studio, Final Cut, Premiere, or DaVinci as the **composition layer**.

## Direct answers

**Can Playwright drive the phone screens?**  
Yes. Use Playwright mobile device emulation for the consumer artist profile and any mobile artist-facing views. Playwright can emulate device parameters such as user agent, viewport, screen size, and touch support through its device registry. citeturn939802search0

**Can Playwright record the screens?**  
Yes. Playwright can record videos through `recordVideo` or Playwright Test’s `video` option. Videos are saved when the browser context closes, and you can set the output size. citeturn959935view0turn959935view2

**Can it show tap indicators / pulses / radar ripples?**  
Yes, in two ways. Playwright’s newer `page.screencast` API supports start/stop recording, action annotations, chapter overlays, and custom HTML overlays; `showActions()` can visually annotate interacted elements. citeturn788169search0 For a nicer YC-style tap ripple, I would inject your own CSS/HTML pulse overlay or add a small demo-only overlay component in the app, because Playwright’s built-in annotations are more functional than polished.

**Can it animate the phone mockup?**  
Partially. Playwright can record a page that contains a phone frame around your mobile app, so the recording includes the phone mockup. For actual 3D phone motion, shadows, tilt, or device animations, use a compositor like Remotion, Rotato, After Effects, or a video editor. Rotato, for example, is specifically built to put videos/images onto device mockups and render animated mockup movies. citeturn726321search0turn726321search10

**Can you generate video files with Playwright and edit them later?**  
Yes. That is the cleanest approach: generate silent raw clips per scene, then edit or render the final sequence elsewhere.

## Recommended approach

Use this pipeline:

```text
voiceover.mp3 / voiceover.wav
        ↓
timeline.json with scene timings
        ↓
Playwright records deterministic raw clips
        ↓
Remotion or editor composites:
  - phone frame
  - raw screen recordings
  - tap ripples
  - captions / labels
  - voiceover + sound design
        ↓
final YC demo video.mp4
```

I would avoid making Playwright responsible for the whole final video. Let Playwright handle browser state, navigation, clicks, scrolling, and recording. Let Remotion or a video editor handle the polished output.

## Best implementation pattern

Create a small demo package in the repo:

```text
/demo
  /record
    consumer-profile.ts
    artist-dashboard.ts
    manager-label-system.ts
  /assets
    voiceover.wav
    phone-frame.png
  /out
    raw/
    final/
  timeline.json
```

Example commands:

```json
{
  "scripts": {
    "demo:record": "tsx demo/record/index.ts",
    "demo:render": "remotion render Demo demo/out/final/yc-demo.mp4",
    "demo": "npm run demo:record && npm run demo:render"
  }
}
```

A Playwright scene can look roughly like this:

```ts
import { chromium, devices } from "playwright";

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices["iPhone 13"],
  viewport: { width: 390, height: 844 },
});

const page = await context.newPage();

await page.goto("http://localhost:3000/artist/your-artist-profile");

await page.screencast.start({
  path: "demo/out/raw/consumer-profile.webm",
  size: { width: 390, height: 844 },
});

await page.screencast.showActions({
  duration: 650,
  position: "bottom",
});

await page.getByRole("tab", { name: "Music" }).tap();
await page.waitForTimeout(900);

await page.getByRole("tab", { name: "Shows" }).tap();
await page.waitForTimeout(900);

await page.screencast.stop();

await context.close();
await browser.close();
```

For older Playwright versions, use `recordVideo` on the browser context instead of `page.screencast`.

## Audio and timing

Yes, you can feed the audio file into an AI or transcription service, then generate timing cues. OpenAI’s speech-to-text API supports audio transcription and formats including `mp3`, `mp4`, `m4a`, `wav`, and `webm`; current docs also list `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, and diarization models. citeturn637085view2 If you want timestamped caption formats like SRT/VTT, current OpenAI docs list those output formats for `whisper-1`. citeturn637085view2

For the actual final render, Remotion is a strong fit. It can render video programmatically via `renderMedia()`, and it supports adding audio assets inside compositions using `<Audio />` or `<Html5Audio />`. citeturn637085view3turn787734search1

Use a timing file like this:

```json
{
  "fps": 30,
  "scenes": [
    {
      "id": "consumer-profile",
      "start": 0,
      "duration": 8.5,
      "clip": "demo/out/raw/consumer-profile.webm",
      "caption": "A public artist profile fans can actually use."
    },
    {
      "id": "artist-tools",
      "start": 8.5,
      "duration": 11,
      "clip": "demo/out/raw/artist-dashboard.webm",
      "caption": "Artists can manage what fans and partners see."
    },
    {
      "id": "label-manager",
      "start": 19.5,
      "duration": 13,
      "clip": "demo/out/raw/manager-label-system.webm",
      "caption": "Managers and labels get the team-facing control surface."
    }
  ]
}
```

Claude Code or another coding agent can help wire this into the repo because Claude Code can read a codebase, edit files, run commands, and work across multiple files. citeturn637085view0 I would use Claude to generate or modify the Playwright/Remotion scripts, then run a deterministic `npm run demo` pipeline. I would avoid asking the model to “watch the audio and improvise the video” each time. Use AI for transcript and cue suggestions; use code for repeatable rendering.

## Faster alternatives

For **fastest polished manual output**, use Screen Studio. It is built for product demos, automatic zooms, cursor smoothing, background styling, trimming, and exports. citeturn637085view4

For **free/simple screen capture**, Kap can export MP4/WebM/GIF/APNG, includes optional audio, click highlights, and trimming. citeturn637085view5

For **repeatable YC demo iteration**, use Playwright + Remotion. That gives you the ability to change the voiceover, update the product, regenerate the clips, and keep the same structure.

## What I’d do for your YC demo

Build a **repeatable but simple** setup:

1. Record voiceover first.
2. Break it into 6–10 short scenes.
3. Record each scene separately with Playwright.
4. Add tap pulses either through Playwright `showActions()` or a custom CSS overlay.
5. Composite everything in Remotion or Screen Studio.
6. Keep the final YC demo short, with the phone screen large enough to read.

The most reliable version is: **Playwright for deterministic raw captures, Remotion or Screen Studio for final presentation, manual editor only for last-mile polish.**
