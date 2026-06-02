---
title: "Tech stack advice"
type: essay
created: 2025-10-30
updated: 2025-10-30
source: chatgpt-export
topic: coding-mobile
message_count: 14
tags: [chatgpt, knowledge, coding-mobile]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-mobile]]

# Tech stack advice

> **Source:** ChatGPT conversation
> **Date:** 2025-10-30T20:10:45Z
> **Messages:** 14
> **Topic:** coding-mobile

## Question

For log your body we currently use a mono repo with iOS swift app and next.js web app. We have an offline sync manager so data can sync between them and use vercel and clerk for auth and supabase.

We'll also use revenuecat and stripe for payments.

I want to use shadecn ui on the web and and tailwind 4 but have the swift iOS app us liquid glass so it feels great and native.

I want them to match in look though.

It's dark mode only.

I also am considering switch to neon for db and using drizzle.

Does that make sense and what other stuff should i change or improve in the stack?

Were prelaunch so making changes that are breaking is fine

## Answer

Mr. White — your stack mostly makes sense. Here’s how I’d tighten it, keep it consistent across iOS + web, and avoid future pain.

# What to keep / adjust
- **Monorepo**: 👍 Keep. Use Turborepo + pnpm workspaces; one shared `packages/` folder for design tokens, types, validation, API clients.
- **Auth (Clerk + Supabase)**: Pick **Clerk** as the user system and **map Clerk → Supabase RLS** (JWT custom claims with `sub`/`user_id`). Do **not** use Supabase Auth simultaneously.
- **DB (Supabase vs Neon) + ORM (Drizzle)**  
  - Pre-launch, staying on **Supabase Postgres** is simpler (storage, realtime, functions, RLS docs).  
  - If you *need* DB branching and autoscaling now, go **Neon + Drizzle** and replace Supabase Storage/Realtime with alternatives (Cloudflare R2 + Pusher/Ably or ElectricSQL).  
  - Either way, **use Drizzle** for schema + migrations to keep portability.
- **Payments**:  
  - **Web**: Stripe Checkout + Customer Portal.  
  - **iOS**: RevenueCat for IAP.  
  - Use webhooks (Stripe + RevenueCat) to write a single **`user_entitlements`** table; server is the source of truth. Support account linking so mobile and web benefits match.
- **Hosting**: Next.js on Vercel is fine. Use Server Actions or tRPC (pick one) + Zod shared types.

# Offline sync (critical)
- Decide now between:
  1) **Operational/CRDT approach** (Automerge/ElectricSQL) → best for conflict-heavy logs, true offline-first.  
  2) **Last-write-wins + per-record versions** (simpler; OK if collisions are rare).
- Suggested pragmatic setup:
  - **iOS**: on-device **SQLite** (GRDB) with change stamps.  
  - **Web**: **IndexedDB (Dexie)** mirror.  
  - **Sync service**: server endpoint that accepts deltas; returns merged changes + tombstones.  
  - Background jobs: **BGTaskScheduler** (iOS) + service worker sync (web).  
  - If you want turn-key replication: **ElectricSQL (Postgres↔SQLite)** works well with Drizzle types.

# Matching look & feel (dark-only)
- **Design Tokens as a package** (`packages/design-tokens`): colors, spacing, radii, shadows, typography, motion.
  - Author tokens in JSON; build with **Style Dictionary**.
  - **Web**: export tokens to CSS variables consumed by **Tailwind v4** + **shadcn/ui**.  
  - **iOS (SwiftUI)**: generate Swift code/assets from the same JSON (e.g., `DesignSystem.Color.primary`, `Font.body`, corner radii, shadow presets).
- **“Liquid glass” feel on iOS**: use **SwiftUI** with `Material` (blur), spring animations, and **Haptics** (CoreHaptics) for key interactions.  
- **Match on web**: shadcn components + Tailwind `backdrop-blur`, opacity layers, motion (Framer Motion) with reduced-motion fallbacks.  
- Accessibility: maintain WCAG contrast in dark mode; test dynamic type (iOS) and `prefers-contrast` (web).

