
Mr. White — here’s a ready‑to‑paste **.env.local** for Jovie.  
(Add `.env.local` to `.gitignore`. Rotate any keys you later commit by accident.)

```bash
# ===== App =====
NEXT_PUBLIC_APP_URL=https://jov.ie

# ===== Supabase =====
NEXT_PUBLIC_SUPABASE_URL=https://unztdvzojmjcddxyptfw.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVuenRkdnpvam1qY2RkeHlwdGZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQxNTc2NTMsImV4cCI6MjA2OTczMzY1M30.ALpE27kXP9wrRlNs-RYEvk0qjHPRrCKm642pfBxXCuA

# (Optional but useful if you do server-side admin work)
SUPABASE_DB_PASSWORD=epf7GUM-hyg7rfk3dny
# Direct Postgres connection (server-only usage)
DATABASE_URL=postgresql://postgres:epf7GUM-hyg7rfk3dny@db.unztdvzojmjcddxyptfw.supabase.co:5432/postgres

# If you have it, add the Supabase service role key (server-only)
# SUPABASE_SERVICE_KEY=

# ===== Clerk =====
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ZGlzdGluY3QtZ2lyYWZmZS01LmNsZXJrLmFjY291bnRzLmRldiQ
CLERK_SECRET_KEY=sk_test_RS2raun9iVe9B0DnsvO4cCO9lQ7MDRtqaVuPheJBAv
# Optional:
# CLERK_WEBHOOK_SECRET=

# ===== Spotify OAuth =====
SPOTIFY_CLIENT_ID=b66af2f96f4e4b9ca13199188a881e21
SPOTIFY_CLIENT_SECRET=3f43227710fd43dbb3688c2eb32a0cb3
# Redirect/callback in Clerk settings should point to your deployed domain.

# ===== Analytics / Billing (placeholders for later) =====
NEXT_PUBLIC_SEGMENT_WRITE_KEY=
STRIPE_SECRET_KEY=
REVENUECAT_API_KEY=
```

Need a sanitized `.env.example` too? I can generate that with placeholders.


yes


Here’s a **sanitized `.env.example`** for Jovie — safe to commit to GitHub so contributors know what vars to set.  

```bash
# ===== App =====
NEXT_PUBLIC_APP_URL=https://your-domain.com

# ===== Supabase =====
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key_here

# Optional for local/server-only usage:
SUPABASE_DB_PASSWORD=your_db_password_here
DATABASE_URL=postgresql://postgres:your_db_password_here@db.YOUR_PROJECT_ID.supabase.co:5432/postgres
# SUPABASE_SERVICE_KEY=your_service_key_here

# ===== Clerk =====
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key_here
CLERK_SECRET_KEY=your_clerk_secret_key_here
# CLERK_WEBHOOK_SECRET=your_clerk_webhook_secret_here

# ===== Spotify OAuth =====
SPOTIFY_CLIENT_ID=your_spotify_client_id_here
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret_here

# ===== Analytics / Billing =====
NEXT_PUBLIC_SEGMENT_WRITE_KEY=your_segment_key_here
STRIPE_SECRET_KEY=your_stripe_secret_here
REVENUECAT_API_KEY=your_revenuecat_api_key_here
```

If you want, I can also create a **Vercel environment variable import JSON** so you can drop all of this into your project in one click.  
Do you want me to make that?


Now, please create a prompt for clogged code to build the MVP as in-depth as possible. We currently have an initiated repo with just the env file and nothing else. Be sure to set up everything with best practices. Be sure to add proper linting and all that stuff. Testing setup and everything. And set up all of our core MVP features and be sure to use the environmental variables as we've specified them. So make sure that you're using those naming conventions so that everything works properly. Do everything as cleanly as possible. By combinator best practices. Be sure to include a mobile friendly landing page with a clear and concise call to action. I would like our full design to be in light mode to be white background. With black buttons and everything. I'd like to use like Apple style design where there's no single color for any of the theme. We just define like accent color per section if needed. But for the most part it's a gray scale or black and white design. Clean modern fonts. Make sure you're using Apple's the same like sizing and stuff that Apple uses where they have like their boxed layout for the header and footer. Same thing with like use their like sizing and stuff so that everything looks nice and modern and clean. The actual artist profile design. Make sure that that's super clean and modern and high converting. We want a world class UX for everything. And then for our dashboard make it a super clean minimalist dashboard. Assume that people are going to use desktop probably to build their sites but mobile to actually view them. But still make the dashboard mobile friendly and use as little code duplication as possible. You know refactoring everything into shared as shared components and stuff and try and have like a good solid design. Nothing is duplicated unnecessarily. Also use a core design. Make sure that you're using the same font that Apple uses. And then make sure that you're using a core file for constants so that the app name can be set in the constants. The app URL can be set in the constants. Things like pricing can be set. Anything that's kind of a variable that we might want to play with later. Set it in constants. The exception being that if pricing and stuff needs to be generated with Revenue Cat then obviously we use Revenue Cat for that. And let's ensure that we have everything laid out in as much detail as possible to get this online quickly with maximum stability and everything. Thank you.


