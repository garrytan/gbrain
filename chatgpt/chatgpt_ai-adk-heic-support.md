---
title: "AI ADK HEIC Support"
type: guide
created: 2026-02-19
updated: 2026-02-19
source: chatgpt-export
conversation_id: 69977b0e-e624-832b-9d63-8b623595a642
message_count: 4
tags: [chatgpt, import, code]
---
# AI ADK HEIC Support

> Conversation ID: 69977b0e-e624-832b-9d63-8b623595a642
> Created: 2026-02-19T21:05:25Z
> Updated: 2026-02-19T21:08:51Z
> Messages: 4

---

## User

ai adk accept heic images

---

## Assistant

Yes, **AI ADK (Agent Development Kit)** can accept **HEIC images**, but support depends on the specific implementation and backend configuration.

### Key Points

- **HEIC (High Efficiency Image Container)** is supported natively on Apple devices.
- Many AI SDKs (including Google’s and OpenAI-based stacks) internally convert images to:
  - JPEG  
  - PNG  
  - WebP  

If you’re passing images into an ADK pipeline:

### 1️⃣ Direct Upload
Some environments automatically decode HEIC. Others will fail unless:
- `libheif` (Linux)
- macOS native decoder
- ImageMagick with HEIC support  
is installed.

### 2️⃣ Best Practice (Recommended)
Convert HEIC → JPEG before sending to the model.

Example (Python):
```python
from PIL import Image
import pillow_heif

pillow_heif.register_heif_opener()

img = Image.open("image.heic")
img.save("image.jpg", "JPEG")
```

### 3️⃣ Cloud Model APIs
Many cloud vision APIs do **not officially list HEIC as supported**, even if it sometimes works.

---

### Bottom Line
- ✔ Sometimes works  
- ⚠ Not universally supported  
- ✅ Safest approach: convert to JPEG/PNG before sending  

If you tell me which ADK (Google, OpenAI, custom agent framework, etc.), I’ll give you the exact compatibility answer.

---

## User

using ai sdk and vercel ai gateway. i want to optimize for the best UX. i need users to understand the image is being uplaoded etc and i need to support images openly without rejected them. bad ux.

---

## Assistant

Mr. White — here’s the cleanest way to design this for **best UX** using the **Vercel AI SDK + AI Gateway**.

You want 3 things:

1. No image rejections  
2. Clear upload state feedback  
3. Reliable cross-device support (HEIC included)  

---

## 🔥 UX Strategy (What Actually Works)

### 1️⃣ Accept Everything → Normalize Immediately

Do **not** reject HEIC client-side.

Instead:

- Accept: `image/*`
- Immediately convert to JPEG in the browser
- Then send to Gateway

This prevents:
- iPhone HEIC upload failures
- Model-side decoding errors
- Random 400s from providers

Use client-side conversion via `heic2any`.

```bash
npm install heic2any
```

Example:

```ts
import heic2any from "heic2any"

async function normalizeImage(file: File) {
  if (file.type === "image/heic" || file.name.endsWith(".heic")) {
    const blob = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.9,
    })
    return new File([blob as Blob], file.name.replace(".heic", ".jpg"), {
      type: "image/jpeg",
    })
  }

  return file
}
```

Now everything hitting your AI SDK is JPEG/PNG.

That alone removes 90% of “bad UX”.

---

## 2️⃣ Upload State Feedback (Critical)

You need 4 visible states:

- Idle
- Uploading
- Processing (AI thinking)
- Done

### Recommended UX Flow

When user selects image:

**Immediately show preview**
→ Show spinner overlay
→ Show “Uploading image…”
→ Switch to “Analyzing image…” after upload completes

Example UI state logic:

```ts
const [status, setStatus] = useState<
  "idle" | "uploading" | "processing" | "done"
>("idle")
```

Before conversion:
```
setStatus("uploading")
```

After sending to AI:
```
setStatus("processing")
```

After response:
```
setStatus("done")
```

---

## 3️⃣ Stream the AI Response (Feels Instant)

With Vercel AI SDK:

```ts
const { messages, input, handleSubmit, isLoading } = useChat({
  api: "/api/chat",
})
```

Tie `isLoading` to your “Analyzing image…” state.

Streaming removes the “dead air” feeling.

---

## 4️⃣ Don’t Block Large Files — Compress Instead

iPhone images = 3–8MB.

Bad UX = “File too large.”

Instead:

- Resize to max width 1600px
- Compress to ~0.8 quality

Example (client-side):

```ts
const canvas = document.createElement("canvas")
const ctx = canvas.getContext("2d")
```

Use canvas scaling before upload.

---

## 5️⃣ Gateway Side (Important)

When using AI Gateway:

- Send image as base64 OR
- Upload to blob storage (Vercel Blob / S3) and send URL

**Best UX pattern:**

Upload image to Vercel Blob first  
→ Get URL  
→ Send URL to model  

This makes retries instant and prevents re-uploads.

---

# 🧠 Ideal UX Flow (What Feels Premium)

1. User drops image
2. Immediate preview
3. Subtle animated progress bar
4. Text: “Uploading…”
5. Switch to: “Analyzing image…”
6. Stream response
7. Keep image pinned in chat history

Zero rejection.
Zero confusion.
No silent failures.

---

# ⚠ Important Reality

Most models behind AI Gateway do NOT officially support HEIC.

So the correct solution is:

> Accept everything → Normalize to JPEG client-side → Never let the model see HEIC.

---

If you’d like, I can give you:

- A full production-ready React dropzone component  
- A clean UX loading pattern used in top AI apps  
- Or a minimalistic founder-style UI optimized for speed  

What stack are you using? Next.js App Router?


## See Also
- [[chatgpt/chatgpt_best-car-lumbar-support-2]]
- [[chatgpt/chatgpt_best-car-lumbar-support-3]]
- [[chatgpt/chatgpt_best-car-lumbar-support]]
- [[chatgpt/chatgpt_carplay-support-for-chatgpt]]
- [[chatgpt/chatgpt_clerk-nextjs-16-support]]
