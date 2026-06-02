---
title: "Improve font performance"
type: note
created: 2025-09-04
updated: 2025-09-04
source: chatgpt-export
conversation_id: 68b9d383-bc54-8333-beac-4000c4e2e162
message_count: 2
tags: [chatgpt, import, code]
---
# Improve font performance

> Conversation ID: 68b9d383-bc54-8333-beac-4000c4e2e162
> Created: 2025-09-04T17:59:32Z
> Updated: 2025-09-04T18:00:00Z
> Messages: 2

---

## User

fonts.googleapis.com is being called by our next.js app. Should we do something to get this performing better?

---

## Assistant

Mr. White — short answer: stop calling Google’s CSS at runtime. Use `next/font` and let Next.js self-host the files.

# What to do
1. **Switch to `next/font/google`**
   - Fonts are downloaded at build time and served from your app (no `fonts.googleapis.com` round-trips).
   - Automatic subsetting, `font-display: swap`, no CLS, better cacheability.
   ```ts
   // app/layout.tsx
   import { Inter } from 'next/font/google';

   const inter = Inter({
     subsets: ['latin'],
     display: 'swap',
     variable: '--font-inter',   // optional: use as a CSS var
   });

   export default function RootLayout({ children }) {
     return (
       <html className={inter.variable}>
         <body>{children}</body>
       </html>
     );
   }
   ```
   - Remove any `<link href="https://fonts.googleapis.com/...">` tags.

2. **Prefer variable fonts + minimal subsets**
   - Choose the variable family (e.g., `Inter` variable) instead of many static weights.
   - Keep `subsets` tight (usually `['latin']` for you).

3. **Set sensible fallbacks**
   - Add system fallbacks to reduce flash:  
     `font-family: var(--font-inter), ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;`

4. **Cache correctly**
   - With self-hosting, fonts will be behind Vercel CDN by default; they’ll get long-lived immutable caching.

# If you must keep Google’s CDN (not recommended)
- Add `display=swap` to the CSS URL.
- Preconnect early:
  ```html
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  ```
- Limit glyphs with `&text=` (only for small, fixed strings) or strict subsets to cut file size.

Bottom line: move to `next/font` and delete the external `<link>` — that’s the biggest real-world win.


**Topic:** [[chatgpt-clusters/code_review]]
