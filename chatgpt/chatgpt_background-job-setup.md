---
title: "Background job setup"
type: essay
created: 2025-12-10
updated: 2025-12-10
source: chatgpt-export
conversation_id: 69392170-f684-832c-a90d-0d69598983a9
message_count: 12
tags: [chatgpt, import, code, long-form]
---
# Background job setup

> Conversation ID: 69392170-f684-832c-a90d-0d69598983a9
> Created: 2025-12-10T07:29:53Z
> Updated: 2025-12-10T07:56:47Z
> Messages: 12

---

## User

Real quick, I'm moving image processing for profile pictures to a background job. Being asked where that job status should live should live on the profile photos table with a new field and the statuses or should it be or should be on a new table and I don't know the answer to that question. Also, how should the background job run? Cron triggered API route, Next.js serverless on-demand or an existing keyworker. We're on Versal. We have Next.js. We have Neon as our database. What's the best way for me to run this? It's basically the process is that the user uploads an image and then I just want that image to be converted to a higher resolution photo. So we're going to show them sorry converted to a better format AVIF or something like that and so I just want to show them I'm going to display the image they uploaded, save it, and then let them be the page in the background. We're going to process the photo and then swap it out in the profile with the new format. So what's the best way for us to use that keyworker or whatever? I'm being asked this question. Are we okay to adjust the API to return processing initially, no file URLs, and rely on the status endpoint for readiness or should we keep the current ready response until the worker's in place? I'm not really sure exactly about that.

---

## Assistant

Short version, Mr. White:

1. **Put status on the `profile_photos` table, not a new jobs table (for now).**  
2. **Run the background work via a worker/cron that reads “pending” rows from Neon.**  
3. **Keep returning a usable image URL from the upload API and add a `processing_status` flag, don’t switch to “no URL until ready”.**

I’ll break it down quickly.

---

## 1. Where should the job status live?

Given your use case (single, simple pipeline per photo: original → AVIF):

**Use the existing `profile_photos` table and add fields:**

- `processing_status` (enum/text): `'pending' | 'processing' | 'ready' | 'failed'`
- `original_url` (string)
- `processed_url` (string, nullable)
- Optionally: `processing_error` (text, nullable)
- Optionally: `last_processed_at` (timestamp)

Why this is enough:

- You effectively have **one logical job per photo**. You don’t need the overhead of a separate jobs table with job IDs, retries, etc.
- The consumer (frontend, other services) only cares about “is this photo ready and where is it?”—that’s best answered directly on the photo row.

When you’d use a separate jobs table:

- If you expect: multiple parallel pipelines, reprocess history, analytics per job, retries, priority queues, etc.

You’re not there right now, so don’t pre-optimize.

---

## 2. How should the background job run on Vercel + Next.js + Neon?

You have three realistic patterns:

### A. Existing worker (“keyworker”) with Neon as the queue source

If you already have a long-running worker process somewhere (Railway/Fly/Docker on a VM/etc.) then:

1. **Upload API route (Next.js on Vercel):**
   - Save file somewhere (S3/R2/Vercel Blob/whatever).
   - Insert `profile_photos` row with:
     - `original_url` set
     - `processed_url = null`
     - `processing_status = 'pending'`
   - Return `original_url` + status (see section 3).

2. **Worker:**
   - Poll Neon: `SELECT * FROM profile_photos WHERE processing_status = 'pending' LIMIT N FOR UPDATE SKIP LOCKED;`
   - For each:
     - Set `processing_status = 'processing'`
     - Fetch original image, convert to AVIF/whatever.
     - Upload result, get `processed_url`.
     - Update row: `processed_url`, `processing_status = 'ready'`, `last_processed_at`.
     - On error: `processing_status = 'failed'` and store `processing_error`.

This is the **cleanest** if you already have infra for a worker. No Vercel time limits to worry about.

### B. Vercel Cron → API Route → Neon

If you don’t want another service:

1. Configure a **Vercel cron job** that hits `/api/process-profile-photos` every 1–5 minutes.
2. That API route:
   - Grabs a small batch of `pending` rows from Neon.
   - Processes them exactly like the worker above.