# Security & privacy (you’re handling health-ish data)
- Enforce **Postgres RLS** everywhere; all tables keyed by `user_id`.
- Encrypt sensitive columns app-level (libsodium/NaCl) with keys in Keychain (iOS) and httpOnly cookies/

*(Answer truncated — 5142 chars total)*

## Question

How would drizzle work is we have iOS and next.js apps

## Answer

Mr. White — short version: **Drizzle runs only on your server (Next.js)**. The iOS app never talks to Drizzle; it talks to your API. Here’s the clean, production-grade way to wire it up.

# How Drizzle fits with iOS + Next.js

**Flow**
1) iOS (Swift) ⟷ **HTTPS API** (Next.js Route Handlers/Server Actions)  
2) API uses **Drizzle ORM** to read/write Postgres (Supabase or Neon).  
3) Auth comes in via Clerk; the API enforces **RLS** using a per-request session variable.  
4) Offline sync = two endpoints (`/sync/pull`, `/sync/push`) that read/write deltas in a transaction via Drizzle.

---

## Monorepo shape
```
apps/
  web/                # Next.js (server-only Drizzle usage)
  ios/                # Swift app (no Drizzle here)
packages/
  db/                 # drizzle schema + migrations + types
  validation/         # zod schemas (derive OpenAPI)
  design-tokens/      # shared tokens (Tailwind + Swift)
```

---

## Drizzle on the server (Next.js)

**Schema (packages/db/schema.ts)**
```ts
import { pgTable, uuid, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const entries = pgTable("entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  kind: text("kind").notNull(),        // e.g. "weight", "bp", "note"
  payload: text("payload").notNull(),  // JSON string; or use jsonb if preferred
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  deleted: boolean("deleted").notNull().default(false),
});
```

**Config (packages/db/drizzle.config.ts)**
```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

**Runtime client (apps/web/src/db.ts)**  
- Use **pg** (Node runtime) or **neon-http** (Edge). Choose one per route.
```ts
// Node runtime example
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool);
```

---

## Enforcing per-user access (RLS-friendly)

Whether you’re on Supabase or Neon, use a session variable so every query “knows” the user. This works great with Drizzle.

**SQL once in your DB**
```sql
-- Enable RLS
alter table entries enable row level security;

-- Use a session variable set by your API: app.user_id
create policy tenant_isolation on entries
  using (user_id = current_setting('app.user_id', true)::uuid)
  with check (user_id = current_setting('app.user_id', true)::uuid);
```

**Before any query in a request (apps/web/app/api/_lib/session.ts)**
```ts
import { db } from "@/db";
import { sql } from "drizzle-orm";

