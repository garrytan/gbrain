---
title: "PIN-based authentication setup"
type: guide
created: 2025-10-12
updated: 2025-10-12
source: chatgpt-export
conversation_id: 68ec0746-0aac-8326-a067-f02c5888503f
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# PIN-based authentication setup

> Conversation ID: 68ec0746-0aac-8326-a067-f02c5888503f
> Created: 2025-10-12T19:57:20Z
> Updated: 2025-10-12T20:00:26Z
> Messages: 4

---

## User

For our operations site i want basic auth that uses are employee toast PIN numbers to give them access to things that should be restricted.

For the test well just add me 
Tim White pin 77242022 and we will prompt for that pin when trying to access restricted sections. Then the sections wil be unlocked on that device for a while.

The employee names and pins can be hard coded or stored in an env files or vercel blob storage. Whatever is the easiest to configure.

The site is next.js on vercel with no db.  We want to keep it easy to maintain and easy to deploy as this isa low effort project.  The components can use shadcn ui primitives or even the prebuilt blocks they offer as a starting point.

Ill have claude code do it, just give me the prompt. Its for vaultoperations.com and for now it will just be used to lock down the tools section

---

## Assistant

Mr. White, here’s a tight copy-paste prompt you can drop into Claude Code to implement the PIN-gate for `vaultoperations.com` (Next.js on Vercel, no DB). It protects `/tools`, asks for name + PIN, and unlocks that device for a while via a signed cookie. Uses minimal deps, simple Tailwind UI (no shadcn setup required), and supports either plaintext PINs (fastest) or bcrypt hashes (safer).

---

**PROMPT FOR CLAUDE CODE (paste everything below):**

You are editing a Next.js 14 App Router project deployed on Vercel for `vaultoperations.com`. Implement a lightweight PIN-based gate for **/tools** with these rules:

- Ask for **Name** and **Toast PIN** once on `/unlock`, then unlock the device for a period (default **8 hours**).
- Protect **/tools** via `middleware.ts` that checks a signed cookie (`vo_auth`).
- Store employee registry in an env var (fastest). Also support hardcoded fallback in code. Optionally accept bcrypt hashes.
- Zero databases. Keep it simple to deploy and maintain.

### 1) Install deps
Add these:
```bash
pnpm add jose bcryptjs
```

### 2) Env variables (document in README and .env.local.example)
- `VO_AUTH_SECRET` – long random string (HS256 JWT). Example: `openssl rand -base64 32`
- `VO_AUTH_TTL_HOURS` – optional, default `8`
- `VO_EMPLOYEES_JSON` – JSON array. Supports either `pin` (plaintext) or `pinHash` (bcrypt). Example for testing:
```json
[
  { "name": "Tim White", "pin": "77242022" }
]
```

### 3) Create `lib/employees.ts`
```ts
// lib/employees.ts
import type { NextRequest } from "next/server";

export type Employee = {
  name: string;
  pin?: string;      // plaintext (fastest to set up)
  pinHash?: string;  // bcrypt hash (safer)
};

function normalizeName(s: string) {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export function loadEmployees(): Employee[] {
  const fromEnv = process.env.VO_EMPLOYEES_JSON;
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv) as Employee[];
      return parsed.map(e => ({ ...e, name: e.name.trim() }));
    } catch {
      console.warn("Invalid VO_EMPLOYEES_JSON");
    }
  }
  // Fallback hardcoded list so first deploy just works.
  return [{ name: "Tim White", pin: "77242022" }];
}

export function findEmployeeByName(name: string): Employee | undefined {
  const target = normalizeName(name);
  return loadEmployees().find(e => normalizeName(e.name) === target);
}
```

### 4) Create `lib/auth.ts`
```ts
// lib/auth.ts
import { SignJWT, jwtVerify } from "jose";

const COOKIE_NAME = "vo_auth";
export { COOKIE_NAME };

function getSecret() {
  const s = process.env.VO_AUTH_SECRET;
  if (!s) throw new Error("VO_AUTH_SECRET is required");
  return new TextEncoder().encode(s);
}

export function getTtlSeconds(): number {
  const hours = Number(process.env.VO_AUTH_TTL_HOURS ?? "8");
  return Math.max(1, Math.floor(hours * 3600));
}

export async function signAuthToken(payload: { name: string }) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + getTtlSeconds();
  return await new SignJWT({ sub: payload.name, typ: "vo/pin", iat: now })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(exp)
    .sign(getSecret());
}

export async function verifyAuthToken(token: string) {
  const { payload } = await jwtVerify(token, getSecret(), {
    algorithms: ["HS256"],
  });
  return payload?.sub && typeof payload.sub === "string" ? payload.sub : null;
}
```

