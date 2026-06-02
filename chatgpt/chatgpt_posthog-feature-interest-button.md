---
title: "PostHog feature interest button"
type: guide
created: 2025-08-31
updated: 2025-08-31
source: chatgpt-export
conversation_id: 68b4db16-443c-8332-a102-80a6343b8df1
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# PostHog feature interest button

> Conversation ID: 68b4db16-443c-8332-a102-80a6343b8df1
> Created: 2025-08-31T23:30:55Z
> Updated: 2025-08-31T23:32:55Z
> Messages: 6

---

## User

Is there a way to use potshog to have users click a "image interested" button to gauge feature interest?

---

## Assistant

Yes, Mr. White. PostHog can be used for that, but not directly out-of-the-box as an “image interest” widget. You have a few workable options:

### 1. **Feature Flags + Custom Button**
- Render your own “👍 Interested” button under the image in your UI.
- On click, call `posthog.capture('feature_interest_clicked', { feature: 'image_name' })`.
- This is the cleanest way to track user clicks for feature gauging.

### 2. **PostHog Surveys**
- Surveys can be triggered when users view certain pages/features.
- You could make a survey with a single “Interested” choice.  
  Downside: survey branding/customization is limited unless you’re on a paid tier.

### 3. **Experiments (less direct)**
- You can expose some users to the “Interested” button via a feature flag and compare engagement vs. baseline.
- Useful if you want to measure impact but not really necessary if you just want click counts.

---

**Best approach:** Build your own button and wire it into `posthog.capture`. That gives you full design control (you can put it right on the image) and logs clean events in PostHog for funnel analysis, dashboards, etc.

Want me to give you a copy-paste React component that wires an “Interested” button into PostHog?

---

## User

Im interested

---

## Assistant

Got it, Mr. White. Here’s a tight, copy-paste React setup for an “Interested” button that logs to PostHog.

# 1) Init PostHog (Next.js example)
```tsx
// app/providers.tsx (or _app.tsx)
"use client";

import { PostHogProvider } from 'posthog-js/react'
import posthog from 'posthog-js'

if (typeof window !== 'undefined' && !posthog.__loaded) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    autocapture: true,
  })
}

export default function Providers({ children }: { children: React.ReactNode }) {
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
```

# 2) Interest component
```tsx
"use client";

import Image from "next/image";
import { useState, useMemo } from "react";
import posthog from "posthog-js";
import { usePathname } from "next/navigation";

type Props = {
  src: string;
  alt: string;
  featureKey: string;  // e.g., "ai-image-upsizer"
  buttonText?: string;
  className?: string;
};

export default function ImageInterest({
  src,
  alt,
  featureKey,
  buttonText = "I’m interested",
  className,
}: Props) {
  const pathname = usePathname();
  const storageKey = useMemo(() => `interest:${featureKey}`, [featureKey]);
  const [clicked, setClicked] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(storageKey) === "1";
  });

  const onClick = () => {
    if (clicked) return;
    setClicked(true);
    try { localStorage.setItem(storageKey, "1"); } catch {}
    posthog.capture("feature_interest", {
      featureKey,
      page: pathname,
      ts: Date.now(),
    });
  };

  return (
    <div className={className}>
      <div className="relative w-full overflow-hidden rounded-2xl">
        <Image src={src} alt={alt} width={1200} height={800} className="w-full h-auto" />
      </div>
      <button
        onClick={onClick}
        disabled={clicked}
        className="mt-3 w-full rounded-2xl px-4 py-2 text-sm font-medium shadow-sm border
                   disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {clicked ? "Thanks — noted" : buttonText}
      </button>
    </div>
  );
}
```

# 3) Use it
```tsx
// any client component/page
import ImageInterest from "@/components/ImageInterest";

export default function Example() {
  return (
    <div className="max-w-xl">
      <ImageInterest
        src="/images/mock/ai-upsizer.png"
        alt="AI Upsizer mock"
        featureKey="ai-image-upsizer"
      />
    </div>
  );
}
```

# 4) Analyze in PostHog
- Event: `feature_interest`
- Property filter: `featureKey = ai-image-upsizer`
- Build an insight (trend or funnel) or a breakdown by `page`.

Optional: gate rendering via feature flag `show_interest_cta` to A/B the button; capture still works the same.

---

## User

No i mean like for any feature that were considering building we must a element in the dashboard and blur it out with a coming soon message and they can click "notify me" or interested and then it would tell us how much interest we have

---

## Assistant

Got it, Mr. White. Here’s a tight, reusable pattern for a blurred “Coming soon” tile with **Notify me / Interested** that logs to PostHog and (optionally) stores a notify request.

# React/Next + PostHog