export async function setRlsUser(userId: string) {
  await db.execute(sql`select set_config('app.user_id', ${userId}, true)`);
}
```

**In a route handler**
```ts
import { auth } from "@clerk/nextjs/server";   // get userId
import { db } from "@/db";
import { setRlsUse

*(Answer truncated — 7925 chars total)*

## Question

I want to go Operational/CRDT approach (Automerge/ElectricSQL) → best for conflict-heavy logs, true offline-first. For offline sync but whats the best way to do it

## Answer

Mr. White — if you’re going CRDT/local-first, the cleanest “don’t reinvent sync” path is:

## Recommendation (TL;DR)
- **Use ElectricSQL for all structured data** (entries, metrics, tags, etc.). It gives you bi-directional, active-active sync between **Postgres ⇄ local SQLite/PGlite**, dynamic **partial replication via Shapes**, and handles conflicts for you. citeturn1search4turn1search0turn1search2  
- **Use Automerge only for free-form documents** (rich notes, long text) where CRDT text editing shines. Sync it via their websocket repo adapter. citeturn0search6

---

## What this looks like

### Server
- Keep **Postgres** (Supabase or Neon).  
- Deploy the **Electric sync service** (Docker) connected to Postgres logical replication. citeturn1search12  
- Keep **Drizzle** for migrations + any server-side writes (webhooks: Stripe/RevenueCat) — Electric will fan those changes down to clients. citeturn1search4  
- **Auth to Electric**: add a Next.js “gatekeeper” endpoint that validates Clerk, then issues **shape-scoped tokens** (or proxy Electric behind your API). citeturn0search8turn1search9

### Web
- Local DB: **PGlite** (Postgres-in-browser) or SQLite-OPFS; Electric streams shapes into it. (Drizzle can talk to PGlite if you want a familiar querying layer.) citeturn0search21turn0search3  
- Subscribe to shapes (per-user subsets like “my last 90 days”) and render reactive queries. citeturn1search0turn1search2

### iOS
- Use the **Electric Swift client** (or their HTTP API if you need lower OS targets). It syncs shapes into a local store (SwiftData/SQLite) and keeps SwiftUI views live. citeturn1search7turn1search9  
- For rich notes, keep a local **Automerge** document and connect a websocket sync peer when online. citeturn0search6

---

## Shapes you’ll likely need (examples)
- `entries where user_id = :uid and updated_at > now() - interval '90 days'`
- `entry_items where user_id = :uid`
- `entitlements where user_id = :uid` (so billing flips features offline too)

Shapes are the primitive Electric uses for **dynamic partial replication**; they’re single-table with optional `WHERE` and column selection. citeturn1search0

---

## Conflict strategy (practical)
- **Electric**: row/field-level convergence with **causal+** guarantees; treat Postgres as the shared truth, but clients can write offline to local DB and sync later. You don’t write merge code. citeturn1search4  
- **Automerge**: perfect for concurrent text edits; store only a small pointer (doc id/version) in Postgres; persist the CRDT blob as a bytea/object when you need server backup. citeturn0search6

---

## Auth/RLS model that plays nice
- For Electric access: prefer **gatekeeper tokens** scoped to the user’s shapes (issued by your Next.js API after Clerk verification). citeturn0search8  
- Keep **RLS** on Postgres for your non-Electric routes (Server Actions, webhooks). Electric doesn’t require RLS for client sync itself if you’re gating sha

*(Answer truncated — 4854 chars total)*

## Question

{'asset_pointer': 'sediment://file_000000009d0871f59d09649c34e092c9', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1278, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 780116, 'width': 589}
We need to clean up this UX and make a prompt for this to be a world class interface and fix the issues.

## Answer

Mr. White — here’s a tight UX audit + a “world-class UI” prompt you can drop into a designer/AI workflow, plus concrete fixes.

# What’s off in the screenshot
- **Photo card**: face is cropped; left/right arrows add noise; the **Photo/Avatar** toggle reads like a segmented control but looks secondary.  
- **Duplicate/competing dates** (in hero and weight card).  
- **Timeline scrubber** overlaps the “Current Weight” label; unclear affordance.  
- **Metric semantics**: “Change” lacks timeframe; FFMI has no context; “Today’s steps” is visually weaker than weight.  
- **Hierarchy**: font sizes + weights fight each other; units (“lbs”) should be visually subordinate.  
- **Spacing**: inconsistent gutters; cards are different heights; bottom nav intrudes on content.  
- **Dark-mode polish**: needs softer elevation (blur, inner/outer shadows), better contrast for secondary text, and consistent icon stroke weights.

# Target layout (v2)
1) **Header**: “Good evening” + small sync/status pill (“Just now · Offline OK”).  
2) **Hero**: swipeable **Progress Card** with Photo/Avatar toggle, pager dots (no arrows), date chip (“Nov 2”).  
3) **Primary metric**: **Weight** card (big number; unit minimized), small chips for “Body fat 12.1%” and “Since Aug 1: −16.0 lb”.  
4) **Daily metrics grid (2×2)**: Steps (progress ring to goal), FFMI (with “natty” range hint), Lean Mass, Sleep (or your next KPI).  
5) **Quick actions row**: “Log weight”, “Add photo”, “Scan meal”, “Add workout”.  
6) **Tab bar**: Home · Add · Settings (safe-area aware; doesn’t overlap content).

# Mini design system (dark-only, liquid-glass)
- **Surfaces**:  
  - Base: `#0B0D10`  
  - Card: translucent black with **backdrop-blur 24–30px**, subtle inner highlight, outer shadow (y=8, blur=24, 12% opacity).  