3. Latency to “ready” is typically under the cron interval (1–5 minutes) which is fine for a background profile photo conversion.

For “user uploads → sees original → a minute later it’s upgraded”, this is usually plenty.

### C. “On-demand” route immediately after upload

If the conversions are very cheap and fast:

- You can just do it inline in the same API request or fire an **on-demand processing route** from the client after upload.
- But you said you’re explicitly moving this to a background job, so I’d go with **A or B** above.

**My recommendation:**  

- If the “keyworker” exists and is reliable → **use it** with Neon as the queue source (option A).  
- If not → **Vercel Cron hitting a processing route** is the simplest, low-friction setup (option B).

---

## 3. API contract: what should the upload endpoint return?

You asked:

> Are we okay to adjust the API to return `processing` initially, no file URLs, and rely on the status endpoint for readiness or should we keep the current ready response until the worker's in place?

I would **not** remove file URLs from the response.

**Do this instead:**

**Upload response shape (now and in the future):**

```json
{
  "photoId": "123",
  "originalUrl": "https://.../original.jpg",
  "processedUrl": null,
  "processingStatus": "pending"
}
```

Then, after processing finishes, the row is:

```json
{
  "photoId": "123",
  "originalUrl": "https://.../original.jpg",
  "processedUrl": "https://.../photo.avif",
  "processingStatus": "ready"
}
```

Frontend logic:

- Immediately display `originalUrl` so the user sees what they just uploaded.
- Poll your `GET /profile-photos/:id` (or similar) endpoint every X seconds for `processingStatus`.
- When `processingStatus === 'ready'`, switch to `processedUrl` (or, if you keep URL stable, invalidate and re-fetch the same URL).

This gives you:

- **No breaking change** for existing behavior: you still provide a usable image URL right away.
- A clear path for the worker: it simply fills in `processedUrl` and flips `processingStatus`.

If you really want a dedicated status endpoint, it can be a thin wrapper around the same table, but it’s often unnecessary if your normal “get profile”/“get profile photo” API already returns those fields.

### Migration strategy

1. **Add the new columns** (`processing_status`, `processed_url`, etc.) on `profile_photos`.
2. In the existing synchronous flow (until the worker is running):
   - Set `processing_status = 'ready'`.
   - Set `processed_url = original_url` or set both to the same thing.
3. Once the worker is live:
   - New uploads: write `processing_status = 'pending'`, only `original_url`.
   - Worker updates to `ready` + `processed_url`.
   - The API response shape doesn’t change; only the values do.

So to answer your last question very directly:

- **No**, don’t switch to “processing only, no URLs”. That hurts UX and complicates clients.
- **Yes**, you should keep the current “ready-style” response structure, but extend it with `processingStatus` and (eventually) `processedUrl`.
- Start marking new uploads as `pending` once the worker is in place; until then, mark them `ready` and keep the behavior identical.

If you want, I can sketch a tiny TypeScript schema + an example Next.js route for uploads and the worker/cron handler.

---

## User

Well, I don't necessarily need it to be a background job. I just need it to be non-UX blocking. I want it to happen immediately.

---

## Assistant

Gotcha, that helps a lot.

If you just need it to feel non-blocking to the user but you *want the processing to happen right away*, then you actually don’t need a “background job system” at all.

Let’s zoom in on what you really care about:

- User should **see their uploaded image instantly**
- Conversion to AVIF (or whatever) should **happen right away**
- You’re on **Next.js + Vercel + Neon**

---

## Option 1 (my strong recommendation): don’t pre-convert, let Next/Vercel do it on the fly

Given your stack, the simplest and most robust approach is:

1. **Store only the original image** (JPEG/PNG) when they upload.
2. **Serve it through Next.js `<Image>` (with the built-in optimizer)** and let Vercel handle AVIF/WebP generation + caching.

Roughly:

