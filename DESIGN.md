# DESIGN.md

The design system source of truth for gbrain. Born from the de facto tokens
that landed in `admin/src/index.css` during the v0.26.0 admin SPA work and
formalized during the v0.36.0.0 Hindsight calibration wave's design review.

This doc is the calibration target for `/plan-design-review` and `/design-review`.
When a question is "does this UI fit the system?", the answer is here.

## Voice

GBrain talks like a smart friend who knows your past, not a clinical scoring
system. Every user-facing string passes through this filter:

- Second person, contractions allowed.
- Grounded in concrete data the user can verify ("2 of 3 missed" beats
  "Brier 0.31").
- Never preachy. Never "we recommend." Never "according to your data."
- Short. Under 25 words for narrative; under one line for status.
- Numbers grounded in real outcomes, never abstract metrics without
  translation.

Five surfaces use this voice (v0.36.0.0+):
`pattern_statement`, `nudge`, `forecast_blurb`, `dashboard_caption`,
`morning_pulse`. All five pass through `gateVoice()` in
`src/core/calibration/voice-gate.ts` with mode-specific rubrics. A Haiku
judge rejects academic-sounding candidates; up to 2 regens; then fall
back to a hand-written template from `src/core/calibration/templates.ts`.

## Color tokens

CSS variables in `admin/src/index.css`. SVG renderer inlines literals
matching these tokens (`src/core/calibration/svg-renderer.ts`).

| Token              | Value     | Use                                       |
|--------------------|-----------|-------------------------------------------|
| `--bg-primary`     | `#0a0a0f` | Page background                           |
| `--bg-secondary`   | `#14141f` | Sidebar, cards                            |
| `--bg-tertiary`    | `#1e1e2e` | Subtle surfaces, borders                  |
| `--text-primary`   | `#e0e0e0` | Body text                                 |
| `--text-secondary` | `#888`    | Headings, labels                          |
| `--text-muted`     | `#777`    | Tertiary text — TD2 bumped from #555 for WCAG AA contrast (~5.5:1) |
| `--accent`         | `#3b82f6` | Active states, links, primary CTAs        |
| `--success`        | `#22c55e` | Healthy / ok status                       |
| `--warning`        | `#f59e0b` | Doctor warnings                           |
| `--error`          | `#ef4444` | Failures, destructive confirmations       |

Dark theme is the only theme. No light mode toggle planned — admin is an
operator tool, not a marketing surface. Users live in the terminal with a
dark theme already.

WCAG contrast:
- Body text (#e0e0e0 on #0a0a0f) → ~14:1, AAA
- Muted text (#777 on #0a0a0f) → ~5.5:1, AA (was 4.0 / fail before TD2)
- Accent links (#3b82f6 on #0a0a0f) → ~5.7:1, AA

## Typography

| Variable           | Value                       | Use                            |
|--------------------|-----------------------------|---------------------------------|
| `--font-sans`      | `Inter, system-ui, sans-serif` | UI text, headings, body         |
| `--font-mono`      | `JetBrains Mono, monospace` | Numbers, slugs, code, terminal-ish data |

Type scale (de facto, not formalized yet):
- 18px: sidebar logo / page title
- 14px: body
- 13px: nav items
- 12px: chart captions, secondary labels
- 11px: tertiary labels in dense charts

Numbers in tables and metrics use JetBrains Mono so column alignment is
mechanical. Avoid mixing Inter and JetBrains Mono in the same line.

## Spacing scale

4 / 8 / 16 / 24 / 32px. Linear-app-style density: 24-32px between major
sections, 16px between row groups, 8px within a row. The Calibration tab
(approved variant-B mockup) is the canonical example.

## Layout

- Sidebar 200px on the left. Active item gets a 3px left-border in `--accent`.
- Main content area uses the remaining width.
- Max content width: 720px for text-heavy pages (Calibration), 960px for
  data tables (Request Log).
- No 3-column feature grids. No icons in colored circles. No decorative blobs.
- Cards earn their existence — heading + content works without a card frame
  in most cases.

## Charts

Server-rendered SVG via `src/core/calibration/svg-renderer.ts`. Pure
functions: data → SVG string. No DOM, no React component, no chart library.

XSS posture: server-side `escapeXml()` on every caller-controlled string.
Numeric inputs `.toFixed()`-coerced. Admin SPA renders via
`<TrustedSVG>` wrapper with `dangerouslySetInnerHTML`. Endpoint gated by
`requireAdmin` middleware.

Why server-rendered SVG (per D23):
- Chart logic stays close to the data math.
- Zero new client-side chart-library dep.
- SVG is accessible (text labels), scalable, copy-paste-friendly to PR
  descriptions and docs.
- Sets the precedent for future admin charts (contradictions trend, takes
  scorecard, etc.).

Four chart renderers in v0.36.0.0:
- `renderBrierTrend({ series })` — sparkline + baseline reference at 0.25
- `renderDomainBars({ bars })` — horizontal accuracy bars
- `renderAbandonedThreadsCard(threads)` — text rows + "revisit now" links
- `renderPatternStatementsCard(statements)` — clickable drill-down anchors

## Interaction patterns

- Keyboard navigation is REQUIRED for all CLI interaction surfaces. The
  propose-queue review uses J/K/space/u/q shortcuts (gmail-style).
- Loading states: "Loading...". Don't show spinners on sub-200ms operations.
- Empty states ARE features: warmth + primary action + context. Cold-brain
  Calibration page tells the user EXACTLY how to build a profile, not
  "no data available."
- Error states: name what failed + name the next step. Never "an error
  occurred — please try again."

## What's NOT here yet (v0.37+ roadmap)

- Type scale formalization (current values are de facto, not enforced)
- Animation tokens (admin SPA has zero animations on purpose; v0.37 may
  add subtle progress / loading transitions)
- Print stylesheet
- Light mode (NOT planned — see "Dark theme is the only theme" above)
- Component library extraction (the React components live inline in admin/src/pages/;
  no `<Button>` / `<Card>` abstraction layer yet)

## How to use this document

When adding a new UI surface to gbrain:

1. Pick existing tokens before introducing new ones. New tokens go through
   `/plan-design-review`.
2. Match the voice rules. Run candidates through `gateVoice()` before
   shipping any user-facing string in the calibration surfaces.
3. Match the spacing scale and density. Linear-calm-clarity over
   dashboard-card-mosaic.
4. Match the typography: Inter for UI, JetBrains Mono for numbers.

When updating this document: it's a living target, not a frozen spec.
Major changes go through `/plan-design-review` to keep the system coherent.
