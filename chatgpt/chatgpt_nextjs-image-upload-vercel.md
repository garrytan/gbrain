---
conversation_id: 68d7422b-561c-8320-91d7-36e6aad7fbf5
created: 2025-09-27
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Next.js image upload Vercel
type: note
updated: 2025-09-27
---

# Next.js image upload Vercel

> Conversation ID: 68d7422b-561c-8320-91d7-36e6aad7fbf5
> Created: 2025-09-27T01:47:40Z
> Updated: 2025-09-27T01:48:14Z
> Messages: 2

---

## User

Is it possible to have next.js accept image uploads to vercel blob storage?

---

## Assistant

Yes, Mr. White—totally possible. Vercel Blob is built for this and works great with Next.js.

**Two common patterns**

1) **Server upload (simple)**
- Form posts to a Next.js Route Handler; you `put()` the file to Blob and return the URL.
```ts
// app/api/upload/route.ts
import { put } from '@vercel/blob';

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get('file') as File;
  const blob = await put(file.name, file, { access: 'public', addRandomSuffix: true });
  return Response.json({ url: blob.url });
}
```
Docs + example use `@vercel/blob` with Route Handlers. citeturn0search1turn0search10turn0search7

2) **Direct client upload (best for big files/progress)**
- Client requests a short-lived token from your API, then uploads straight from the browser to Blob (skips your server bandwidth).
```ts
// client
import { upload } from '@vercel/blob/client';
await upload(file.name, file, { access: 'public', handleUploadUrl: '/api/upload' });

// /api/upload route just returns the token (docs pattern)
```
Guide + sample code here. citeturn1search7

**Set-up**
- In Vercel → *Storage* → create/connect a **Blob store**; Vercel injects the token env var for read/write. citeturn1search4

**Serving images**
- Returned URLs are on `*.public.blob.vercel-storage.com`. You can use `next/image` (allow the host in `remotePatterns`). citeturn1search13

**Limits & behavior (useful for images)**
- Max file size: **5 TB**; multipart/resumable supported (useful >100 MB). Cache applies up to **512 MB** per blob. GA announcement + limits. citeturn0search8turn0search0

**Security caveat (important)**
- Today, blobs are **public-by-default**; there isn’t a “private + signed URL” mode yet. Mitigate by using `addRandomSuffix: true` and storing URLs in your DB; if you need true private media, use S3/GCS with presigned URLs. citeturn1search14turn1search6turn1search3

**Pricing/ops**
- See usage & pricing page for storage, ops, and transfer. citeturn0search0

If you want, I can sketch the minimal Next.js page + API route wired for client-side direct image uploads with basic type/size validation.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