- **Accent**: `#6EE7F0` (teal/cyan) — use for CTAs, progress, active icons.  
- **Radii**: 20 for cards, 28 for hero, 16 for small chips.  
- **Type** (SF Pro / Inter):  
  - Display: 34/Bold; Title: 22/Semibold; Body: 17/Medium; Tertiary: 15/Regular (80% opacity).  
  - Units (`lbs`) as baseline-aligned **caps at 60–65% size**.  
- **Motion**: spring (response 0.35, damping 0.8) for card transitions; blur animates from 0→24ms over 180ms.  
- **Haptics** (iOS): impactLight on tab switch, impactMedium on “Add”; success on save.

# Copy fixes (clarity)
- “Current Weight” → **Weight**  
- Add a timeframe chip: **Since Aug 1** (or last checkpoint).  
- “Today’s Steps” → **Steps** + sublabel “Today”.  
- FFMI → **FFMI 17.0** + helper text **“Within average male range”** (or color-coded band).  
- Replace “Change” with **Change (since X)**, use arrow + color.

---

# The prompt (paste into your design/AI tool)
**Goal:** Redesign the iOS “Home” screen for a fitness logging app. Dark-mode only, **liquid glass** aesthetic that feels native to iOS. Must be production-ready and consistent with a web counterpart using shadcn/tailwind.

**Layout & hierarchy**
- Safe-area aware 390×844 artboard.  
- Sect

*(Answer truncated — 6445 chars total)*

## Question

For the avatars i need it generate a white on black wireframe of a male or female torso only that represents that specific BF%. What the best way to do this?

## Answer

Mr. White — best path: **parametric vector avatars**, not ML. Build a tiny, deterministic **SVG/SwiftUI wireframe** whose geometry and line density are functions of **sex + BF% (and optionally FFMI)**. It stays crisp on web/iOS, is easy to QA, and matches your dark, liquid-glass style.

# What to build
**Inputs**: `sex ∈ {male,female}`, `bf ∈ [min,max]` (M: ~5–35, F: ~12–45), optional `ffmi ∈ [17–23]`  
**Outputs**: white-on-black **silhouette path** + **feature lines** (pec, ab segments, obliques) with opacity driven by BF%.

## 1) Geometry model
Define a torso with ~10–14 landmarks (normalized 0–100 grid):

`LS/RS` shoulders, `LC/RC` chest curve, `LW/RW` waist, `LH/RH` high-hip, plus sternum, navel, rib/oblique anchors.

Create **two anchor shapes per sex**:
- **Lean anchor** (e.g., M 8%, F 18%)
- **Soft anchor** (e.g., M 30%, F 40%)

Store each anchor as cubic Bézier control points. Interpolate anchors with factor  
`f = clamp((bf − min) / (max − min), 0, 1)`.

Optionally add **muscle factor** from FFMI:
- Shoulder width `S = S₀ + kS·ffmi − kSf·f`
- Waist width `W = W₀ + kW·f − kWm·ffmi`
- Abdomen bulge `A = A₀ + σ(bf; μ, s)` (logistic for smooth growth)

## 2) Feature-line visibility (wireframe detail)
Turn lines on/off (or fade) by BF bands:

- **Pec split / clavicle**: opacity `1 − smoothstep(12%, 20%, bf)` (male); softer for female.
- **Serratus/obliques hints**: peak at 10–16%; fade by 22%.
- **Ab segments (| and —)**: visible ≤ ~15% (M) / ~22% (F), reduce count and opacity as BF rises.
- **Side contour** always drawn; thickness can grow slightly with BF for readability.

Keep **stroke only, no fill**; rounded caps/joins.

## 3) Rendering style
- Background `#000` (or your base); **stroke `#FFF`**, `strokeWidth: 2–3` (scale-aware).
- Use a **single source of truth** for tokens (stroke width, radii).
- Front & back variants; crop at clavicles → top of hip crest.

## 4) Production pipeline
1) **Author anchors**: Have an artist draw two clean SVG paths per sex (front/back). Save control points.
2) **Path morphing**:
   - **Web**: interpolate with `flubber` (or your own cubic lerp), render in React SVG.
   - **iOS**: store points, lerp in Swift and build a `Path`.
