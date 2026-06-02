---
title: "Direct Upload to Cloudinary"
type: note
created: 2025-07-08
updated: 2025-07-08
source: chatgpt-export
conversation_id: 686c6691-d4c8-8007-92bc-eb5aae7e0536
message_count: 8
tags: [chatgpt, import]
---
# Direct Upload to Cloudinary

> Conversation ID: 686c6691-d4c8-8007-92bc-eb5aae7e0536
> Created: 2025-07-08T00:30:10Z
> Updated: 2025-07-08T02:51:27Z
> Messages: 8

---

## User

iOS swift app uploads image to supabase. Edge function then send to cloudinary and we get the new optimized image url.

next.js app does similar.

Users can upload or view on either app and data is consistent.

Would we be better to just upload dstraigth to cloudinary?

---

## Assistant

Mr. White:

**Pros of direct‐to‐Cloudinary uploads**  
- Eliminates Supabase storage costs & bandwidth for initial upload  
- Guests get immediate access to Cloudinary’s CDN & on-the-fly transformations  
- Simplifies pipeline: client → Cloudinary → store URL in Supabase  

**Cons**  
- You’ll need signed upload presets on each client (iOS, Next.js)  
- Harder to enforce uniform ACLs or roll back unprocessed images  
- Tighter vendor lock-in; your canonical storage lives outside Supabase  

**Recommendation**  
If your only processing is via Cloudinary and you don’t need Supabase buckets as a fallback or for non-Cloudinary workflows, switch to direct uploads with signed presets and then persist the resulting URL in Supabase. Otherwise, your existing Supabase → edge function → Cloudinary flow gives you a single source of truth and safer rollbacks.

---

## User

Cloudinary wants to charge a lot for background removal it seems. Is there a cheaper solution? A solution we can run on the edge function? Or an on device solution before we uplaod? What are you thoughts 

---

## Assistant

Mr. White:

**1. On-device (iOS / web) removal**  
• **iOS Vision + Core ML** – Use Apple’s built-in person segmentation (e.g. `VNGeneratePersonSegmentationRequest`) or ship a Core ML U²-Net model. 100% free, runs on the device pre-upload, no extra infra cost.  
• **Browser (Next.js) with TF.js BodyPix or ONNX U²-Net WASM** – Run segmentation in the user’s browser, composite out the background client-side, then upload PNG/WEBP with alpha. Zero server cost beyond your CDN.

**2. Self-hosted edge function**  
• **ONNX Runtime Web (WASM) in Supabase Edge** – Bundle a U²-Net ONNX model in your Deno/Node edge function, run inference on upload, composite and return a transparent image URL. Only the edge-function CPU time––no per-image fees.  
• **Lightweight container (e.g. Fly.io)** – Deploy a tiny Python “rembg” service (uses U²-Net) for ~$7/month. Your edge function proxies to it; you pay a flat VM fee, not per-call.

**3. Low-cost 3rd-party**  
• **Replicate.com** – Cheap pay-per-use segmentation models (~$0.03/image), runs in a Vercel Edge Function.  
• **PhotoRoom API** – Often undercut Cloudinary on volume pricing (check tiers).

> **Recommendation:**  
If you want zero per-image fees and have GPU-free edge limits, ship on-device/WebAssembly segmentation. If you’d rather centralize, spin up a rembg/U²-Net microservice on Fly.io or DigitalOcean App Platform for a fixed monthly fee and call it from your edge function.

---

## User

What would be the performance hit if the user bulk uploads photos

---

## Assistant

Mr. White:

Bulk uploads multiply whatever per-image segmentation cost you have. Rough numbers:

- **On-device (iOS Vision/Core ML)**  
  • `VNGeneratePersonSegmentationRequest` on an iPhone 13 at 256–512px runs in ~60 ms/image citeturn1view0.  
  • 10 images ≈ 600 ms of CPU work (plus a bit of overhead to queue and thread it).  

- **In-browser (TensorFlow.js BodyPix)**  
  • BodyPix v2 hits ~21 fps on an iPhone X (~47 ms/image) citeturn2view0.  
  • 10 images ≈ 470 ms of JS/WASM inference (likely more on slower devices or larger resolutions).  

- **Edge function (WASM ONNX U²-Net)**  
  • U²-Net† runs ~25 ms on a high-end GPU for 320×320 inputs; expect 5×–10× slower in a CPU-only WASM environment (≈125–250 ms/image) citeturn3view0.  
  • 10 images ≈ 1.25–2.5 s of pure compute—plus I/O and JS overhead—which can approach (or exceed) typical edge-function timeouts.  

**UX and system implications**  
- **Latency** scales linearly with N. If users pick 20–50 photos at once, on-edge processing could jump into many seconds.  
- **Concurrency**: Don’t blast all images at full speed—throttle to 2–4 in flight to avoid CPU spikes and memory thrash.  
- **Timeout risk**: Supabase Edge and many FaaS limits sit around 5–10 s. For large batches, consider queuing + background processing (e.g. enqueue jobs in a DB and have a separate batch worker).  
- **Progress UI**: Show per-image progress so users aren’t staring at a frozen “Uploading…” screen.  

**Bottom line**:  
- For up to ~10 pics, on-device or in-browser pre-processing will feel nearly instant.  
- At scale (20+), shift heavy lifting off the request path—either chunk & queue on-edge or do it entirely client-side.

---

## User

Okay so how should we handle the rest of processing? Content aware corpping so the images perfectly line up with each other? Basic color and lighting adjustments to make them uniform? Converting to web and optimizing? Should we do bg on device and the rest in cloudinary? Or is there a better option?

---

## Assistant

Mr. White:

**Recommended pipeline**  
1. **Background removal on-device**  
   - iOS: Core ML/person segmentation or your U²-Net Core ML model  
   - Web: BodyPix or ONNX U²-Net in WASM  
   → Upload a clean PNG/WebP with alpha.  
2. **Upload to Cloudinary**  
   - Store that alpha image as your “original.”  
3. **Transform via URL**  
   - **Content-aware cropping**: `c_thumb,g_auto,w_<width>,h_<height>`  
   - **Auto color/lighting**: `e_auto_color,e_auto_brightness`  
   - **Format/quality**: `f_auto,q_auto`  
   → Cloudinary will center on the subject, normalize tones, convert to WebP, and optimize delivery on-the-fly.  

**Why this works**  
- Moves heavy segmentation off your servers/FaaS  
- Leverages Cloudinary’s free transformation layer (no extra compute fees)  
- Ensures every upload ends up uniform—perfect alignment, consistent color, minimal payload  

---

**Alternative all-in-house**  
- **Supabase Edge + Sharp**  
  1. Client → Supabase bucket raw upload  
  2. Edge function (Node/Deno) uses `sharp` + open-source U²-Net JS for segmentation, crop, color adjust, WebP  
  3. Store final in Supabase and serve via Supabase CDN  
- Pros: zero Cloudinary fees, full control  
- Cons: you manage model updates, scaling, and CORS/security  

---

**Bottom line**  
– If you’re happy with Cloudinary’s CDN & transformations, do bg removal on-device and let Cloudinary handle the rest.  
– If you need zero vendor fees, build a Sharp-based microservice in your edge function.


## See Also
- [[chatgpt/chatgpt_100-mbps-upload-options]]
- [[chatgpt/chatgpt_avatar-upload-optimization]]
- [[chatgpt/chatgpt_avatar-upload-spec]]
- [[chatgpt/chatgpt_chrome-extension-upload-error]]
- [[chatgpt/chatgpt_file-upload-error-troubleshoot-part1]]