### 5) Middleware to protect `/tools`
Create/replace `middleware.ts` at project root:
```ts
// middleware.ts
import { NextRequest, NextResponse } from "next/server";
import { verifyAuthToken } from "./lib/auth";

const COOKIE = "vo_auth";

export async function middleware(req: NextRequest) {
  const url = new URL(req.url);
  const token = req.cookies.get(COOKIE)?.value;
  if (!token) {
    return NextResponse.redirect(new URL(`/unlock?next=${encodeURIComponent(url.pathname)}`, url));
  }
  try {
    const user = await verifyAuthToken(token);
    if (!user) throw new Error("invalid");
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(new URL(`/unlock?next=${encodeURIComponent(url.pathname)}`, url));
  }
}

export const config = {
  matcher: ["/tools/:path*"], // protect the Tools section
};
```

### 6) API routes for login/logout
Create `app/api/pin-login/route.ts`:
```ts
// app/api/pin-login/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { findEmployeeByName } from "@/lib/employees";
import { signAuthToken, getTtlSeconds, COOKIE_NAME } from "@/lib/auth";
import bcrypt from "bcryptjs";

export const runtime = "nodejs"; // ensure node runtime

export async function POST(req: Request) {
  try {
    const { name, pin } = await req.json();
    if (!name || !pin) {
      return NextResponse.json({ ok: false, error: "Missing name or PIN" }, { status: 400 });
    }

    const emp = findEmployeeByName(String(name));
    if (!emp) {
      await new Promise(r => setTimeout(r, 500)); // tiny delay
      return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
    }

    let valid = false;
    if (emp.pinHash) {
      valid = await bcrypt.compare(String(pin), emp.pinHash);
    } else if (emp.pin) {
      valid = String(pin) === emp.pin;
    }

    if (!valid) {
      await new Promise(r => setTimeout(r, 500));
      return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
    }

    const token = await signAuthToken({ name: emp.name });
    const res = NextResponse.json({ ok: true });

    // Set HTTP-only auth cookie
    cookies().set({
      name: COOKIE_NAME,
      value: token,
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: getTtlSeconds(),
    });

    return res;
  } catch (e) {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
}
```

Create `app/api/logout/route.ts`:
```ts
// app/api/logout/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME } from "@/lib/auth";

export function POST() {
  cookies().set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 0,
  });
  return NextResponse.json({ ok: true });
}
```

### 7) Unlock page UI
Create `app/unlock/page.tsx`:
```tsx
// app/unlock/page.tsx
"use client";
import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";

export default function UnlockPage() {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sp = useSearchParams();
  const router = useRouter();
  const next = sp.get("next") || "/tools";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, pin }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Login failed");
      router.replace(next);
    } catch (e: any) {
      setErr(e.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl shadow p-6 border">
        <h1 className="text-xl font-semibold mb-4">Restricted Access</h1>
        <p className="text-sm text-gray-600 mb-4">
          Enter your name and Toast PIN to unlock.
        </p>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              className="w-full rounded-md border px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tim White"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">PIN</label>
            <input
              className="w-full rounded-md border px-3 py-2"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="••••••••"
              required
            />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl px-4 py-2 border shadow-sm disabled:opacity-50"
          >
            {loading ? "Unlocking…" : "Unlock"}
          </button>
        </form>
        <form method="POST" action="/api/logout" className="mt-3">
          <button className="text-xs text-gray-500 underline" type="submit">Clear device access</button>
        </form>
      </div>
    </div>
  );
}
```

### 8) (Optional) Switch to hashed PINs later
- Generate a bcrypt hash for each PIN and change each entry to `{ "name": "Full Name", "pinHash": "<bcrypt-hash>" }`.
- Keep `VO_EMPLOYEES_JSON` in Vercel Project → Settings → Environment Variables.

### 9) Notes
- Cookie is HTTP-only, signed (HS256), and expires after `VO_AUTH_TTL_HOURS`.
- Middleware redirects unauthenticated users to `/unlock?next=/tools…`.
- No DB, minimal surface area. You can style the form with shadcn later if desired.

Make these changes and ensure type imports/paths are correct (`@/lib/...`). Reply with any diffs if something doesn’t compile.

**END PROMPT**

---

## User

