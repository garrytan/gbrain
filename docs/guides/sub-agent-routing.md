# Sub-Agent Model Routing

## Goal

Route sub-agents to the cheapest model that can do the job, saving 10-40x on costs without sacrificing quality.

## What the User Gets

Without this: every sub-agent runs on Opus ($15/MTok). Entity detection on
every message costs $3-5/day. Research tasks cost $10+ each.

With this: entity detection runs on Sonnet ($3/MTok, 5x cheaper). Research
runs on DeepSeek ($0.50/MTok, 30x cheaper). Main session stays on Opus for
quality. Total cost drops 70-80%.

## Implementation

### Routing Table

| Task Type | Recommended Model | Why |
|-----------|------------------|-----|
| Main session / complex instructions | Opus-class or Codex OAuth model | Best reasoning and instruction following |
| Research / synthesis / analysis | DeepSeek V3 or equivalent | 25-40x cheaper, strong on exploratory work |
| Structured output / long context | Large context model (Qwen, Gemini) | 200K+ context, reliable JSON output |
| Fast lightweight sub-agents | Fast inference model (Groq) or `openai-codex:gpt-5.5` | Cheap or subscription-backed, good for quick tasks |
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
   model: "sonnet-class",  // fast + cheap; use openai-codex:gpt-5.5 when configured
    timeout: 120s
  })
```

**Why Sonnet-class for detection:** Entity detection is pattern matching, not
deep reasoning. Sonnet is 5-10x cheaper than Opus and fast enough for async
detection. The main session continues on Opus while detection runs in parallel.

### Research Pipeline Pattern

For research-heavy tasks, use a multi-model pipeline:

```
1. PLANNING (Opus):     Write research brief, identify what to look for
2. EXECUTION (DeepSeek): Sub-agent does the actual research (web, APIs, docs)
3. SYNTHESIS (Opus):     Read research output, add strategic analysis
```

**Why this works:** The planning and synthesis steps need taste and judgment
(Opus). The execution step is mechanical data gathering (DeepSeek at 25-40x
lower cost). You get Opus-quality output at DeepSeek-level cost for 80% of
the work.

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
work is entity detection (Sonnet) and research execution (DeepSeek),
which are 10-40x cheaper than the main session model.

## Tricky Spots

1. **Sonnet, not Opus, for detection.** The most common mistake is running
   entity detection on Opus. Detection is pattern matching, not deep reasoning.
   Sonnet is 5-10x cheaper and fast enough. Reserve Opus for the main session
   where reasoning quality matters.

2. **Don't block the main thread.** Sub-agents must run asynchronously. If the
   signal detector runs synchronously, the user waits 30-120 seconds for every
   message while entity detection completes. Spawn and forget. The user sees
   a response immediately.

3. **Cost optimization is multiplicative.** Entity detection runs on every
   single message. If you use Opus at $15/MTok for detection across 50
   messages/day, that's $3-5/day just for detection. Sonnet at $3/MTok brings
   that to $0.60-1.00/day. Over a month, the wrong model choice costs $100+
   more than necessary.

## How to Verify

1. **Spawn a signal detector and check the model.** Send a message and verify
   the sub-agent was spawned on the intended tool-loop model. Check the model
   field in the sub-agent config or logs.

2. **Check cost per day.** After running for a day with sub-agent routing,
   compare total API costs against the previous day without routing. You
   should see a 50-80% reduction in total cost.

3. **Verify async execution.** Send a message and measure response time. The
   response should arrive in under 5 seconds. If it takes 30+ seconds, the
   signal detector is running synchronously and blocking the main thread.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
