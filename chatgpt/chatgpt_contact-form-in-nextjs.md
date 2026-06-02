---
title: "Contact form in Next.js"
type: note
created: 2025-09-23
updated: 2025-09-23
source: chatgpt-export
conversation_id: 68d2c058-6aa0-8323-b140-6e3bf8b65349
message_count: 2
tags: [chatgpt, import, code]
---
# Contact form in Next.js

> Conversation ID: 68d2c058-6aa0-8323-b140-6e3bf8b65349
> Created: 2025-09-23T15:44:25Z
> Updated: 2025-09-23T15:45:38Z
> Messages: 2

---

## User

Can we have a contact form in next js that emails me? How would this work on vercel with minimal effort

---

## Assistant

Yes, Mr. White. Two fastest paths:

## 0-click backend (fastest)
Use a hosted form-to-email service (no code on your server):
- **Formspree**, **Basin**, or **Tally** → paste their `<form action="...">` URL, done.
- Pro: zero backend, deploy instantly. Con: small monthly fee / branding unless paid.

## Minimal code on Vercel (still simple)
Use a Next.js route handler + **Resend** (best DX on Vercel).

### 1) Install & env
```bash
npm i resend
```
Add **VERCEL env vars** (Project → Settings → Environment Variables):
- `RESEND_API_KEY=...`
- `CONTACT_FROM=Contact <contact@your-verified-domain.com>`
- `CONTACT_TO=you@gmail.com`

(Verify your domain in Resend dashboard once; one-time.)

### 2) API route (App Router)
`app/api/contact/route.ts`
```ts
import { Resend } from "resend";
import { NextResponse } from "next/server";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: Request) {
  try {
    const { name = "", email = "", message = "" } = await req.json();
    if (!email || !message) {
      return NextResponse.json({ ok: false, error: "Missing fields" }, { status: 400 });
    }
    await resend.emails.send({
      from: process.env.CONTACT_FROM!,
      to: process.env.CONTACT_TO!,
      subject: `New contact from ${name || "Anonymous"}`,
      reply_to: email,
      text: `From: ${name} <${email}>\n\n${message}`,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "Send failed" }, { status: 500 });
  }
}
```

### 3) Form
`app/contact/page.tsx`
```tsx
"use client";
import { useState } from "react";

export default function ContactPage() {
  const [status, setStatus] = useState<"idle"|"ok"|"err">("idle");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = {
      name: (form.elements.namedItem("name") as HTMLInputElement).value,
      email: (form.elements.namedItem("email") as HTMLInputElement).value,
      message: (form.elements.namedItem("message") as HTMLTextAreaElement).value,
    };
    const res = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setStatus(res.ok ? "ok" : "err");
    if (res.ok) form.reset();
  }

  return (
    <form onSubmit={onSubmit} className="max-w-md space-y-3">
      <input name="name" placeholder="Name" className="w-full border p-2 rounded" />
      <input name="email" type="email" placeholder="Email" required className="w-full border p-2 rounded" />
      <textarea name="message" placeholder="Message" required className="w-full border p-2 rounded h-32" />
      <button className="w-full border p-2 rounded">Send</button>
      {status==="ok" && <p>Sent. I’ll reply soon.</p>}
      {status==="err" && <p>Couldn’t send. Try again.</p>}
    </form>
  );
}
```

### 4) Deploy on Vercel
- Push to GitHub; connect repo in Vercel.
- Add env vars to **Production** (and **Preview** if needed), then redeploy.
- Test the form → you receive an email.

### Notes
- **Why Resend?** SMTP (Nodemailer) is flaky on serverless + Gmail blocks; Resend is API-first and works great on Vercel.
- If you want zero code: go with **Formspree**/**Basin** today, switch to the Resend route later with no UX change.
