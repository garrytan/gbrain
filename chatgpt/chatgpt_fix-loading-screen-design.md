---
title: "Fix loading screen design"
type: note
created: 2025-09-03
updated: 2025-09-03
source: chatgpt-export
conversation_id: 68b7f328-0510-8332-9c13-77ec3575b44a
message_count: 2
tags: [chatgpt, import, code]
---
# Fix loading screen design

> Conversation ID: 68b7f328-0510-8332-9c13-77ec3575b44a
> Created: 2025-09-03T07:50:26Z
> Updated: 2025-09-03T07:51:05Z
> Messages: 2

---

## User

The basic loading page that displays before anything loads just says loading... its an all white page with balck text and no styling, it doesnt even respect dark mode

---

## Assistant

Mr. White — fix it with a real app-shell fallback + dark-aware styles.

# 1) Drop in a global loading screen (App Router)
Create `app/loading.tsx` (and per-segment `loading.tsx` where needed):
```tsx
// app/loading.tsx
export default function Loading() {
  return (
    <div className="min-h-dvh grid place-items-center bg-[rgb(10,10,11)] text-[rgb(235,235,235)] dark:bg-black dark:text-white">
      <div className="flex items-center gap-3">
        <span className="size-2 rounded-full animate-ping bg-current" />
        <span className="text-sm tracking-wide">Loading…</span>
      </div>
    </div>
  );
}
```

# 2) Respect dark mode immediately (no white flash)
Add this tiny inline script in `app/layout.tsx` **before** the body to set the theme pre-hydration:
```tsx
// inside <head> of app/layout.tsx
<script
  dangerouslySetInnerHTML={{
    __html: `
(function() {
  try {
    var ls = localStorage.getItem('theme');
    var mql = window.matchMedia('(prefers-color-scheme: dark)');
    var dark = ls ? (ls === 'dark') : mql.matches;
    var root = document.documentElement;
    if (dark) root.classList.add('dark'); else root.classList.remove('dark');
  } catch (e) {}
})();
`}}
/>
```

# 3) Set sane base styles
In `globals.css` (or `app/globals.css`):
```css
html, body { height: 100%; }
body {
  background: #0a0a0b; color: #eaeaea;
}
.dark body {
  background: #000; color: #fff;
}
```

# 4) If you use `next-themes`, initialize it early
```tsx
// app/providers.tsx
'use client';
import { ThemeProvider } from 'next-themes';
export function Providers({ children }: { children: React.ReactNode }) {
  return <ThemeProvider attribute="class" defaultTheme="system" enableSystem>{children}</ThemeProvider>;
}

// app/layout.tsx
import { Providers } from './providers';
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>{/* include the inline theme script above here */}</head>
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
```

# 5) Use consistent suspense fallbacks
Where you `suspense` or `use` data, supply the same styled fallback:
```tsx
<Suspense fallback={<Loading />}>
  {/* route/content */}
</Suspense>
```

# 6) Optional polish (fast wins)
- Add a logo glyph or wordmark next to “Loading…”.
- Add subtle scale/opacity animation on mount (`animate-[fade-in_300ms_ease]`).
- Keep the background identical to your app shell to avoid a visual jump.

This replaces the plain white “loading…” with a branded, dark-aware shell and eliminates the flash.
