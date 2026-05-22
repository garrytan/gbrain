---
name: negation-prose
description: Skill where brain reference precedes a negation-prose mention
triggers:
  - "do research"
---

# negation-prose

This skill starts with `gbrain search`, then talks about NOT using
web_search before the brain — testing that the position-relative check
correctly resolves to compliant (brain ref appears first in body).

## Workflow

1. Always start with `gbrain search "topic"` for existing context.
2. Do NOT use web_search before checking the brain. The brain has the
   answer 90% of the time.
3. Only after step 1 is empty, fall back to perplexity for fresh data.