Mr. White — here’s a **copy‑paste master prompt** for your code generator to build the Jovie MVP from an empty repo, end‑to‑end, with best practices, tests, linting, CI, and your exact env names.

---

## **AI Build Prompt — Jovie MVP (Next.js + Supabase + Clerk + Segment)**

You are an expert full‑stack engineer. Generate a production‑ready **Next.js 14 (App Router, TypeScript)** codebase for **Jovie**, a high‑conversion link‑in‑bio for musicians. Repo is empty except for `.env.local` already containing valid keys. Follow **YC/Apple/Linear-style** simplicity, strong DX, and scalable patterns. Ship a working MVP with tests and CI.

### 0) Core stack & dependencies
- **Next.js 14 (App Router, TS)**
- **Tailwind CSS** + **next-themes**
- **Clerk** (`@clerk/nextjs`) for auth (Spotify social provider configured in Clerk)
- **Supabase** (`@supabase/supabase-js`) for Postgres + RLS
- **Segment** (`@segment/analytics-next`) for analytics
- **Zod** for validation
- **Date-fns** utilities
- **ESLint** (Next + TS) + **Prettier** + **lint-staged** + **husky**
- **Vitest** + **Testing Library** (unit) and **Playwright** (e2e)
- **GitHub Actions** CI: lint, typecheck, unit tests, e2e (on PR)
- Defer **RevenueCat/Stripe** wiring (placeholders & types only)

### 1) Environment variables (use exactly these names)
Provided in `.env.local`:
```
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_DB_PASSWORD
DATABASE_URL
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY
SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET
NEXT_PUBLIC_SEGMENT_WRITE_KEY
STRIPE_SECRET_KEY
REVENUECAT_API_KEY
```
**Rules:**  
- Never expose server‑only secrets to the client.  
- Client uses only `NEXT_PUBLIC_*` vars.

### 2) Fonts & design system (Apple‑style, grayscale)
- **Font stack:** `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", Segoe UI, Roboto, Inter, Arial, sans-serif`.
- **Color:** white backgrounds, black text, grayscale UI (no brand color). Buttons are black with white text; hover slightly lighter (e.g., `#111`).  
- **Layout:** Apple‑like boxed layout widths (content max‑width 1200px), generous whitespace, consistent vertical rhythm.
- **Light mode default**, dark mode supported (toggle).
- **Tailwind config:** add container padding, custom letter-spacing/line-height similar to Apple product pages.

### 3) Project structure
```
/app
  /(marketing)/page.tsx
  /[handle]/page.tsx
  /[handle]/listen/route.ts
  /dashboard/page.tsx
  /legal/privacy/page.tsx
  /legal/terms/page.tsx
  /api/track/route.ts
/components
  /auth/*  (Clerk wrappers)
  /site/*  (Header, Footer, Container, ThemeToggle)
  /ui/*    (Button, Input, Textarea, Switch, Modal, Tooltip, Badge, Card)
  /profile/* (ProfileHeader, SocialBar, ListenNow, VerifiedBadge[placeholder])
  /dashboard/* (ProfileLinkCard, ProfileForm, SocialsForm, ListenNowForm, AnalyticsCards)
/docs (privacy.md, terms.md)
/lib (supabase.ts, spotify.ts, analytics.ts, cookies.ts, utils.ts)
/styles (globals.css, tailwind.css)
/types (db.ts, common.ts)
/tests (unit + e2e)
/public (brand/jovie-logo.svg, og/*, favicon)
/config (eslint, prettier, jest/vitest, playwright)
/constants (app.ts)
.eslintrc.cjs, .prettierrc, tsconfig.json, next.config.js, postcss.config.js, tailwind.config.js
README.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, LICENSE, .gitignore, .env.example
```

### 4) Constants
Create `constants/app.ts`:
```ts
export const APP_NAME = "Jovie";
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://jov.ie";
export const MAX_SOCIAL_LINKS = 6;
export const LISTEN_COOKIE = "jovie_dsp";
export const DSPS = { spotify: "spotify" } as const;
export const DEFAULT_PROFILE_TAGLINE = "Listen now.";
export const ANALYTICS = { segmentWriteKey: process.env.NEXT_PUBLIC_SEGMENT_WRITE_KEY ?? "" };
export const LEGAL = { privacyPath: "/legal/privacy", termsPath: "/legal/terms" };
```

