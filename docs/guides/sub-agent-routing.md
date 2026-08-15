# Sub-Agent Model Routing

## Goal

Route sub-agents to the cheapest model that can do the job, saving large
multiples on cost without sacrificing quality.

## What the User Gets

Without this: every sub-agent runs on your most expensive model. Entity
detection fires on every message at top-tier rates; research tasks cost
several dollars each.

With this: entity detection runs on a cheap fast model, research execution
runs on a budget model, and only planning/synthesis touch the expensive
model. Total cost drops 70-80%.

(Illustrative input-token anchors from gbrain's canonical pricing table,
`src/core/model-pricing.ts`: Opus-class $5/MTok, Sonnet-class $3/MTok,
Haiku-class $1/MTok. Budget providers run well under $1/MTok. Prices
drift — the pricing table is the source of truth, not this doc.)

## Implementation

### GBrain's native mechanism: model tiers

Before hardcoding vendors, use gbrain's tier routing. Every gbrain
subagent/LLM call resolves through a named tier
(`utility` / `reasoning` / `deep` / `subagent`), and you point each tier
at whatever model you want once:

```bash
gbrain config set models.tier.subagent anthropic:claude-haiku-4-5
gbrain config set models.tier.deep anthropic:claude-opus-4-7
```

Per-call override: `gbrain agent run --model <provider:model>`. The
conventions file `skills/conventions/model-routing.md` is the canonical
routing policy; this guide is the cost rationale behind it.

### Routing Table

| Task Type | Recommended Model | Why |
|-----------|------------------|-----|
| Main session / complex instructions | Opus-class (default) | Best reasoning and instruction following |
| Research / synthesis / analysis | DeepSeek V3 or equivalent | 25-40x cheaper, strong on exploratory work |
| Structured output / long context | Large context model (Qwen, Gemini) | 200K+ context, reliable JSON output |
| Fast lightweight sub-agents | Fast inference model (Groq) | 500 tok/s, cheap, good for quick tasks |
| Deep reasoning (use sparingly) | Reasoning model (DeepSeek-R1, o3) | Best for hard problems, expensive |
| Entity detection (signal detector) | Sonnet-class | Fast, cheap, sufficient quality for detection |

### The Signal Detector Pattern

Spawn a lightweight sub-agent on EVERY inbound message. This is mandatory.

```
on_every_message(text):
  // Spawn async — don't block the response
  spawn_subagent({
    task: `SIGNAL DETECTION — scan this message:
    "${text}"

    1. IDEAS FIRST: Is the user expressing an original thought?
       If yes -> create/update brain/originals/ with EXACT phrasing
    2. ENTITIES: Extract person names, company names, media titles
       For each -> check brain, create/enrich if notable
    3. FACTS: New info about existing entities -> update timeline
    4. CITATIONS: Every fact needs [Source: ...] attribution
    5. Sync changes to brain repo`,
    model: "sonnet-class",  // fast + cheap; haiku-class is cheaper still
    timeout: 120s
  })
```

**Why a cheaper class for detection:** Entity detection is pattern matching,
not deep reasoning. Sonnet-class runs at a fraction of Opus-class cost, and
Haiku-class at a fraction of that — both fast enough for async detection.
The main session continues on your best model while detection runs in
parallel.

### Research Pipeline Pattern

For research-heavy tasks, use a multi-model pipeline:

```
1. PLANNING (Opus):     Write research brief, identify what to look for
2. EXECUTION (DeepSeek): Sub-agent does the actual research (web, APIs, docs)
3. SYNTHESIS (Opus):     Read research output, add strategic analysis
```

**Why this works:** The planning and synthesis steps need taste and judgment
(Opus-class). The execution step is mechanical data gathering (a budget
model at a small fraction of the cost). You get top-tier output at
budget-model cost for 80% of the work.

### When to Spawn Sub-Agents

| Situation | Spawn? | Model |
|-----------|--------|-------|
| Every inbound message | YES (mandatory) | Sonnet |
| Research request | YES | DeepSeek for execution |
| Quick lookup / fact check | YES | Fast model (Groq) |
| Complex analysis | NO -- handle in main session | Opus |
| Writing / editing | NO -- handle in main session | Opus |

### Cost Optimization

The main session runs on your best model. Everything else runs on the
cheapest model that can do the job. In practice, 60-70% of sub-agent
work is entity detection and research execution, which run at a small
fraction of the main session model's cost.

## Tricky Spots

1. **A cheap class, not Opus, for detection.** The most common mistake is
   running entity detection on Opus-class. Detection is pattern matching, not
   deep reasoning. Sonnet- or Haiku-class is several times cheaper and fast
   enough. Reserve Opus-class for the main session where reasoning quality
   matters.

2. **Don't block the main thread.** Sub-agents must run asynchronously. If the
   signal detector runs synchronously, the user waits 30-120 seconds for every
   message while entity detection completes. Spawn and forget. The user sees
   a response immediately.

3. **Cost optimization is multiplicative.** Entity detection runs on every
   single message, so the per-call price difference compounds across 50+
   messages/day. Routing detection from Opus-class ($5/MTok in) to
   Haiku-class ($1/MTok in) is a flat 5x cut on your highest-frequency LLM
   call — over a month, the wrong model choice for detection alone costs
   real money. (Current per-model rates: `src/core/model-pricing.ts`.)

## How to Verify

1. **Spawn a signal detector and check the model.** Send a message and verify
   the sub-agent was spawned on Sonnet-class, not Opus. Check the model field
   in the sub-agent config or logs.

2. **Check cost per day.** After running for a day with sub-agent routing,
   compare total API costs against the previous day without routing. You
   should see a 50-80% reduction in total cost.

3. **Verify async execution.** Send a message and measure response time. The
   response should arrive in under 5 seconds. If it takes 30+ seconds, the
   signal detector is running synchronously and blocking the main thread.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