3) **API**: none required; render client-side from BF%.
4) **Caching**: precompute sprites for common BF% (every 1%) and memoize.
5) **Validation**: generate a grid (sex × BF%) and review side-by-side with reference photos/DEXA exemplars.

---

## Minimal code to get you started

### Web (React + SVG)
```tsx
type Sex = "male" | "female";

type Anchor = { // cubic Bezier segments
  // each segment: [x1,y1, cx1,cy1, cx2,cy2, x2,y2]
  segments: number[][];
};

const anchors: Record<Sex, { lean: Anchor; soft: Anchor }> = { /* fill with artist paths */ };

function lerp(a:number,b:number,t:number){return a+(b-a)*t}
function lerpPath(a:Anchor,b:Anchor,t:number):Anchor{
  return { segments: a.segments.map((seg,i)=>seg.map((v,j)=>lerp(v,b.segments[i][j],t))) as any };
}
function pathD(ancho

*(Answer truncated — 6633 chars total)*

## Question

Give me a prompt to give to claude code to implement this

## Answer

Mr. White — here’s a copy-paste prompt for Claude Code to implement the **white-on-black BF% wireframe avatars** for web (React+TS) and iOS (SwiftUI). It includes structure, APIs, math, and acceptance tests.

---

## Prompt for Claude Code

**Task:** Implement a cross-platform, deterministic **wireframe torso avatar** system that renders a **white-stroke on black** vector of a **male or female torso (front view)** whose geometry and line detail vary with **body-fat percentage (BF%)** and optionally **FFMI**. Deliver a React+TypeScript package for web and a SwiftUI package for iOS. No ML or remote calls; all client-side and parametric.

### Functional requirements
- Inputs:  
  - `sex: "male" | "female"`  
  - `bf: number` (male 5–35, female 12–45; clamp)  
  - `ffmi?: number` (17–23 typical; optional)  
  - `variant?: "front" | "back"` (implement **front** now; leave back stub)
  - `size?: number` px/pt; `strokeWidth?: number` auto-scales with size
- Output: vector wireframe on black:
  - Single closed **silhouette path** (no fill), plus **feature lines** whose opacity depends on BF%
  - Stroke color `#fff`; background `#000`; rounded caps/joins
- Deterministic; pure functions. No runtime layout dependencies.

### Visual logic
- Geometry is **parametric** (no images). Compute a torso from a normalized 100×140 viewBox using widths at key y-levels:
  - `shoulderW`, `chestW`, `waistW`, `hipW`; levels at `yShoulder=18`, `yChest=36`, `yWaist=78`, `yHip=110`
- Map BF% & FFMI to widths:
  - Let `t = clamp01((bf - bfMin) / (bfMax - bfMin))`
  - Baselines (front, in % of viewBox width):
    - **Male**: shoulders `S0=72`, chest `C0=58`, waist `W0=36`, hip `H0=44`
    - **Female**: shoulders `S0=64`, chest `C0=58`, waist `W0=32`, hip `H0=50`
  - BF effects (softening):  
    `S = S0 - 4*t`, `C = C0 + 6*t`, `W = W0 + 20*t`, `H = H0 + 6*t`
  - FFMI effects (muscularity):  
    `S += 1.8*(ffmi-20)`; `W -= 1.2*(ffmi-20)` (clamp to sensible bounds)
- Build left/right contours with 6 cubic segments per side (12 total), mirrored for symmetry; close path. Use smooth control points (handle length ~15% of local width) so curves are organic.
- **Feature lines & opacities** (front):
  - **Clavicle/pec line** (y≈34): `opacity = 1 - smoothstep(12, 20, bf)` for male; use `smoothstep(18, 26)` for female
  - **Upper ab horizontal** (y≈64) & **vertical center**: `opacity = 1 - smoothstep(10, 18, bf)` (male), `1 - smoothstep(20, 28, bf)` (female)
  - **Oblique hints** (diagonals near waist): peak at mid-lean → `opacity = bell(bf; μ=14(M)/22(F), σ=4)`
  - Hide all feature lines when opacity < 0.08
- Stroke width: default 2.5 at 240 size; scale proportionally.

