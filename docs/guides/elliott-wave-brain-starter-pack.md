# Elliott Wave Brain Starter Pack

## What this is

This is a copy-pasteable starter pack for turning one or more Elliott Wave
sources into reusable GBrain pages.

These are templates, not canon. The live pages should be created in the target
brain/source repo, not in `gbrain` itself.

The design goal is:

- keep reusable knowledge under `concepts/`
- keep situation-specific execution under `projects/`
- force hard rules, invalidation, alternate counts, and abstain paths
- make future agents safer, not just more confident

## Recommended file set

1. `concepts/elliott-wave-theory.md`
2. `concepts/elliott-wave-rules.md`
3. `concepts/elliott-wave-analysis-checklist.md`
4. `concepts/elliott-wave-when-not-to-trust-the-count.md`
5. Optional: `projects/trading/elliott-wave-playbook.md`

## Template 1: `concepts/elliott-wave-theory.md`

```md
---
title: Elliott Wave Theory
type: concept
status: canonical
confidence: medium
tags:
  - trading
  - technical-analysis
  - elliott-wave
source_artifacts:
  - <book-or-course-title>
updated: YYYY-MM-DD
---

# Elliott Wave Theory

## Core Thesis

Elliott Wave Theory argues that market price movement tends to unfold in
repeating wave structures across multiple timeframes. The practical claim is
not "markets are perfectly predictable." The practical claim is that crowd
behavior can create recurring structures that sometimes improve decision
quality when read carefully. [Source: <source>, <date>]

## Market Structure

- Impulse structure: describe the five-wave move in trend direction.
- Corrective structure: describe the three-wave move against trend direction.
- Fractal behavior: explain how the same structure can appear on higher and
  lower timeframes.

## Terminology

| Term | Plain-English meaning | Why it matters | Source |
|---|---|---|---|
| Impulse | <fill in> | <fill in> | [Source: <source>] |
| Correction | <fill in> | <fill in> | [Source: <source>] |
| Wave degree | <fill in> | <fill in> | [Source: <source>] |
| Invalidation | <fill in> | <fill in> | [Source: <source>] |
| Alternate count | <fill in> | <fill in> | [Source: <source>] |

## What This Theory Can Do

- Help structure a market read when price action is already moving cleanly.
- Provide candidate scenarios and invalidation levels.
- Improve discipline when paired with other evidence.

## What This Theory Cannot Do

- It cannot guarantee a count is correct.
- It cannot replace risk management.
- It cannot turn weak data or noisy charts into strong decisions.
- It should not be treated as proof of future price movement. [Source: compiled
  from <sources>]

## Relationship To Other Tools

- Momentum:
- Market structure:
- Volume:
- Support / resistance:
- Macro / event risk:

## Practical Agent Rule

Future agents should treat Elliott Wave as a bounded interpretive framework.
They must name:

1. the primary count
2. at least one alternate count
3. the invalidation level
4. the reason to abstain, if present

## See Also

- [Elliott Wave Rules](elliott-wave-rules.md)
- [Elliott Wave Analysis Checklist](elliott-wave-analysis-checklist.md)
- [Elliott Wave: When Not To Trust The Count](elliott-wave-when-not-to-trust-the-count.md)
```

## Template 2: `concepts/elliott-wave-rules.md`

```md
---
title: Elliott Wave Rules
type: concept
status: canonical
confidence: medium
tags:
  - trading
  - technical-analysis
  - elliott-wave
source_artifacts:
  - <book-or-course-title>
updated: YYYY-MM-DD
---

# Elliott Wave Rules

## Hard Rules

These are count-breaking rules. If one fails, the count is invalid and must be
rejected or relabeled.

| Rule | What it means | Why it matters | Invalidates count? | Source |
|---|---|---|---|---|
| Wave 2 retrace rule | <fill in> | <fill in> | yes | [Source: <source>] |
| Wave 3 shortest rule | <fill in> | <fill in> | yes | [Source: <source>] |
| Wave 4 overlap rule | <fill in> | <fill in> | yes | [Source: <source>] |

## Soft Guidelines

These help rank competing counts but do not prove a count by themselves.

| Guideline | Typical use | Failure mode | Confidence | Source |
|---|---|---|---|---|
| Alternation | <fill in> | <fill in> | medium | [Source: <source>] |
| Channeling | <fill in> | <fill in> | medium | [Source: <source>] |
| Fibonacci relationships | <fill in> | <fill in> | low-to-medium | [Source: <source>] |
| Personality of waves | <fill in> | <fill in> | low | [Source: <source>] |

## Common Pattern Families

- Impulse:
- Diagonal:
- Zigzag:
- Flat:
- Triangle:
- Combination:

## Invalidations

For each commonly used structure, name the exact price behavior that breaks the
count.

| Structure | Invalidation event | Agent response |
|---|---|---|
| Impulse | <fill in> | discard and relabel |
| Diagonal | <fill in> | downgrade confidence and re-check structure |
| Correction | <fill in> | reopen alternate counts |

## Frequent Misreads

- Forcing five waves into a noisy range.
- Treating every pullback as a correction with predictive meaning.
- Ignoring hard-rule breaks because the narrative feels right.
- Naming only one count and hiding uncertainty.

## Minimum Evidence Before Naming A Count

Do not name a count unless all of these are true:

- the timeframe is explicit
- the count passes hard rules
- at least one alternate count is considered
- the invalidation level is named
- the count is readable enough to explain in plain English

## Agent Rule

If a proposed count fails a hard rule, the agent must say it is invalid. It may
not soften this into "less likely."
```

## Template 3: `concepts/elliott-wave-analysis-checklist.md`