### 5) Tailwind + theming
- Configure Tailwind (container, screens, fontFamily with Apple stack).
- Add `next-themes` setup; default light, class strategy.
- Build `Button`, `Input`, `Card`, etc. in `/components/ui/` with **black/white/gray** palette.

### 6) Clerk auth
- Wrap app with `<ClerkProvider>`; theme Clerk to grayscale.
- Add sign-in/up routes using **Clerk UI components**.  
- After successful auth, redirect to `/dashboard`.  
- Middleware protecting app routes; public: `/`, `/[handle]`, `/[handle]/listen`, `/legal/*`.

### 7) Supabase client helpers
`/lib/supabase.ts`:
- `createBrowserClient()` for client
- `createServerClient()` for server actions (using `cookies()`)

### 8) Database schema (SQL for Supabase migrations)
Create SQL migration (emit as file in repo `supabase/migrations/0001_init.sql`):

```sql
-- users
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  clerk_id text unique not null,
  email text not null,
  created_at timestamptz default now()
);

-- artists
create table if not exists artists (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  handle text unique not null,
  spotify_id text not null,
  name text not null,
  image_url text,
  tagline text,
  theme jsonb,
  settings jsonb default jsonb_build_object('hide_branding', false),
  published boolean default true,
  created_at timestamptz default now()
);

-- social_links
create table if not exists social_links (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid references artists(id) on delete cascade,
  platform text not null,
  url text not null,
  clicks int default 0,
  created_at timestamptz default now()
);

-- releases
create table if not exists releases (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid references artists(id) on delete cascade,
  dsp text not null,
  title text not null,
  url text not null,
  release_date date,
  created_at timestamptz default now()
);

-- click_events
create table if not exists click_events (
  id bigserial primary key,
  artist_id uuid references artists(id) on delete cascade,
  link_type text not null, -- 'listen' | 'social'
  target text not null,
  ua text,
  platform_detected text,
  created_at timestamptz default now()
);

-- subscriptions (placeholder)
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  plan text not null,
  status text not null,
  revenuecat_id text,
  created_at timestamptz default now()
);

-- RLS
alter table users enable row level security;
alter table artists enable row level security;
alter table social_links enable row level security;
alter table releases enable row level security;
alter table click_events enable row level security;
alter table subscriptions enable row level security;

-- Policies
create policy "users self access" on users
for select using (clerk_id = current_setting('request.jwt.claims', true)::jsonb->>'sub')
with check (clerk_id = current_setting('request.jwt.claims', true)::jsonb->>'sub');

create policy "artist public read" on artists
for select using (published = true);

create policy "artist owner rw" on artists
for all using (owner_user_id in (select id from users where clerk_id = current_setting('request.jwt.claims', true)::jsonb->>'sub'));

create policy "social by artist owner" on social_links
for all using (artist_id in (select a.id from artists a join users u on a.owner_user_id=u.id where u.clerk_id = current_setting('request.jwt.claims', true)::jsonb->>'sub'));

create policy "releases by artist owner" on releases
for all using (artist_id in (select a.id from artists a join users u on a.owner_user_id=u.id where u.clerk_id = current_setting('request.jwt.claims', true)::jsonb->>'sub'));

create policy "clicks readable public" on click_events
for select using (true);
create policy "clicks insert any" on click_events
for insert with check (true);
```

### 9) Spotify ingestion (no verification)
`/lib/spotify.ts`:
- Parse pasted **Spotify Artist URL/ID**.
- Endpoints:
  - `GET /v1/artists/{id}` → `name`, `images[0].url`
  - `GET /v1/artists/{id}/albums?include_groups=album,single&limit=50` → compute latest by `release_date` (handle precision)
- Build canonical URLs: `https://open.spotify.com/artist/{id}` and for latest release.

### 10) Analytics
`/lib/analytics.ts`:
- Initialize Segment with `NEXT_PUBLIC_SEGMENT_WRITE_KEY`.
- Helper `track(event, props)` used across app.
- Events: `page_view`, `listen_click`, `social_click`, `platform_selected`.

### 11) Routing & pages
**Marketing (`/`)**  
- Mobile‑first hero, clear CTA “Login with Spotify” (goes to Clerk SignIn).  
- Apple‑style boxed header/footer, white background, black CTA button, minimal copy.  
- Footer links to `/legal/privacy` & `/legal/terms`.

**Legal (`/legal/*`)**  
- SSR render `/docs/privacy.md` and `/docs/terms.md`.

**Artist Profile (`/[handle]`)**  
- Large profile image, artist name, optional tagline, one big **Listen Now** button (black).  
- Up to **MAX_SOCIAL_LINKS** icons; sorted by `clicks DESC`.  
- Compact footer with **Jovie** logo (`/public/brand/jovie-logo.svg`) linking to `https://jov.ie?utm_source=profile&utm_artist={handle}` unless `hide_branding`.

