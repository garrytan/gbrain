---
title: "Alternatives to Genius Shots"
type: guide
created: 2025-08-23
updated: 2025-08-23
source: chatgpt-export
topic: music-production
message_count: 8
tags: [chatgpt, knowledge, music-production]
---
# Alternatives to Genius Shots

> **Source:** ChatGPT conversation
> **Date:** 2025-08-23T22:58:39Z
> **Messages:** 8
> **Topic:** music-production

## Question

I find that with tirzepatide and genius shots, its super easy to just pound 3-4 shots a day and eat whatever liv cooks or whatever i want, and im pretty much t macros without any thought. I loose weight consistently while maintaining muscle. however, genius shots are sold out, and without them it because a much bigger lift to think about diet.

What alternatives are there?

## Answer

Mr. White,

Here are concise, fact-based alternatives to consider now that your Genius Shots (semaglutide-type GLP-1 agonists) are sold out:

---

##  1. Other FDA-Approved Anti-Obesity Medications

Several prescription medications approved in the U.S. can support weight loss—always in conjunction with diet and exercise:

- **GLP-1 / GIP agonists (injectables)**:
  - **Zepbound** (tirzepatide) – essentially the weight-loss version of Mounjaro; typically yields greater weight loss than semaglutide.citeturn0news26turn0search6turn0news26
  - **Wegovy** (semaglutide) – a proven option with ~13.7% weight loss over 15 months. Also reduces cardiovascular event risk.citeturn0news26turn0search31turn0news26
  - **Saxenda** (liraglutide) – daily GLP-1 injection, FDA-approved for weight loss.citeturn0search9turn0news23

- **Other modalities**:
  - **Orlistat** (Xenical) – lipase inhibitor that reduces fat absorption; average weight loss ~2.9 kg.citeturn0search29turn0news23
  - **Qsymia** (phentermine/topiramate) – combines appetite suppression with metabolic effects.citeturn0search29turn0news23
  - **Contrave** (naltrexone/bupropion) – affects reward and hunger centers in the brain.citeturn0news23
  - **Imcivree** (setmelanotide) – indicated only for rare genetic obesity disorders.citeturn0news23turn0search32turn0news23

---

##  2. Emerging and In-Development Options

- **Retatrutide** – a triple-hormone (GLP-1, GIP, glucagon) agonist currently in Phase 3 clinical trials; in early results, offered up to ~24% weight loss over 48 weeks.citeturn0news24
- **CagriSema** (cagrilintide + semaglutide) – Phase 3 combo drug; users in the REDEFINE 1 trial lost ~20.4% of body weight over 68 weeks vs. semaglutide alone.citeturn0search30
- **Orforglipron** – an upcoming oral GLP-1 mimetic with easy dosing and potentially favorable storage profile.citeturn0news25turn0news27

These aren’t widely available yet, but they signal promising new options.

---

##  3. Short-Term Prescription Weight-Loss Pills

- **Phentermine** (and phendimetrazine) – stimulants approved for short-term use; suppress appetite effectively but should be part of a broader dietary plan.citeturn0search8turn0search29

---

##  Summary Table

| Category                      | Examples                         | Notes                                      |
|------------------------------|----------------------------------|--------------------------------------------|
| **Injectable GLP-1 / GIP**    | Zepbound, Wegovy, Saxenda        | Strong efficacy; may be subject to shortages |
| **Other RX options**          | Orlistat, Qsymia, Contrave       | Oral/injectable options with varied mechanisms |
| **Emerging therapies**        | Retatrutide, CagriSema, Orforglipron | Not yet accessible; high effectiveness in trials |
| **Short-term stimulants**     | Phentermine, phendimetrazine     | Temporary appetite suppression tools         |

---

###  Next Steps

- **Cons

*(Answer truncated — 3687 chars total)*

## Question

no. i use tirzepatide. Genius shots are a 90 calorie 23g protein 0g fat 0g carb drink that's under 3oz and costs about $3.40/ea. they are sold DTC.

## Answer

Got it — thanks for clarifying, Mr. White. You’re not asking for *drug* alternatives to tirzepatide; you’re asking for **dietary replacements for Genius Shots** (cheap, small, zero-carb, high-protein convenience shots).  

Here are the closest substitutes:  

---

## 🔄 Direct Ready-to-Drink Protein Shots
- **Protein2o 15g / 20g Protein Shots** – ~70–100 cal, 0g fat, 1–2g carb, ~3oz bottles. Costs about $2.50–$3.50 each.  
- **New Whey Protein Shots** – 42g protein, 180 cal, ~3.8oz. A bit larger, ~ $3–$4 each, sweetened, almost no fat.  
- **Pure Protein Complete Protein Shots** – 23g protein, 95 cal, 0g fat, 0g sugar, ~2.9oz. Very close to Genius Shots.  

---

## 🧴 Alternative Formats (slightly larger volume)
- **Isopure Infusions RTDs** – 20g whey isolate in ~16oz, 90 cal, zero carb/fat. Not as compact, but macro-similar.  
- **Premier Protein Clear** – 20g protein, 90 cal, 0g fat, ~16oz. More like a flavored water with protein.  

---

