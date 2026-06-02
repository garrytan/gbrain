---
conversation_id: 68bdb7bb-438c-8326-ac65-823685eda542
created: 2025-09-07
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Next.js white screen fix
type: guide
updated: 2025-09-07
---

# Next.js white screen fix

**Related:** [[coding_web_dev]]

> Conversation ID: 68bdb7bb-438c-8326-ac65-823685eda542
> Created: 2025-09-07T16:50:04Z
> Updated: 2025-09-07T16:51:02Z
> Messages: 2

---

## User

On Next.js site, I'm noticing... I have a Next.js site that I saved to my home screen. When I tap the icon for the first time in a day or a few hours, the site will show me a white screen. It will take a few seconds before it loads anything at all. This is happening even for the home screen that is not behind off or anything. It's not like it's the dashboard or anything. It's just for the landing page home screen. Any ideas on how to make that load almost instantly?

---

## Assistant

Mr. White — this is almost always a “cold boot” + “nothing to paint” issue on iOS Home-Screen PWAs. Fix it by making “/” truly static and guaranteed to have pixels to show before any JS runs.

### Do these in priority order
1) **Make “/” static (no server, no client JS).**  
   - In `app/page.tsx`, **don’t** use `'use client'`, `cookies()`, `headers()`, dynamic data, or `next/image`.  
   - Export route options to force static:
     ```ts
     // app/page.tsx (App Router)
     export const dynamic = 'error';      // no dynamic render
     export const revalidate = false;     // full SSG, no ISR work
     ```
   - If you need periodic updates: `export const revalidate = 3600;` (still static at request time).

2) **Return immediate pixels (no white screen).**  
   - Give the body a background color inline (server-rendered CSS) and render an above-the-fold hero **without JS** (plain `<img>` or CSS background, not `next/image`).
   - Inline a tiny critical CSS block for the hero/shell (Tailwind classes still work, but don’t block on JS).

3) **Defer all JavaScript.**  
   - Put analytics/AB testing/feature flags behind:
     ```tsx
     <Script src="…" strategy="afterInteractive" />
     ```
   - Lazy-load noncritical UI with dynamic imports on interaction only.

4) **Fonts must never block paint.**  
   - Self-host, preload WOFF2, and use `font-display: swap` (or use a system font stack on “/”).  
   - If you use Google Fonts, download them; don’t call `fonts.googleapis.com` on the landing page.

5) **Service Worker: respond instantly with cached “/”.**  
   - Install a tiny SW (Workbox or hand-rolled) that precaches the HTML, CSS, logo, and hero image; **CacheFirst** for “/” so taps from the Home Screen show the cached shell immediately and refresh in the background (stale-while-revalidate).

6) **CDN/headers:**  
   - Ensure `Cache-Control` for static assets is `public, max-age=31536000, immutable`.  
   - For “/”, let the SW own freshness; otherwise keep HTML cache short at the CDN (or use ISR if you need freshness).

7) **Avoid redirects & heavy middleware.**  
   - No `www → apex` or locale redirects on “/” for the PWA scope.  
   - Skip middleware for the landing page if possible.

8) **Images:**  
   - For the LCP image on “/”, use plain `<img loading="eager" fetchpriority="high">` and a fixed width/height to avoid CLS. (Save `next/image` for inner pages.)

9) **Polish for iOS PWA:**  
   - Add `<meta name="theme-color" content="#000000">` and ensure the page background matches (prevents white flash).  
   - Provide the correct `apple-touch-startup-image` only if you actually want a splash (otherwise let it render immediately).

### Quick litmus tests
- Disable JS in Safari → if “/” still looks good, you’re set.  
- Lighthouse → LCP element should be server-rendered, no JS required.  
- Tap from Home Screen in Airplane Mode (after one online visit) → it should open from SW cache instantly.

### Minimal example (static, instant-paint landing)
```tsx
// app/page.tsx
export const dynamic = 'error';
export const revalidate = false;

export default function Home() {
  return (
    <main className="min-h-dvh bg-black text-white">
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h1 className="text-4xl font-bold">Jovie</h1>
        <p className="mt-3 text-lg opacity-80">
          Instant smart links for the music industry.
        </p>
        <img
          src="/hero.jpg"
          alt="Hero"
          width={1600}
          height={900}
          loading="eager"
          fetchPriority="high"
          className="mt-8 w-full h-auto rounded-lg"
        />
        <a href="/signup" className="mt-8 inline-block rounded-md px-5 py-3 bg-white text-black font-semibold">
          Claim your profile
        </a>
      </section>
    </main>
  );
}
```

If you want, paste your current `app/page.tsx`, `_app.tsx`/`layout.tsx`, `next.config.js`, and SW setup—I’ll mark exactly what’s making iOS show a white screen and give the smallest change set to hit “instant.”


**Topic:** [[chatgpt-clusters/coding_web_dev]]


## See Also
- [[chatgpt/chatgpt_add-songs-tim-white]]
- [[chatgpt/chatgpt_bio-for-tim-white]]
- [[chatgpt/chatgpt_clean-white-air-force-1]]
- [[chatgpt/chatgpt_crest-white-strips-analysis]]
- [[chatgpt/chatgpt_css-for-white-megamenu]]