**Listen Router (`/[handle]/listen`)**  
- **Edge route** (fast). If cookie `jovie_dsp=spotify`, **302** to the correct Spotify URL (latest release if present, else artist).  
- If not set: return page that prompts choice (MVP single button “Open in Spotify”) and sets cookie + localStorage. Next hit redirects instantly.

**Dashboard (`/dashboard`)**  
- Post‑login landing. Minimalist, desktop‑first but responsive.  
- **ProfileLinkCard**: shows `https://jov.ie/[handle]` with **Copy** + **View Profile**.  
- **Profile** tab: name (read‑only), tagline (editable), profile image override (upload to Supabase storage or keep URL).  
- **Social Links** tab: CRUD up to 6; show click counts (read‑only); auto-sort enforced server‑side.  
- **Listen Now** tab: show/edit Spotify URL (default to latest release URL).  
- **Analytics** tab: cards with total clicks, breakdown by link (aggregate `click_events`).  
- Header uses **Clerk `<UserButton/>`**.

### 12) Shared components & minimal duplication
- `/components/site/Container.tsx` ensures consistent max‑width and padding.  
- Reusable **FormRow**, **SectionCard** components.  
- Use Zod schemas for forms. Server actions update Supabase.

### 13) Tracking & click API
- On “Listen Now” and social icon clicks:  
  - `track('listen_click' | 'social_click', { handle, target, platform })`  
  - `POST /api/track` → insert into `click_events` and `increment social_links.clicks` if applicable.  
- Include user‑agent and detected platform (basic UA parse).

### 14) Middleware
- `authMiddleware` with public routes: `/`, `/:handle`, `/:handle/listen`, `/legal/*`.  
- If signed‑in and hitting `/`, redirect to `/dashboard`.

### 15) Testing
- **Vitest** + Testing Library for units (utils, components).  
- **Playwright** e2e:  
  - Load `/` → Sign In → `/dashboard`  
  - Onboard by pasting Spotify Artist URL → creates profile  
  - Visit `/[handle]`, click Listen Now → sets cookie → second visit redirects

### 16) Linting & formatting
- ESLint (next/core-web-vitals, ts), Prettier, strict TypeScript.  
- Husky pre‑commit: `lint-staged` runs `eslint --fix` & `prettier --write`.  
- `npm scripts`: `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:e2e`, `format`.

### 17) CI (GitHub Actions)
- Workflow `ci.yml` runs on PR:  
  - `pnpm i`  
  - `pnpm lint`  
  - `pnpm typecheck`  
  - `pnpm test` (unit)  
  - `pnpm test:e2e` (headed=false; mock Spotify responses)

### 18) README & examples
- Clear quickstart, env setup, Supabase migration instructions, Vercel deploy steps.  
- Include `.env.example` (sanitized).  
- Add **MIT LICENSE**, **CONTRIBUTING**, **CODE_OF_CONDUCT**.

### 19) Accessibility & SEO
- Semantic headings, alt text, focus states.  
- OG image generator for profiles (`/public/og/default.png` now; dynamic later).  
- `next-sitemap` config (optional).

### 20) Copy (short)
- **Home hero:**  
  - H1: “One link. All your music.”  
  - Sub: “Jovie auto‑builds a clean profile that sends fans straight to your music.”  
  - Button: “Login with Spotify”

### 21) Implementation notes
- First login: if no artist row, show onboarding to paste **Spotify Artist URL/ID** → ingest → generate unique `handle` (slug + suffix).  
- Handle uniqueness enforced by DB constraint; display error if taken.  
- Social ordering comes from a **view or server query** sorting by `clicks DESC` (no manual drag).  
- Keep **artist verification out** of MVP.  
- Keep branding footer visible unless `hide_branding` (for future paid tier).

---

**Deliverables:** a runnable app meeting all above requirements, passing lint/type/tests locally, with CI pipeline configured, ready to deploy on Vercel using the existing `.env.local`.


Thought that just occurred to me, I wonder if there's a better, I wonder about podcasts. And creating a link for podcasts, so not just music artists, but also podcasts where you would create a link for the podcast and then be able to, you know, basically the same concept where you become the hub for podcasts, and then for music artists. I'd like you to do a quick deep dive for me, laying out kind of how the podcast flow could work versus the artist flow, what complications we might hit with supporting podcasts, and then do a little bit of market research to figure out, is it even worth it to do podcasts? Can we support both podcasts and artists, and then, you know, podcasts, you could auto-import the whole list of episodes and stuff like that, and there's a lot we could do with that. And maybe, you know, there's a lot of things you could do with, like, then handling podcast bookings and handling ad sales for podcasts and stuff like that, but I'd like you to just kind of do some research into podcasts, and, you know, it's less of, I have a lot of friends who are musicians, I don't have as many friends who have successful podcasts. What would be your thought on that, in terms of, just generally, what do we think about that in terms of going after podcasts versus going after artists, in terms of one long-term success and revenue, and then two, launching quickly, getting to 10,000 MRR?