```tsx
<Image
  src={user.profilePhotoUrl} 
  alt="Profile photo"
  width={256}
  height={256}
  // Next.js 14: you can configure formats in next.config
  // and Vercel will serve AVIF/WebP automatically when supported
/>
```

- Browsers that support AVIF/WebP get those formats.
- It’s “immediate” in the sense that first request triggers optimization, then it’s cached.
- **No background job, no status fields, no extra tables**.
- Neon only stores `original_url` (and maybe some metadata). That’s it.

If your only goal is “serve a more efficient format to users”, this is **by far** the cleanest architecture.

---

## Option 2: do the conversion in the upload API (synchronous but non-UX blocking)

If you *really* want a physical AVIF file stored in your bucket and referenced in the DB:

### UX flow

1. User selects image → you **immediately show a local preview** using `URL.createObjectURL(file)` on the client.
2. You `fetch("/api/profile-photo", { method: "POST", body: FormData(...) })`.
3. While the API is running, show a subtle “Saving…” or spinner on the button, but the user *already sees* their preview, so UX isn’t “blocked” in the annoying sense.
4. When the API responds, you update your React state with the canonical `processedUrl`.

### API route flow (Next.js route handler)

1. Receive the file.
2. Upload **original** to storage.
3. Use something like `sharp` (Node.js runtime) to convert to AVIF.
4. Upload the AVIF to storage.
5. Write to Neon:
   - `original_url`
   - `processed_url`
6. Return response:

```json
{
  "photoId": "123",
  "originalUrl": "https://.../original.jpg",
  "processedUrl": "https://.../photo.avif"
}
```

### Schema

You don’t really need job statuses now:

- `profile_photos`:
  - `id`
  - `user_id`
  - `original_url`
  - `processed_url`
  - `created_at`

You can skip `processing_status` entirely if you always do the work in the same request and you’re okay with the user waiting ~0.5–2s for the “Save” to complete.

---

## So what about the earlier questions (status fields, workers, etc.)?

Given your updated requirement:

- **You do *not* need a `processing_status` field or a jobs table** if you go with Option 1 (on-the-fly optimization) or Option 2 (synchronous conversion).
- **You do *not* need a background worker or cron** unless:
  - Conversion is expensive/slow, or
  - You want to reprocess at scale later (e.g., change all images to a new format).

On Vercel, for “immediate but non-UX blocking”:

- **Best DX / simplest infra:**  
  Use **Next.js Image Optimization (Option 1)** and store only originals.
- **Second-best:**  
  Do conversion **inside the upload route** (Option 2) and just make sure the frontend shows a preview instantly.

If you tell me whether you’re already using Next’s `<Image>` / Vercel’s optimizer or a custom storage CDN (S3 + CloudFront, Cloudflare Images, etc.), I can sketch the exact code path for your current setup.

---

## User

I mean, the goal is to only is to get the profiles loading in under 100 milliseconds. That's our promise to users, and that's what we want. So, um, would you still recommend doing, uh, to not pre-convert and let NextVersal do it on the fly?

---

## Assistant

Short answer, Mr. White:  

With a *hard* “profiles load in \<100ms” goal, I would **not** rely on on-the-fly Next/Vercel optimization for avatars. I’d **pre-convert at upload (or immediately after)** so profile requests only ever hit a CDN URL, not an image transformer.

---

### 1. What 100ms actually can and can’t cover

You realistically can guarantee:

- **TTFB / API response \<100ms** for `/profile/:id`  
- **HTML + JSON render \<100ms** on the server

You cannot reliably guarantee (on arbitrary networks):

- “Avatar image downloaded + decoded” in \<100ms

So architect for:

- Profile API/HTML is fast.
- Avatar is a **small, optimized static asset** behind a CDN, so perceived load is very fast and doesn’t block the main profile logic.

---

### 2. Why I’d *not* use on-the-fly optimization here

Vercel’s image optimizer is great, but:

- On **first request per variant**, it does a real transform (CPU, I/O) and then caches. That first miss can blow your 100ms budget on a cold path.
- Your 100ms promise sounds more like “even cold, this profile is snappy,” not “after warm-up.”

