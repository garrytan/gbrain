---
conversation_id: 69e7eb3b-6998-83e8-9625-03557f1bdf14
created: 2026-04-21
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 3
source: chatgpt-export
tags:
- chatgpt
- import
title: AI Upscaling for Mobile
type: note
updated: 2026-04-21
---

# AI Upscaling for Mobile

**Related:** [[coding_mobile]]

> Conversation ID: 69e7eb3b-6998-83e8-9625-03557f1bdf14
> Created: 2026-04-21T21:25:16Z
> Updated: 2026-04-21T21:29:00Z
> Messages: 3

---

## User

for repeated AI upscaling, coloring, so pulling like 600 pixel image and trying to upscale to something on a mobile device that's gonna look, at minimum, retina. What would be the cheapest model for us to run? I'd probably use like a Vercel AI gateway or something. What would be the best model that's gonna give you good enough results per minimum cost? I'm gonna assume the new XAI rock image gen model is probably gonna do it, but I need like something that can be run deterministically, no human input. So we're gonna scrape images and stuff, and then we need to display them on retina displays, and they can't look like ass.

---

## Assistant

I’ll ground this in current pricing and capabilities, then separate the cheapest production path from API-gateway convenience, since image generation and super-resolution have very different cost and quality profiles.

---

## Assistant

Mr. White, I’d make **Real-ESRGAN-style super-resolution** the default path, with **Grok/xAI only as a fallback for semantic repair**. For scraped 600px images going to mobile retina, you want deterministic restoration, low cost, and content preservation. General image generators are expensive and can subtly redraw details.

### Recommended stack

**Default model:** `RealESRGAN_x4plus` or `RealESR General x4v3`  
**API path:** Replicate Real-ESRGAN or fal.ai ESRGAN  
**High-volume path:** self-host Real-ESRGAN / RealESR General x4v3 on a cheap GPU worker  
**Fallback:** Grok Imagine Image Edit only when the source is genuinely unusable and a generative redraw is acceptable.

Vercel AI Gateway is fine as an orchestration layer for image models, and it supports image generation/editing across providers, including xAI Grok Imagine models. Vercel says AI Gateway has no markup and charges provider list rates. It also supports `xai/grok-imagine-image` and `xai/grok-imagine-image-pro`. citeturn105868view0turn821879search1turn760295search3

### Cost reality

| Option | Approx cost | Best use |
|---|---:|---|
| **Replicate Real-ESRGAN** | **$2 / 1,000 images** | Cheapest easy API baseline. citeturn855466search2 |
| **fal.ai ESRGAN** | **$0.00111 / compute-second** | Good if runtime is low; 1–2 sec/image lands around $0.001–$0.002/image. citeturn105868view3 |
| **Self-host on rented GPU** | Formula: GPU hourly / 3600 / images-per-second | Cheapest at scale. fal lists A100 from $0.99/hr and H100 from $1.89/hr. citeturn105868view4 |
| **Grok Imagine Image/Edit** | Standard image gen is around **$0.02/image**, edits around **$0.022/image** via fal | Useful for generative repair, expensive for bulk upscaling. citeturn495442search12turn495442search14 |

At 1M images, Real-ESRGAN via Replicate is roughly **$2,000**. Grok-style editing would be roughly **$20k–$22k**. Self-hosting can plausibly get much lower, depending on throughput and ops overhead.

### Retina sizing rule

Do the math from the actual render size:

`target_pixels = CSS_display_width × device_pixel_ratio`

A 600px source already looks retina when rendered at **300 CSS px on @2x**. For a full-width iPhone-style card, assume ~390–430 CSS px. At @3x, target is ~1,170–1,290 px. So a **2x upscale from 600 → 1,200px** usually solves the mobile retina problem. A blind 4x upscale to 2,400px wastes storage/compute unless users zoom, crop, or you need larger detail views.

### Production pipeline

1. **Fetch original image.** Store source URL, binary hash, perceptual hash, dimensions, MIME, and compression score.
2. **Skip AI when possible.** If source width ≥ target physical pixels, use normal resize, sharpen, AVIF/WebP.
3. **Use cheap interpolation for near-misses.** If a 600px image only needs 700–800px, Lanczos + mild sharpen often beats AI artifacts.
4. **Run AI only when needed.** For 600px → 1,200px, run 2x. For tiny/trashed sources, run 4x then downsample.
5. **Model routing:**
   - Photos/web images: `RealESR General x4v3` or `RealESRGAN_x4plus`.
   - Faces: optional GFPGAN/CodeFormer only when faces are important; Replicate’s upscaling guide also recommends face restoration before upscaling for old photos. citeturn105868view5
   - Anime/illustration: `RealESRGAN_x4plus_anime_6B` or 4x UltraSharp-style models. Real-ESRGAN officially lists separate general/anime variants. citeturn394824search0turn166319search0
6. **Downsample to exact delivery variants.** Save 1x/2x/3x outputs as WebP/AVIF, then let your CDN serve the right one.
7. **Cache aggressively.** Key by `source_hash + model + scale + params`. Never re-upscale the same asset.
8. **Quality gate.** Reject outputs with huge perceptual drift, warped faces, text corruption, or oversharpening.

### Determinism

For deterministic behavior, use **pinned open-source weights + fixed preprocessing + fixed postprocessing**. Real-ESRGAN-style models are a much better fit than Grok for this. Grok Imagine supports image generation/editing, 1k/2k resolutions, and flat per-image pricing, but it is a generative model with moderation and prompt interpretation in the loop. xAI also states generated images are subject to moderation, and edits are charged for both input image and generated output image. citeturn844585view2

### Vercel-specific architecture

Use Vercel for your app/API, metadata, routing, and cache keys. Send image URLs to a worker service rather than pushing binaries through Vercel Functions. Vercel Functions have a 4.5 MB request/response body limit, which is easy to hit after upscaling. citeturn228402search1

Recommended flow:

`Vercel API → queue job → Replicate/fal/self-host GPU worker → store output in S3/R2/Vercel Blob → serve via image CDN`

### My call

For the cheapest “good enough” production path:

**Start with Replicate Real-ESRGAN or fal.ai ESRGAN.**  
Use **RealESR General x4v3 / RealESRGAN_x4plus** as the default.  
Move to **self-hosted Real-ESRGAN** once volume is high enough that $200–$2,000/month in API upscaling becomes material.  
Use **Grok Imagine Edit** only for rare rescue cases where you accept generative changes.

For the 600px → mobile retina case, I’d default to **2x AI upscale**, then generate exact responsive variants from that master.


**Topic:** [[chatgpt-clusters/coding_mobile]]