Mr. White — here’s the quick, no‑nonsense read.

## How a **Podcast flow** would work (vs. Artist)
**Entity:** *Show* (podcast) instead of *Artist*.  
**Ingest:**  
- Input: RSS URL **or** Apple Podcasts/Spotify show URL → resolve RSS.  
- Parse RSS for show metadata (title, artwork, author, description) + episodes (GUID, title, pubDate, enclosure url, duration, explicit).  
- Refresh nightly; on publish webhook from host later.

**Profile UI (jov.ie/[show])**
- Large cover art, show title, one‑line description.  
- One big **“Listen Now”**; first time → choose Apple/Spotify/YouTube Music/Overcast/Pocket Casts/RSS; remember choice.  
- Up to 6 social links.  
- Optional **Episodes** tab (desktop): searchable list; click → platform chooser (or remembered deep link).

**Routing / deep links**
- Apple Podcasts: `https://podcasts.apple.com/.../id{apple_id}`  
- Spotify: `https://open.spotify.com/show/{id}`  
- YouTube/YouTube Music (Google Podcasts sunset)  
- Overcast/Podcast Addict/Pocket Casts; always include **RSS** as a choice.

**DB delta (minimal)**
- Add `shows` (parallel to `artists`) and `episodes` (parallel to `releases`).  
- Reuse `social_links`, `click_events`, `subscriptions`.  
- Add a polymorphic `entity_type` (`'artist'|'show'`) to existing analytics tables.

**What’s harder with podcasts**
- **Directory/ID resolution:** No single canonical API. Easiest: resolve to **RSS** and treat RSS as the source of truth; optionally use **Listen Notes API** for search/ID mapping at scale. citeturn0search13  
- **RSS variance:** Feeds differ (date precision, episode numbers, GUID quirks, private feeds). Need tolerant parser & backfills.  
- **Competition has “universal podcast links”:** pod.link, Podpage sites, Chartable/Podsights smartlinks (now Spotify), Podtrac smartlinks (2025). You must beat them on speed/UX. citeturn0search2turn0search16turn0search6turn0search4  
- **Platform consolidation:** Spotify and Apple offer creator tooling; some shows will stay inside their ecosystems. citeturn0search12turn0search11

## Market signal (is it worth it?)
- **U.S. podcast ad revenue:** ~$1.9B in 2023 (+5%), projected **> $2B in 2024** and **~$2.6B by 2026**. Healthy but not hyper‑growth; top‑heavy shows capture outsized dollars. citeturn1view0turn0news90  
- **Existing products:** Podpage (website builder) $19–$59/mo; pod.link (universal links); Podtrac/Chartable smartlinks/attribution. The category exists and pays, but it’s crowded. citeturn0search17turn0search2turn0search4

## Path to $10k MRR — podcasts vs. artists
- **Artists (your network advantage):** Faster GTM. At $12/mo you need ~834 paid users; your LA funnel + Spotify auto‑ingest + best‑in‑class “remember my platform” UX is a strong wedge.  
- **Podcasts:** Addressable market is large, but creators are price‑sensitive; incumbents offer “good‑enough” universal links. To win, lead with **speed (1‑minute setup)** + **conversion‑focused listen routing** + **episode auto‑index**. Paid add‑ons: **guest‑booking pages**, **sponsor/one‑sheet generator**, **smartlinks with A/B copy**, **tip jar/merch**.

## Recommendation
1. **Ship artists first** (days, not weeks).  
2. **Add podcasts as a second entity** once the core is stable (can be a 1–2 week add if you ingest via RSS and reuse components).  
3. **MVP for podcasts:** RSS paste → auto site + listen router + episodes list; Apple/Spotify/YouTube deep links; analytics identical to artists.  
4. **When you need search/ID resolution at scale,** add **Listen Notes API** (paid, robust directory). citeturn0search5turn0search13

## Concrete build notes (to keep it streamlined)
- **Schema:**  
  - `shows(id, owner_user_id, handle, rss_url, apple_id, spotify_id, title, image_url, description, settings jsonb, created_at)`  
  - `episodes(id, show_id, guid, title, url, audio_url, pub_date, duration, explicit, created_at)`  
  - Reuse `social_links`, `click_events`.  