So:

- For marketing sites, on-the-fly is fine.
- For a **hard performance SLA on a core feature**, I’d instead **pre-bake** the asset so serving the profile never invokes any heavy code.

---

### 3. Recommended flow given your goal

#### Upload path (where the work happens)

1. **Client:**
   - User picks a file → show **local preview** immediately (`URL.createObjectURL(file)`).
   - POST file to `/api/profile-photo`.

2. **API handler (Next.js Route Handler / App Router):**
   - Store original in bucket (S3/R2/Vercel Blob/etc.).
   - Use `sharp` or similar to:
     - Resize/crop to your avatar dimensions.
     - Convert to AVIF/WebP (and maybe fallback JPEG).
   - Upload processed result(s) to bucket.
   - Write to Neon:
     - `avatar_url` (the **processed** CDN URL)
     - Optionally also `original_url` for archival/debug.

3. **API response:**

   ```json
   {
     "photoId": "123",
     "avatarUrl": "https://cdn.yourapp.com/avatars/123.avif"
   }
   ```

   The user has already seen a preview; this response just updates the canonical URL in state.

Now all heavy image work is **off** the profile-viewing path.

#### Profile read path (what must be \<100ms)

1. `/api/profile/:id` or page load:
   - Fetch profile from Neon (fast).
   - Return JSON/HTML including `avatarUrl` (already processed).

2. Client / SSR:
   - Render `<img src={avatarUrl} ...>` or `<Image src={avatarUrl} unoptimized />` (if you want to skip Vercel’s optimizer and let CDN do the work).
   - Avatar is just a static asset from the CDN: TTFB is tiny, no transform, fits your performance story.

**No job table, no status fields needed**, because processing is done before the profile ever references that image.

---

### 4. Where background / async *might* still appear

Only if either of these become true:

- Conversion sometimes takes long enough to make the upload request feel bad (>2–3 seconds), or
- You later want to reprocess existing images in bulk (new sizes/format).

Then you’d:

- Keep the same “preconverted before use” principle, but
- Offload the conversion to a worker/cron and use a `processing_status` on the photo row.

Right now, with your goals, I’d start **simple**:

- **Pre-convert synchronously in the upload API.**
- Store only **processed CDN URLs** on the profile.
- Serve them directly on profile load—no on-the-fly transforms on the read path.

That’s the most straightforward way to respect your \<100ms promise.

---

## User

This transcript contains references to ChatGPT, OpenAI, DALL·E, GPT-4, and GPT-5. We're already using SHARP.

---

## Assistant

Understood, Mr. White — **you’re already using Sharp**, which means you’re in the *ideal position* to satisfy all your constraints **without any job queues or status tables**.

Given:

- You want **sub-100ms profile loads**
- You want true **pre-converted static avatar assets**
- You already use **Sharp for image conversion**
- You do **not need UX blocking**
- You do **not need delayed or cron jobs**

…the cleanest architecture is:

# ✅ **Final Recommendation**

### **Convert synchronously during upload, return the processed URL, store only that processed URL on the profile.**
No background job. No polling. No status tracking. No delayed worker.  
Everything important happens *at the moment of upload*.

---

# 🧩 Why This Is Correct for Your SLA

### **On the read path (profile load)**
- You read the user profile row from Neon (**fast**)  
- You render a pre-converted static CDN URL (**no CPU, no transform**)  
- The CDN serves the image like a static file  
- Your 100ms SLA now only competes with:
  - Neon read (~5–20ms)
  - HTML/JSON serialization
  - SSR / client render
- **No dynamic image processing is happening at read time** → exactly what you need.

### **On the write path (upload)**
- This is where Sharp should do ALL the work
- This can take 200ms–2000ms, who cares — it’s not part of profile viewing
- User already sees a local preview on the client, so UX is not blocked

---

# 🧱 Minimal Schema

You don’t need job metadata:

```
profile_photos:
  id
  user_id
  avatar_url        -- processed CDN URL
  original_url      -- optional
  created_at
```