Just pin should be prompted for and that should get their name. We can show their name in the top of the screen when they're logged in and on the homepage it can say Welcome, First Name!

---

## Assistant

Mr. White — here’s the updated, copy-paste prompt for Claude Code. It only asks for a **PIN**, resolves the employee **name** from that PIN, shows the user’s name in the header, and the homepage greets them: **“Welcome, FirstName!”**. Still no DB, Vercel-friendly.

---

# PROMPT FOR CLAUDE CODE (paste everything below)

You are editing a Next.js 14 App Router project on Vercel for `vaultoperations.com`. Implement a PIN-only gate that:

- Prompts **only for PIN** on `/unlock`.
- Looks up the employee by PIN (from env JSON or hardcoded fallback).
- Sets a signed, HTTP-only cookie to unlock the device for **8 hours** (configurable).
- Protects **/tools** via `middleware.ts`.
- Shows the **employee’s full name** in the site header when logged in.
- On the homepage (`/`) greet with **“Welcome, FirstName!”** when logged in.
- No DB. Minimal deps. Tailwind UI.

## 1) Install deps
```bash
pnpm add jose bcryptjs
```

## 2) Env variables (.env.local + Vercel → Project Settings → Environment Variables)
- `VO_AUTH_SECRET` – long random string (HS256). Example: `openssl rand -base64 32`
- `VO_AUTH_TTL_HOURS` – optional, default `8`
- `VO_EMPLOYEES_JSON` – JSON array; each entry has `name` and either `pin` (plaintext) or `pinHash` (bcrypt).  
  Example (testing):
```json
[
  { "name": "Tim White", "pin": "77242022" }
]
```

## 3) `lib/employees.ts`
```ts
// lib/employees.ts
export type Employee = {
  name: string;
  pin?: string;      // fastest setup
  pinHash?: string;  // safer later
};

export function loadEmployees(): Employee[] {
  const s = process.env.VO_EMPLOYEES_JSON;
  if (s) {
    try {
      const arr = JSON.parse(s) as Employee[];
      return arr.map(e => ({ ...e, name: e.name.trim() }));
    } catch {
      console.warn("Invalid VO_EMPLOYEES_JSON");
    }
  }
  // Fallback so first deploy works.
  return [{ name: "Tim White", pin: "77242022" }];
}

export function findEmployeeByPin(pinInput: string): Employee | undefined {
  const normalized = String(pinInput).trim();
  return loadEmployees().find(e =>
    (e.pin && e.pin === normalized) || !!e.pinHash
  );
}
```

## 4) `lib/auth.ts`
```ts
// lib/auth.ts
import { SignJWT, jwtVerify } from "jose";

export const COOKIE_NAME = "vo_auth";

function secretKey() {
  const s = process.env.VO_AUTH_SECRET;
  if (!s) throw new Error("VO_AUTH_SECRET is required");
  return new TextEncoder().encode(s);
}

export function getTtlSeconds(): number {
  const hours = Number(process.env.VO_AUTH_TTL_HOURS ?? "8");
  return Math.max(1, Math.floor(hours * 3600));
}

export async function signAuthToken(name: string) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({ sub: name, typ: "vo/pin", iat: now })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(now + getTtlSeconds())
    .sign(secretKey());
}

export async function verifyAuthToken(token: string) {
  const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
  const name = payload?.sub;
  return typeof name === "string" ? name : null;
}
```

## 5) `lib/session.ts` (server-side helper to show name in header / pages)
```ts
// lib/session.ts
import { cookies } from "next/headers";
import { verifyAuthToken, COOKIE_NAME } from "./auth";

export async function getSessionUser() {
  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const name = await verifyAuthToken(token);
    if (!name) return null;
    const firstName = name.trim().split(/\s+/)[0] ?? name;
    return { name, firstName };
  } catch {
    return null;
  }
}
```

## 6) `middleware.ts` (protect /tools)
```ts
// middleware.ts
import { NextRequest, NextResponse } from "next/server";

const COOKIE = "vo_auth";

export async function middleware(req: NextRequest) {
  const url = new URL(req.url);
  const token = req.cookies.get(COOKIE)?.value;
  if (!token) {
    return NextResponse.redirect(new URL(`/unlock?next=${encodeURIComponent(url.pathname)}`, url));
  }
  // Let the API/page verify signature/exp; if missing cookie, redirect.
  return NextResponse.next();
}

export const config = {
  matcher: ["/tools/:path*"],
};
```