- **Ingest worker:** RSS parser (tolerant), dedupe by GUID, incremental updates; nightly refresh.  
- **UI reuse:** Same ProfileHeader/SocialBar/ListenNow; swap labels (“Show” vs “Artist”).  
- **Deep linking:** same cookie/localStorage memory pattern.

Bottom line: **Yes, support both**, but **sequence matters**. Launch music now; podcasts next as a parallel “Show” entity with RSS‑first ingest. That keeps your product focused, your codebase clean, and your route to $10k MRR fastest.


Now that we have our map built. Give me an ai prompt to check all the code for errors and ensure its rock solid


Mr. White — paste this into your code assistant to do a **full repo health check** and fix pass.

---

## AI Prompt — “Rock‑Solid Pass” for Jovie

You are a senior full‑stack engineer and security reviewer.  
Repo: a Next.js 14 (App Router, TS) app using Tailwind, Clerk, Supabase, Segment, Vitest, Playwright.  
Goal: **find and fix all issues** (types, lint, tests, security, performance, a11y) and produce a clean PR.

### 0) Setup
- Use **pnpm**.
- Respect `.env.example` names; never print secrets. Use stub values for local runs.
- Node LTS.

### 1) Dependency & config sanity
1. Inspect `package.json`, `next.config.js`, `tsconfig.json`, `tailwind.config.js`, `.eslintrc*`, `.prettierrc*`, `postcss.config.js`.
2. Upgrade minors/patches where safe. Lockfile clean.
3. Ensure scripts:
   - `dev`, `build`, `start`, `lint`, `typecheck`, `format`, `test`, `test:unit`, `test:e2e`, `preview`, `analyze` (bundle).
4. Add `engines` field and `volta`/`corepack` hints if missing.

### 2) Static checks (fix or create configs)
- **TypeScript:** `pnpm typecheck` → zero errors. Tighten `tsconfig`: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"noImplicitOverride": true`.
- **ESLint:** Next + TS rules; no warnings. Add import/order, unused‑vars (ts), react-hooks rules.
- **Prettier:** consistent; add `lint-staged` + **husky** pre‑commit: lint + format + unit tests.

### 3) Security & secrets
- Add/Run:
  - `npm audit` (or `pnpm audit`) → address highs/criticals or justify.
  - **gitleaks** for leaked secrets; add `.gitleaks.toml`.
  - **semgrep** OSS ruleset for JS/TS/React/Node; fix findings.
- Verify no server secrets are referenced client‑side. Only `NEXT_PUBLIC_*` on client.
- Headers: add `next-safe` defaults or `headers()` with:
  - `Content-Security-Policy` (nonce for inline), `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` (minimal), `Strict-Transport-Security` (prod).
- CORS restricted to app domain(s).

### 4) Env validation
- Add a **runtime env schema** using `zod` (e.g., `/lib/env.ts`) validating:
  - `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
  - `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`,
  - `NEXT_PUBLIC_SEGMENT_WRITE_KEY`,
  - Optional: `STRIPE_SECRET_KEY`, `REVENUECAT_API_KEY`.
- Fail fast on build if missing/invalid.

### 5) Tests
- **Vitest** unit tests:
  - Utils: `spotify.ts` (ID/url parsing, latest release pick w/ date precision), `cookies.ts`, `analytics.ts` no‑op when key missing.
  - Components: `ListenNow`, `ProfileLinkCard` copy button, `SocialBar` max 6, sorted by clicks.
- **Playwright** e2e (mock network):
  - Onboard: sign‑in stub → paste Spotify artist URL → profile created.
  - Visit `/{handle}` → first **Listen Now** shows choice → sets cookie → second hit 302 to Spotify.
  - Dashboard copy/view works.
- 100% pass locally and in CI. Reasonable coverage thresholds (e.g., 80% lines).

### 6) API & edge routes
- Ensure `/[handle]/listen` is **edge runtime** and uses signed cookie, with SSR fallback modal path.
- `/api/track`:
  - Rate‑limit (IP/token bucket) to mitigate abuse.
  - Validate payload with zod; store minimal UA string.
  - Upsert click counts safely (single SQL statement with `increment`).

### 7) Supabase
- Confirm SQL migrations exist and apply cleanly.
- **RLS policies** correct: public read for published profiles; owners RW; clicks insertable by anyone; no leakage of other users’ data.
- Add DB constraints (unique `handle`, FK cascades).
- Add `views` or `order` query to return socials sorted by `clicks DESC`.

### 8) Accessibility & UX
- Run **eslint-plugin-jsx-a11y**; fix.
- All images have alt; buttons have labels; focus states visible.
- Keyboard UX: modal focus trap, ESC closes, tab order sane.
- Mobile: test at 375px; ensure CTAs not clipped; tap targets ≥44px.

