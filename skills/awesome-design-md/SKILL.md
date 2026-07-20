---
name: awesome-design-md
description: >
  Curated library of 70+ real product DESIGN.md specs (Stripe, Linear, Vercel,
  Apple, Supabase, Notion, etc.) for reference-driven frontend design. Use when
  matching an existing brand's visual language, bootstrapping a DESIGN.md for a
  project, or studying how top teams document typography, color, spacing, and
  component tokens.
license: Complete terms in the source repo (VoltAgent/awesome-design-md).
---

# Awesome Design MD

A reference corpus of real-world `DESIGN.md` files from leading product teams.
Each entry documents a brand's design language: typography scale, color tokens,
spacing, radii, shadows, component conventions, and voice.

## When to use

- "Match Stripe's design language", "what does Linear's DESIGN.md look like",
  "give me Vercel-style tokens", "bootstrap a DESIGN.md for my app"
- Studying how a specific company encodes its visual system
- Grounding a frontend build in a proven, named aesthetic rather than a generic default

## Corpus layout

The corpus lives in this skill directory under `design-md/<brand>/`:

```
design-md/
  stripe/DESIGN.md      # tokens + component conventions
  stripe/README.md      # source + notes
  linear.app/DESIGN.md
  vercel/DESIGN.md
  supabase/DESIGN.md
  ... (70+ brands)
```

Browse the list:

```
ls design-md/
```

## How to apply

1. Identify the target brand(s) from the user's brief.
2. Read `design-md/<brand>/DESIGN.md` and extract the concrete token system
   (color hexes, type scale, spacing, radius).
3. Derive a compact token table for the build, citing the source brand.
4. If the brief is open-ended, pick the brand whose world fits the subject —
   do NOT fall back on the three AI-default looks (cream+serif+terracotta,
   near-black+acid accent, broadsheet hairline). Follow the frontend-design
   skill's guidance on distinctiveness.

## Contract

- This skill is a **read-only reference corpus** — it does not generate design
  opinions on its own; it supplies sourced tokens others can build from.
- Never present a brand's tokens as original; attribute the source brand.
- Keep the corpus path relative so it travels with the skill.

## Anti-Patterns

- Inventing token values instead of reading the actual DESIGN.md.
- Applying a brand's language where the brief explicitly wants something else.
- Dumping an entire DESIGN.md into context when only the token table is needed
  (prefer `ctx_execute` / targeted reads when context-mode is active).

## Output Format

When asked for a brand's design language, return a compact token table — named
palette (hex), type scale, spacing/radius, component conventions — and cite the
source `design-md/<brand>/DESIGN.md`. Do not paste the full DESIGN.md; extract
the decisive tokens. When bootstrapping a project DESIGN.md, produce the token
block in the same structure as the referenced brands.