### Packages & files
```
/packages/torso-avatars-web/
  src/TorsoAvatar.tsx
  src/geometry.ts          // parametric path construction
  src/featureLines.ts      // BF→opacity helpers
  src/tokens.ts            // colors, stroke widths
  src/index.ts
  demo/preview.html (Vite) // minimal demo page
  tests/geometry.test.t

*(Answer truncated — 7584 chars total)*

## Question

Just do the iOS version for now

## Answer

Mr. White — here’s a **copy-paste prompt** for Claude Code to implement the **iOS-only** BF% wireframe avatars in SwiftUI.

---

## Prompt for Claude Code (iOS only)

**Task:** Build a Swift Package **`TorsoAvatars`** that renders a **white-stroke on black** vector **torso (front view)** avatar. Geometry and feature-line detail vary with **sex + body fat % (BF%)** and optional **FFMI**. No ML, no network—pure parametric drawing.

### Deliverables
- Swift Package `TorsoAvatars/`
  - `Sources/TorsoAvatars/TorsoView.swift`
  - `Sources/TorsoAvatars/Geometry.swift`
  - `Sources/TorsoAvatars/FeatureLines.swift`
  - `Sources/TorsoAvatars/Tokens.swift`
  - `Tests/TorsoAvatarsTests/*` (XCTest)
- README with usage + parameters.
- SwiftUI preview that shows a **grid** of BF% for male & female.

### Public API
```swift
public enum Sex { case male, female }
public enum Variant { case front /* back TODO */ }

public struct TorsoView: View {
  public init(
    sex: Sex,
    bf: CGFloat,              // clamp: male 5–35, female 12–45
    ffmi: CGFloat? = nil,     // typical 17–23
    variant: Variant = .front,
    size: CGFloat = 240,      // px/pt square
    strokeWidth: CGFloat? = nil,
    showGuides: Bool = false  // dev overlay
  )
}
```
- Renders on **black background**; strokes are **white**, rounded caps/joins.
- Deterministic, pure; no assets.

### Geometry spec (normalized space)
- Use `viewBox = 100 × 140`. Draw in that space, then scale to `size`.
- Key y-levels (front):  
  `yShoulder=18`, `yChest=36`, `yMid=52`, `yUpperAb=64`, `yWaist=78`, `yHip=110`, `yHem=136`
- Widths at levels (percent of viewBox width), computed from BF% and FFMI.

**Mapping (compute `t = clamp01((bf - bfMin) / (bfMax - bfMin))`):**
- Baselines:
  - **Male**: `S0=72, C0=58, W0=36, H0=44`
  - **Female**: `S0=64, C0=58, W0=32, H0=50`
- BF softening:  
  `S = S0 - 4*t`  
  `C = C0 + 6*t`  
  `W = W0 + 20*t`  
  `H = H0 + 6*t`
- FFMI muscularity (optional), centered at 20:  
  `S += 1.8 * (ffmi - 20)`  
  `W -= 1.2 * (ffmi - 20)`  
  Clamp S∈[S0-8,S0+10], W∈[W0-4, W0+24].
- Build **left/right contours** from these widths with ~6 cubic segments per side; mirror for symmetry; **close path**.

**Bezier control rule:** for a segment around width `w`, use handle length `h = w * 0.16` along tangent; ensure C1 continuity between segments.

### Feature lines (front)
- Draw only if resulting opacity ≥ 0.08.
- **Clavicle/pec line** at y≈34:  
  - Male: `opacity = 1 - smoothstep(12, 20, bf)`  
  - Female: `opacity = 1 - smoothstep(18, 26, bf)`
- **Abs**: vertical center (sternum→navel) and one upper horizontal at y≈64:  
  - Male: `opacity = 1 - smoothstep(10, 18, bf)`  
  - Female: `opacity = 1 - smoothstep(20, 28, bf)`
- **Obliques**: two diagonals near waist; opacity from Gaussian bell:  
  `bell(bf; μ=14 (male) / 22 (female), σ=4)`
- Stroke the silhouette slightly thicker than feature lines.

### Tokens & styling
```swift
public enum Tokens {
  public static let bg = Color.black
  public

*(Answer truncated — 5267 chars total)*