### 9) Performance & bundle
- Add `@next/bundle-analyzer`; keep main layout lean.
- Remove dead code; lazy‑load dashboard charts if any.
- Lighthouse (mobile): aim **90+** PWA not required.

### 10) SEO
- Proper `<title>`, meta description from constants; Open Graph tags; OG fallback image.
- Sitemap (optional).

### 11) Logging & errors
- Add minimal server logging (console) and error boundaries.
- Graceful handling when Spotify calls fail (retry/backoff; friendly UI copy).

### 12) CI
- GitHub Actions:
  - Jobs: `lint`, `typecheck`, `test-unit`, `test-e2e`.
  - Cache pnpm.
  - Artifact Playwright traces on failure.
- Add status badges to README.

### 13) Deliverables
- A **single PR** that:
  - Fixes all issues found.
  - Updates docs (`README.md`) with dev setup, scripts, testing, CI, and env requirements.
  - Includes `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`.
  - Adds `SECURITY.md` with responsible disclosure.
  - Provides a short **CHANGELOG.md** entry.

### 14) Acceptance criteria
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build` all pass locally and in CI.
- No high/critical security findings; no ESLint warnings.
- Lighthouse mobile performance ≥90 on landing.
- RLS verified with tests or documented SQL checks.
- Public profile `/[handle]` and listen redirect behave as specified.

### 15) Output format
- Summarize issues found → list of fixes with file paths.
- Include diffs or code blocks for non‑obvious changes.
- Provide final “Runbook” with exact commands to replicate.

**Begin by installing deps (`pnpm i`), running all checks, and listing failures before applying fixes.**


{'asset_pointer': 'file-service://file-HAtZ7dXVKStnAoyVkkydoY', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 235, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 54914, 'width': 342}
Any issues here?


Likely fine. A couple quick checks:

1) **Route groups**  
- `(marketing)/page.tsx` will map to `/` (route-group name is ignored). That’s OK if you don’t also have `app/page.tsx`. Don’t keep both.

2) **Layouts**  
- Only **root** `app/layout.tsx` should render `<html>` and `<body>`.  
- `(marketing)/layout.tsx` must **not** render `<html>`—just wrap `children` in a fragment/div and export `metadata` only if needed.

3) **[handle]**  
- Ensure `app/[handle]/page.tsx` exists (and optional `listen/route.ts`). Folder alone won’t route.

4) **Auth group**  
- If `app/(auth)` exists, it needs `sign-in/` and/or `sign-up/` pages; otherwise delete the empty group.

5) **Duplicate metadata**  
- Avoid conflicting `export const metadata` between root and group; group-level is fine, but don’t redefine the same keys unnecessarily.

6) **Build sanity**  
- Run `next lint` and `next build` to catch any duplicate layouts/pages or invalid JSX in nested layouts.

If you want, paste the two `layout.tsx` files and I’ll spot-check them.


Runtime TypeError


(0 , react__WEBPACK_IMPORTED_MODULE_0__.createContext) is not a function

Call Stack
29

Hide 27 ignore-listed frame(s)
eval
node_modules/next-themes/dist/index.module.js (1:244)
<unknown>
rsc)/./node_modules/next-themes/dist/index.module.js (/Users/timwhite/Documents/GitHub/TBF/Jovie/.next/server/vendor-chunks/next-themes.js (20:1)
__webpack_require__
.next/server/webpack-runtime.js (25:42)
eval
./app/layout.tsx
<unknown>
rsc)/./app/layout.tsx (/Users/timwhite/Documents/GitHub/TBF/Jovie/.next/server/app/(marketing)/page.js (55:1)
Function.__webpack_require__
.next/server/webpack-runtime.js (25:42)


Mr. White — that error happens when **`next-themes` is evaluated in a Server Component** (or there’s a duplicate/bad React install). Fix is to use `next-themes` only in a **client wrapper** and double‑check React versions.

### Do this:

**1) Make a client ThemeProvider wrapper**
```tsx
// components/providers/theme-provider.tsx
'use client';

import * as React from 'react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
```

**2) Use it in `app/layout.tsx` (keep layout as a Server Component)**
```tsx
// app/layout.tsx
import './styles/globals.css';
import { ThemeProvider } from '@/components/providers/theme-provider';