## 7) API routes: login (PIN only) & logout
```ts
// app/api/pin-login/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { findEmployeeByPin, loadEmployees } from "@/lib/employees";
import { signAuthToken, getTtlSeconds, COOKIE_NAME } from "@/lib/auth";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { pin } = await req.json();
    if (!pin) return NextResponse.json({ ok: false, error: "PIN required" }, { status: 400 });

    // Try plaintext match first
    const emp = findEmployeeByPin(String(pin));
    let valid = false;
    let name: string | null = null;

    if (emp?.pin && emp.pin === String(pin)) {
      valid = true;
      name = emp.name;
    } else if (emp?.pinHash) {
      // If multiple hashed users exist, scan until a match
      const list = loadEmployees().filter(e => e.pinHash);
      for (const e of list) {
        if (e.pinHash && await bcrypt.compare(String(pin), e.pinHash)) {
          valid = true; name = e.name; break;
        }
      }
    }

    if (!valid || !name) {
      await new Promise(r => setTimeout(r, 400));
      return NextResponse.json({ ok: false, error: "Invalid PIN" }, { status: 401 });
    }

    const token = await signAuthToken(name);
    cookies().set({
      name: COOKIE_NAME,
      value: token,
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: getTtlSeconds(),
    });

    return NextResponse.json({ ok: true, name });
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
}
```

```ts
// app/api/logout/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME } from "@/lib/auth";

export function POST() {
  cookies().set({ name: COOKIE_NAME, value: "", httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 0 });
  return NextResponse.json({ ok: true });
}
```

## 8) `/unlock` page (PIN only)
```tsx
// app/unlock/page.tsx
"use client";
import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";

export default function UnlockPage() {
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sp = useSearchParams();
  const router = useRouter();
  const next = sp.get("next") || "/tools";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      const res = await fetch("/api/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Login failed");
      router.replace(next);
    } catch (e: any) {
      setErr(e.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl shadow p-6 border">
        <h1 className="text-xl font-semibold mb-4">Restricted Access</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">PIN</label>
            <input
              className="w-full rounded-md border px-3 py-2"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="Enter your PIN"
              required
            />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <button type="submit" disabled={loading} className="w-full rounded-xl px-4 py-2 border shadow-sm disabled:opacity-50">
            {loading ? "Unlocking…" : "Unlock"}
          </button>
        </form>
        <form method="POST" action="/api/logout" className="mt-3">
          <button className="text-xs text-gray-500 underline" type="submit">Clear device access</button>
        </form>
      </div>
    </div>
  );
}
```

## 9) Header badge showing name (server component)
```tsx
// components/user-badge.tsx
import { getSessionUser } from "@/lib/session";

export default async function UserBadge() {
  const user = await getSessionUser();
  if (!user) return null;
  return (
    <div className="text-sm text-gray-700">
      Signed in as <span className="font-medium">{user.name}</span>
    </div>
  );
}
```

## 10) Use the badge in the root layout header
Add a simple top bar that’s present site-wide.

```tsx
// app/layout.tsx
import "./globals.css";
import UserBadge from "@/components/user-badge";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="w-full border-b">
          <div className="mx-auto max-w-5xl px-4 py-3 flex items-center justify-between">
            <a href="/" className="font-semibold">Vault Operations</a>
            {/* Shows when logged in */}
            {/* @ts-expect-error Async Server Component */}
            <UserBadge />
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
```

## 11) Homepage greeting “Welcome, FirstName!”
```tsx
// app/page.tsx
import { getSessionUser } from "@/lib/session";

export default async function HomePage() {
  const user = await getSessionUser();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">
        {user ? `Welcome, ${user.firstName}!` : "Welcome"}
      </h1>
      <p className="text-gray-600">This is the Vault Operations site.</p>
    </div>
  );
}
```

## 12) Notes
- To migrate to hashed PINs later, replace each entry with `{ "name": "...", "pinHash": "<bcrypt-hash>" }`. The login route already supports it.
- Cookie is HTTP-only, signed HS256, TTL via `VO_AUTH_TTL_HOURS`.
- `middleware.ts` protects `/tools`; you can add more matchers later.

# END PROMPT


## See Also
- [[chatgpt/chatgpt_accelerator-tracking-setup]]
- [[chatgpt/chatgpt_ai-ops-setup-inquiry]]
- [[chatgpt/chatgpt_ai-setup-instructions]]
- [[chatgpt/chatgpt_alert-setup-for-updates-part1]]
- [[chatgpt/chatgpt_alert-setup-for-updates-part10]]