```md
---
title: Elliott Wave Analysis Checklist
type: concept
status: operating
confidence: medium
tags:
  - trading
  - technical-analysis
  - elliott-wave
updated: YYYY-MM-DD
---

# Elliott Wave Analysis Checklist

## Before You Start

- What market?
- What timeframe?
- What is the current decision being made?
- Is this analysis for action, monitoring, or post-mortem only?

## Step 1: Define the timeframe

- Primary timeframe:
- Higher timeframe context:
- Lower timeframe confirmation:

## Step 2: Identify candidate structure

- Candidate primary count:
- Candidate alternate count:
- Key swing points used:

## Step 3: Test against hard rules

- Wave 2 retrace rule: pass / fail
- Wave 3 shortest rule: pass / fail
- Wave 4 overlap rule: pass / fail

If any hard rule fails, stop and relabel.

## Step 4: Score soft guidelines

| Guideline | Supports primary? | Supports alternate? | Notes |
|---|---|---|---|
| Alternation | yes/no | yes/no | <fill in> |
| Channeling | yes/no | yes/no | <fill in> |
| Fibonacci relationships | yes/no | yes/no | <fill in> |
| Wave personality | yes/no | yes/no | <fill in> |

## Step 5: Write competing counts

- Primary count:
- Alternate count:
- Why the primary currently wins:
- What evidence would flip to the alternate:

## Step 6: Name invalidation

- Primary invalidation level:
- Alternate invalidation level:
- What exact price action would prove the current read wrong:

## Step 7: Decide act / watch / abstain

- Action stance: act / watch / abstain
- Why:
- What uncertainty still matters:

## Output Format

- Primary count:
- Alternate count:
- Hard-rule status: pass / fail
- Soft-guideline score: low / medium / high
- Invalidation level:
- What would prove me wrong next:
- Action stance: act / watch / abstain

## Agent Rule

An Elliott Wave answer without an alternate count or invalidation level is
incomplete.
```

## Template 4: `concepts/elliott-wave-when-not-to-trust-the-count.md`

```md
---
title: Elliott Wave: When Not To Trust The Count
type: concept
status: guardrail
confidence: high
tags:
  - trading
  - technical-analysis
  - elliott-wave
updated: YYYY-MM-DD
---

# Elliott Wave: When Not To Trust The Count

## Purpose

This page exists to stop overconfident pattern fitting.

## Low-Quality Contexts

- low-liquidity charts
- highly event-driven price action
- choppy ranges with too many plausible labels
- charts where the count only works after repeated relabeling

## Warning Signs

| Warning sign | Why it breaks reliability | What to do instead | Source |
|---|---|---|---|
| Too many relabels | <fill in> | zoom out or abstain | [Source: <source>] |
| Hard-rule near miss rationalized away | <fill in> | reject the count | [Source: <source>] |
| No alternate count | <fill in> | force one before acting | [Source: compiled from <sources>] |
| Count depends on one exact tick interpretation | <fill in> | lower confidence | [Source: <source>] |

## Conditions That Make Counts Unstable

- macro event risk
- earnings / news catalysts
- thin sample size
- mixed timeframe signals
- unclear start and end anchors

## When Macro Or News Overrides Structure

If price is being driven by a fresh event, treat the wave read as secondary
until the structure stabilizes.

## Questions That Should Trigger Abstain

- Can I explain the count plainly without hand-waving?
- Does the alternate count look almost as plausible?
- Did I already ignore one hard-rule concern?
- Am I using Elliott to confirm a bias rather than test a structure?

If the answer to any of these is "yes, and I cannot resolve it," abstain.

## Red-Team Questions

- What if this is a correction, not an impulse?
- What if the degree is wrong?
- What if the chart is too noisy for a useful count?
- What if the best decision is no Elliott view at all?

## Agent Rule

When this page and the bullish/bearish count disagree, the guardrail wins.
```

## Template 5: `projects/trading/elliott-wave-playbook.md`

```md
---
title: Elliott Wave Playbook
type: project
status: live
owner: <name>
updated: YYYY-MM-DD
---

# Elliott Wave Playbook

## How We Use Elliott Wave

State the real role Elliott plays in the workflow:

- framing tool
- timing tool
- veto tool
- post-mortem tool

## Inputs We Trust

- price structure:
- timeframe alignment:
- market context:
- supporting indicators:

## Inputs We Do Not Trust

- single-count certainty
- hindsight-perfect labels
- structure that fails hard rules
- counts that require ignoring event risk

## Decision Thresholds

- What earns a watch-only stance:
- What earns a small-risk action:
- What still forces abstain:

## Risk Notes

- Position sizing rule:
- Invalidation discipline:
- Review cadence:

## Post-Mortem Loop

After each live use, log:

- initial count
- alternate count
- invalidation
- result
- what was actually learned
```

## Exact strategic-reading run prompt

Use this when you have a real Elliott Wave book or course transcript:

```text
Read this source through the lens of one problem:

"Help future agents use Elliott Wave as a bounded decision aid, not as magic.
Extract reusable operating knowledge for:

1. concepts/elliott-wave-theory
2. concepts/elliott-wave-rules
3. concepts/elliott-wave-analysis-checklist
4. concepts/elliott-wave-when-not-to-trust-the-count
5. optionally projects/trading/elliott-wave-playbook

Requirements:
- separate hard rules from soft guidelines
- include invalidation logic
- force alternate counts
- optimize for abstain safety, not just cleverness
- cite every non-obvious claim
- remove hype, certainty theater, and hindsight overfitting
- call out where the source is subjective, disputed, or weak"
```

## What good looks like

A good Elliott Wave pack makes future agents:

- more structured
- more honest
- more willing to abstain
- better at naming invalidation

It should not make them:

- more mystical
- more certain than the evidence allows
- more likely to force patterns onto noisy charts