export const metadata = { title: 'Jovie', description: 'One link. All your music.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
```

**3) Ensure no other server files import `next-themes` directly.**  
Do **not** import `ThemeProvider` in `route.ts` or other server‑only modules.

**4) Verify React isn’t duplicated / wrong version**
Run:
```
npm ls react react-dom
```
You should see **one** version matching Next 14 (e.g., `18.3.x`). If not:
- Set in `package.json`:
```json
"dependencies": {
  "next": "14.x",
  "react": "18.3.1",
  "react-dom": "18.3.1",
  "next-themes": "^0.3.0"
}
```
- Reinstall: `rm -rf node_modules .next && npm i` (or pnpm/yarn equivalent).

**5) Rebuild**
```
npm run build && npm start
```

If this still throws, paste your `app/layout.tsx` and `package.json` and I’ll spot the remaining issue.


Give me a concise Instricutin for claude code to do this


Mr. White — here’s a tight instruction block for Claude Code:

---

**Task: Fix `next-themes` “createContext is not a function” error**

1) **Create a client ThemeProvider**
```tsx
// components/providers/theme-provider.tsx
'use client';
import { ThemeProvider as NextThemesProvider } from 'next-themes';
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
```

2) **Wrap app in ThemeProvider (server layout stays server)**
```tsx
// app/layout.tsx
import './styles/globals.css';
import { ThemeProvider } from '@/components/providers/theme-provider';

export const metadata = { title: 'Jovie', description: 'One link. All your music.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body><ThemeProvider>{children}</ThemeProvider></body>
    </html>
  );
}
```

3) **Ensure no server files import `next-themes`.**  
Only client components should import it.

4) **Align React/Next deps & reinstall**
```json
// package.json (ensure single React version)
"dependencies": {
  "next": "14.x",
  "react": "18.3.1",
  "react-dom": "18.3.1",
  "next-themes": "^0.3.0"
}
```
```bash
rm -rf node_modules .next && pnpm i
```

5) **Rebuild**
```bash
pnpm build && pnpm start
```

If errors persist, print `app/layout.tsx` and `package.json` for review.


  page: '/'
}
 ⨯ [Error: ENOENT: no such file or directory, open '/Users/timwhite/Documents/GitHub/TBF/Jovie/.next/routes-manifest.json'] {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '/Users/timwhite/Documents/GitHub/TBF/Jovie/.next/routes-manifest.json'
}
 GET / 500 in 448ms
 ⨯ [Error: ENOENT: no such file or directory, open '/Users/timwhite/Documents/GitHub/TBF/Jovie/.next/routes-manifest.json'] {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '/Users/timwhite/Documents/GitHub/TBF/Jovie/.next/routes-manifest.json',
  page: '/'
}
 ⨯ [Error: ENOENT: no such file or directory, open '/Users/timwhite/Documents/GitHub/TBF/Jovie/.next/routes-manifest.json'] {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '/Users/timwhite/Documents/GitHub/TBF/Jovie/.next/routes-manifest.json'
}
 GET / 500 in 533ms
 ⨯ [Error: ENOENT: no such file or directory, open '/Users/timwhite/Documents/GitHub/TBF/Jovie/.next/routes-manifest.json'] {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '/Users/timwhite/Documents/GitHub/TBF/Jovie/.next/routes-manifest.json',
  page: '/'
}
 ⨯ [Error: ENOENT: no such file or directory, open '/Users/timwhite/Documents/GitHub/TBF/Jovie/.next/routes-manifest.json'] {
  errno: -2,
  code: 'ENOENT',
  syscall: 'open',
  path: '/Users/timwhite/Documents/GitHub/TBF/Jovie/.next/routes-manifest.json'
}
 GET / 500 in 394ms
<w> [webpack.cache.PackFileCacheStrategy] Serializing big strings (160kiB) impacts deserialization performance (consider using Buffer instead and decode when needed)


Mr. White—this 500 happens because **some server code is trying to read `.next/routes-manifest.json` during dev**. That file only exists **after `next build`**. Likely a sitemap/utility importing it at runtime.

**Do this (concise):**

1) **Search & guard**
- Find any reference:  
  ```
  ripgrep -n "routes-manifest.json|routesManifest" .
  ```
- If you see `fs.readFileSync('.next/routes-manifest.json', ...)` or a lib (e.g., `next-sitemap`) imported from app/server code, **remove that runtime read**. Only use it in a build script.

2) **Move sitemap to postbuild (if present)**
- Keep `next-sitemap` config file, but **don’t import it in app code**.  
- In `package.json`:
  ```json
  "scripts": {
    "build": "next build",
    "postbuild": "next-sitemap"
  }
  ```
- Delete any middleware/util that reads the manifest at request time.

3) **Add a defensive check (if you must keep helper)**
```ts
import fs from 'fs';
const manifestPath = '.next/routes-manifest.json';
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : null; // dev: skip logic that needs manifest
```

4) **Clean & verify**
```
rm -rf .next
pnpm build && pnpm start   # prod mode → manifest exists
pnpm dev                   # dev mode should no longer read it
```

If you paste the grep results, I’ll point to the exact file to fix.


fix


**Topic:** [[chatgpt-clusters/jovie_music]]