## 💡 DIY Equivalent
- Use **unflavored whey isolate + water** in a 3oz bottle. Example:
  - 25g whey isolate (90–100 cal, 23g protein, 0g carb/fat)
  - Mix with just enough water + flavor drops (e.g., Mio or Crystal Light).  
- This replicates the Genius Shot macros exactly, costs closer to **$0.60–$0.80 per serving**, and can be pre-batched into 3oz glass vials or travel bottles.  

---

## 🧾 Cost & Convenience Tradeoff
- **Closest match** = *Pure Protein Shots* or *New Whey Shots*.  
- **Cheapest + scalable** = DIY with isolate + droppers/bottles.  
- **Wider availability** = Isopure Infusions / Premier Clear at grocery/Costco, though less compact.  

---

👉 Do you want me to put together a **DIY prep system** for you (buy bottles, isolate brand, flavoring, cost breakdown per shot), so you can replace Genius Shots 1:1 at home until they’re back in stock?

## Question

If an auth session is expired in jovie, what should we do? 

## Answer

For Jovie (your Linkfire competitor), best practice is:  

### 🔒 When an auth session expires
1. **Silent re-auth if possible**  
   - If Clerk (or your auth provider) supports refresh tokens, attempt to refresh in the background without interrupting the user.  
   - If refresh succeeds, continue seamlessly.  

2. **If refresh fails → clear sensitive state**  
   - Immediately wipe in-memory auth state, Supabase client session, and any cached tokens.  
   - Don’t keep showing stale data or allow actions to fire.  

3. **Redirect to sign-in**  
   - Show a concise banner: *“Your session has expired. Please sign in again.”*  
   - Redirect to login (preserving intended destination so user resumes where they left off after re-auth).  

4. **UX polish**  
   - If expiry happens mid-flow (e.g. creating a smart link), auto-save draft locally before redirect.  
   - On successful re-auth, restore the draft and push user back into the same screen.  

---

### ⚡ YC / Apple-level polish
- **Invisible if smooth**: 95% of users should never see it because background refresh handles it.  
- **Fail gracefully**: if they do, it feels like a minor bump, not data loss.  
- **Minimal friction**: always default to “continue with last method” so login is one-click.  

---

Do you want me to draft a **flow spec** (UI states + Clerk/Supabase handling logic) that your AI agents can just implement directly?

## Question

yep

## Answer

Mr. White — here’s a compact, copy-paste flow spec for **expired auth** in Jovie (Clerk + Supabase). It’s production-ready, YC-style, Apple-polished.

# Flow spec: Expired Auth

## Goals
- 0 data loss, near-invisible refresh.
- If refresh fails, fast re-auth with return-to restore.
- Works for **pages**, **API routes**, and **SSR/Edge**.

---

## 1) Route Guard (App Router)

**`app/(protected)/layout.tsx`**
```tsx
// app/(protected)/layout.tsx
import { auth, ClerkProvider, SignIn } from "@clerk/nextjs";
import { redirect } from "next/navigation";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { userId, sessionId } = auth();
  if (!userId || !sessionId) {
    // Persist returnTo and send to sign-in
    redirect(`/sign-in?returnTo=${encodeURIComponent(globalThis?.location?.pathname ?? "/dashboard")}`);
  }
  return <>{children}</>;
}
```

**Optional middleware gate for API + pages**
```ts
// middleware.ts
import { withClerkMiddleware, getAuth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export default withClerkMiddleware((req) => {
  const { userId, sessionId } = getAuth(req);
  const isProtected = req.nextUrl.pathname.startsWith("/dashboard") || req.nextUrl.pathname.startsWith("/api/protected");
  if (isProtected && (!userId || !sessionId)) {
    const url = new URL("/sign-in", req.url);
    url.searchParams.set("returnTo", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next|static|public|favicon.ico|sign-in|sign-up|api/webhooks).*)"],
};
```

---

## 2) Silent Session Refresh + Draft Autosave

**`lib/auth/session-watch.tsx`**
```tsx
"use client";
import { useAuth, useClerk } from "@clerk/nextjs";
import { useEffect, useRef } from "react";
import { saveDraftSnapshot } from "@/lib/drafts";

export function SessionWatch({ onExpire }: { onExpire?: () => void }) {
  const { sessionId, isSignedIn, getToken } = useAuth();
  const { signOut } = useClerk();
  const triedRefresh = useRef(false);

  useEffect(() => {
    let alive = true;

    async function check() {
      try {
        // Attempt background token fetch (forces refresh if needed)
        await getToken({ template: "supabase" });
      } catch {
        if (!alive) return;

        // Last-ditch: autosave UI draft before sign-out
        try { await saveDraftSnapshot(); } catch {}

        if (onExpire) onExpire();

        // Hard sign-out to clear stale state
        await signOut({ redirectUrl: `/sign-in?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}` });
      }
    }

    if (isSignedIn && sessionId && !triedRefresh.current) {
      triedRefresh.current = true;
      void check();
    }
    return () => { alive = false; };
  }, [isSignedIn, sessionId, getToken, signOut, onExpire]);

  return null;
}
```

**Usage in protected pages**
```tsx
// app/(pro

*(Answer truncated — 9126 chars total)*