**`avatar_url` is always ready**  
No statuses. No async transitions. No new tables.

---

# ⚙️ Upload API (ideal flow)

1. Client picks a file → immediately shows local preview (`URL.createObjectURL`)
2. POST file to `/api/profile-photo`
3. Inside the route:
   - Store original in bucket (if you want)
   - Use Sharp:
     - Resize, crop, optimize
     - Convert to AVIF/WebP/JPEG fallback
   - Upload processed asset to CDN
   - Write `avatar_url` to DB
4. Respond:

```json
{
  "avatarUrl": "https://cdn.yourapp.com/avatars/user123.avif"
}
```

5. Frontend replaces local preview with the canonical `avatarUrl`

---

# 🧨 Why You Should **Not** Use Vercel On-The-Fly Optimization Here

Even though Next/Vercel optimization is excellent, it has one killer downside for your SLA:

> **the first request of each image variant is a compute-bound transform before caching**

That first request **can easily exceed 100ms**, even if later requests are fast.

For a consumer app that promises a **<100ms profile page**, you can’t afford that cold path.

With pre-converted static CDN URLs:

- There is **no cold transform**
- Worst-case cold path cost is CDN cache fill (~10–40ms), not CPU image work
- Your core SLA remains clean

---

# 💡 When You Might Reconsider Background Jobs

Only later if:

1. You want to **reprocess user avatars at scale** (new format, improved pipeline)
2. Sharp conversions sometimes take too long during upload and you want to make uploads snappier

Then you’d:

- Temporarily store `pending` status
- Defer processing
- Worker fills `avatar_url`
- Frontend polls

But **you don’t need any of that today** to hit your performance target.

---

# 🏁 Bottom Line

For a product guaranteeing **very fast profile loads**, the winning approach is:

> **Do Sharp conversion synchronously at upload → store only pre-optimized CDN URLs → never transform on read.**

You already have Sharp, so you’re 90% of the way there.

No queues, no cron, no workers, no status flags, no schema complexity.

This gives you the **maximum runtime performance with the minimum architectural overhead**.

---

## User

{'asset_pointer': 'sediment://file_00000000e41871fd83a6e2ec330a6488', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 3811964, 'width': 1152}

---

## Assistant

Mr. White — based on what I see in the screenshot, here’s the clean, **non-breaking**, production-safe answer that hits your <100ms profile target and keeps your current API shape sane:

---

# ✅ **How to store variants on `profile_photos`**

### **Do NOT create tons of columns like `avif_large`, `jpeg_medium`, etc.**  
That explodes schema complexity and breaks easily if you ever change sizes or formats.

### **Best schema (simple, scalable, non-breaking):**

```
profile_photos
  id
  user_id
  original_url         (optional archival)
  avatar_url           (processed default format/size)
  all_urls_json        (JSON, optional: { size: { format: url } })
  created_at
```

#### Meaning:
- **`avatar_url`** = the canonical processed URL your product uses everywhere (AVIF/WebP/JPEG fallback).
- **`all_urls_json`** = a JSON blob you only care about if you ever need variants later. It doesn’t break anything and doesn’t clutter the table.

This gives you **maximum forward flexibility** and keeps the primary path dead simple.

---

# ⚙️ **Which formats/sizes do you actually store?**

Given your 100ms goal:

- **Store exactly ONE canonical avatar on write**:
  - Pre-baked with Sharp → AVIF (or WebP fallback only if you detect incompatibility)
  - Resize to your standard avatar dimension (e.g., 256×256 or 512×512)

This means:

- **No transforms at read time**
- **No size negotiation**
- **No need for multiple processed sizes** unless product requirements demand it later

If later you want responsive sizes or multiple pixel densities, that goes inside the JSON blob — no schema churn.

---

# 📨 **POST Upload API Response**

Keep it **simple + non-breaking**:

```json
{
  "photoId": "123",
  "avatarUrl": "https://cdn/.../avatar.avif"
}
```

That is enough.

If you want debug/advanced usage:

```json
{
  "photoId": "123",
  "avatarUrl": "https://cdn/.../avatar.avif",
  "all": {
    "256": {
      "avif": "...",
      "jpeg": "..."
    }
  }
}
```

…but keep that **optional**, not required.

---

# 🧠 **Why this beats all other approaches**

### **Schema stays stable**
- Adding variants = add to JSON, not new columns
- Removing formats = remove from JSON, not migrations

### **Product stays simple**
- Everywhere in the app uses **`avatar_url`**
- No client logic to pick formats or negotiate sizes
- You can swap your processing pipeline anytime without migrations

### **Performance guarantee**
- Profile reads return only a **single preprocessed CDN URL**
- Zero transform at read time
- Always fast, always cacheable, always <100ms

---

# 🛠 **Implementation notes**

- Use Sharp:
  - Strip metadata
  - Convert to sRGB
  - Pre-resize to standard avatar dimensions
  - Convert to AVIF with sane defaults
- Upload only the processed file
- Write `avatar_url` to DB
- Return it in the POST response

**Synchronous is fine** because upload UX is not blocking — user sees local preview already.

---

# ⭐️ **TL;DR (Correct Architecture)**

**Table:**

- `avatar_url` (canonical)
- `all_urls_json` (optional future-proofing)
- `original_url` (optional archival)

**Pipeline:**

- Synchronous Sharp during upload
- Pre-bake one canonical avatar URL
- Store that URL directly
- Serve it directly to profile views **with no runtime transforms**

**Response shape:**

```json
{
  "avatarUrl": "https://cdn/.../avatar.avif"
}
```

This is the cleanest option with zero breakage, zero API complexity, and perfect read-path performance.

---

## User

{'asset_pointer': 'sediment://file_000000006a4071f891983cd6e3c7ec5c', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 3641310, 'width': 1152}

---

## Assistant

Mr. White — **here is the clean, correct confirmation** for what you should do, without any ambiguity:

---

# ✅ 1. **Canonical Column to Use**

> **Yes — use `avatarUrl` as the canonical processed-image column.**

That is the single URL your app will always read for profile rendering.

### **For backwards compatibility:**

If you currently have any legacy columns such as:

- `blobUrl`
- `largeUrl`
- `mediumUrl`
- `smallUrl`

…then **set all of them equal to the same processed AVIF URL** during upload, for now.

This guarantees:

- No breaking change
- No client logic refactor required
- All read paths see the same optimized CDN URL

Later, when old columns are no longer needed, you can safely remove them via migrations.

---

# ✅ 2. **Whether to Persist a JSON Map of Variants**

> **Optional, not required — but if you want to store a JSON blob, do it only for future-proofing, NOT as the main read path.**

Recommended JSON field name:

```
allUrls
```

or

```
all_urls_json
```

I prefer **`allUrls`** because:

- Short
- Intuitive
- Fits Drizzle/TypeScript well

### Structure example:

```json
{
  "512": {
    "avif": "https://cdn/.../avatar-512.avif",
    "jpeg": "https://cdn/.../avatar-512.jpeg"
  }
}
```

This field is **purely optional**, and **does not affect runtime performance**, because:

- The app **does not read from it**
- It’s purely metadata and future flexibility
- You only ever read from `avatarUrl`

---

# ⭐️ Final Confirmation (what you asked me to confirm)

✔ **Use `avatarUrl` as the canonical column**  
✔ Also set **all legacy `blobUrl`/`largeUrl`/etc. to the same processed AVIF URL for compatibility**  
✔ If you want JSON metadata, persist it in a field named `allUrls`  
✔ The JSON field should *not* be required for rendering or API responses — only optional

---

# 🧠 Why this is the correct choice

- **Profiles load fastest** — one CDN URL, zero runtime transforms
- **No schema explosion**
- **No breaking changes**
- **Removing legacy columns becomes trivial**
- **Adding new variants later is trivial and safe (only update JSON)**

---

If you want, Mr. White, I’ll now also tell you **exact TS + Drizzle migration definitions**, so there’s zero ambiguity on implementation.