## 1) Reusable tile
```tsx
// components/ComingSoonTile.tsx
"use client";

import { useMemo, useState } from "react";
import posthog from "posthog-js";

type Props = {
  featureKey: string;          // e.g. "ai-cover-art"
  title: string;               // e.g. "AI Cover Art"
  blurb?: string;              // short description
  onNotifySaved?: () => void;  // optional toast hook
};

export default function ComingSoonTile({ featureKey, title, blurb, onNotifySaved }: Props) {
  const [clicked, setClicked] = useState(false);
  const storageKey = useMemo(() => `notify:${featureKey}`, [featureKey]);

  const handleClick = async () => {
    if (clicked) return;
    setClicked(true);

    // 1) Analytics
    posthog.capture("feature_notify_click", {
      featureKey,
      ts: Date.now(),
    });

    // 2) Optional: persist notify (if you add the API below)
    try {
      await fetch("/api/interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureKey }),
      });
      onNotifySaved?.();
      localStorage.setItem(storageKey, "1");
    } catch {
      // swallow silently; analytics already captured
    }
  };

  return (
    <div className="relative rounded-2xl border overflow-hidden">
      {/* Content preview area you can replace with an image/mock */}
      <div className="h-40 bg-gray-100" />
      {/* Blur overlay */}
      <div className="absolute inset-0 backdrop-blur-sm bg-white/50 flex flex-col justify-end">
        <div className="p-4">
          <div className="text-sm font-semibold">{title}</div>
          {blurb && <div className="text-xs opacity-70">{blurb}</div>}
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide opacity-70">Coming soon</span>
            <button
              onClick={handleClick}
              disabled={clicked}
              className="ml-auto rounded-xl px-3 py-1.5 text-xs font-medium border shadow-sm disabled:opacity-60"
            >
              {clicked ? "Noted — we’ll ping you" : "Notify me"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

## 2) Drop tiles anywhere
```tsx
// app/dashboard/page.tsx (example)
import ComingSoonTile from "@/components/ComingSoonTile";

export default function Dashboard() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <ComingSoonTile featureKey="ai-cover-art" title="AI Cover Art" blurb="Generate artwork from a prompt." />
      <ComingSoonTile featureKey="smart-upsell" title="Smart Upsell" blurb="Optimize link order for conversions." />
      <ComingSoonTile featureKey="tip-analytics" title="Tip Analytics" blurb="Deep breakdowns of tip funnels." />
    </div>
  );
}
```

## 3) (Optional) Store “notify me” requests
**API route (Next.js App Router):**
```ts
// app/api/interest/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js"; // or your Neon client

export async function POST(req: Request) {
  const { featureKey } = await req.json();
  if (!featureKey) return NextResponse.json({ ok: false }, { status: 400 });

  // Identify user (adjust for your auth – Clerk/JWT/etc.)
  // Fallback to anonymous cookie id if unauthenticated.
  const userId = (await getUserIdSomehow()) ?? cookies().get("ph_distinct_id")?.value ?? null;
  const email = await getUserEmailIfAvailable(); // optional

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);

  await supabase.rpc("insert_feature_interest", { p_feature_key: featureKey, p_user_id: userId, p_email: email }); // or use a normal insert

  return NextResponse.json({ ok: true });
}

// Stub helpers for brevity
async function getUserIdSomehow() { return null; }
async function getUserEmailIfAvailable() { return null; }
```

**SQL (Neon/Supabase)**
```sql
create table if not exists feature_interest (
  id bigserial primary key,
  feature_key text not null,
  user_id text,
  email text,
  created_at timestamptz not null default now(),
  unique (feature_key, coalesce(user_id, email))
);
```

> If you’re truly “no backend yet,” skip step 3. PostHog events alone give you counts; add persistence later.

## 4) PostHog setup (naming + props)
- Event name: `feature_notify_click`
- Props: `featureKey`, `page` (optional), `ts`
- Identify users once at login: `posthog.identify(user.id, { email: user.email })`
- Dashboard: Trends → count by `featureKey`; add a table to rank interest across all coming-soon tiles.

## 5) (Optional) Gate tiles with a flag
Show the tile behind a feature flag (e.g., `show_coming_soon_tiles`) if you want to iterate privately:
```ts
// client
import { useFeatureFlagEnabled } from "posthog-js/react";
const show = useFeatureFlagEnabled("show_coming_soon_tiles");
```

---

If you want a **Nuxt/Vue** version for Jovie, say the word—I’ll drop the Vue component and a Nitro API endpoint.


## See Also
- [[chatgpt/chatgpt_automating-feature-design]]
- [[chatgpt/chatgpt_clerk-allowlist-feature]]
- [[chatgpt/chatgpt_feature-comparison-request]]
- [[chatgpt/chatgpt_feature-flag-workflow-setup]]
- [[chatgpt/chatgpt_feature-flagging-in-ios]]
