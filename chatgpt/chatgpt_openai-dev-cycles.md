---
conversation_id: 6927784a-c4b4-832f-b3ef-770212e9a36a
created: 2025-11-26
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: OpenAI dev cycles
type: note
updated: 2025-11-26
---

# OpenAI dev cycles

> Conversation ID: 6927784a-c4b4-832f-b3ef-770212e9a36a
> Created: 2025-11-26T22:01:00Z
> Updated: 2025-11-26T22:02:15Z
> Messages: 2

---

## User

Sam Altman talks about how if you have an iteration cycle of 2 days you will have more shots at goal then a company with a 2 week cycle. and if you have a 4 hour cycle, you'll crush the 2 day company. So even if you're wrong, running 10 experiments in the time it takes another company to run 2 puts you ahead EVEN if you keep guessing wrong.

Is there any info out there about the open ai dev cycles and how they run things there?

---

## Assistant

Short answer, Mr. White: there’s no “we iterate every 4 hours” memo from OpenAI, but there *is* a decent amount of signal about how they actually run, and it lines up almost perfectly with the “more shots on goal” philosophy Sam talks about.

---

### 1. The Sam Altman iteration thing (for context)

Altman’s line you’re referencing is basically:

- If you can get ~2% better every iteration, the compounding is insane.
- And if your iteration cycle is 4 hours instead of 4 weeks, you just get *orders of magnitude* more shots on goal. citeturn0search0turn0search4turn0search17  

That’s the philosophy, and OpenAI’s public material shows they’ve tried to architect the *org + tooling* around exactly that.

---

### 2. What OpenAI itself publishes about how they build

**a) “From experiments to deployments” (OpenAI business guide)**  
This guide is essentially a playbook for going from “toy prototype” to production with short cycles:  

- Start with **small, tightly scoped experiments** tied to a clear KPI, not science projects.  
- Quickly move promising things into **pilot deployments**, with monitoring and evals wired in from day one.  
- Treat it as an **ongoing loop**, not a one-off launch: experiment → deploy → measure → refine. citeturn1search0turn0search5  

This is basically “fast, measurable iteration” formalized for customers, and it’s very likely similar to how their internal product teams operate.

---

**b) “Building an AI-native engineering team” (OpenAI engineering guide)**  

This one is more explicit about dev cycles:

- They say work that used to take **weeks now gets done in days**, because coding agents (their own models) handle a lot of the grind: doc updates, tests, dependency cleanup, feature-flag cleanup, etc. citeturn0search1turn1search2  
- Engineers shift from “type every line of code” to **“iterative oversight”**, where you:  
  - Ask the model/agent for an implementation  
  - Run tests/evals  
  - Nudge/fix/steer, then repeat  

This is explicitly about compressing the *engineering* iteration loop, not just the business one. citeturn1search4  

---

**c) Internal tooling to keep build/ship loops short**

In a post about how they built the Atlas/ChatGPT desktop app and its UI architecture (OWL), they call out that:  

- OWL ships internally as a **prebuilt binary**, so most engineers *don’t* need to build Chromium locally.  
- Result: **builds take minutes instead of hours**, which directly translates into faster iteration on UI and app behavior. citeturn1search6  

That’s exactly what you’d do if you cared deeply about tight  “edit → build → test” loops.

---

### 3. Culture: lots of parallel experiments, not a grand master plan

A former OpenAI engineer (Calvin French-Owen, ex-Segment cofounder) wrote “Reflections on OpenAI” and described the culture like this:  

- Historically, **no detailed quarterly roadmap** in research – progress is “bottom-up” and discovered via experiments.  
- Progress is **iterative**; many ideas are tried, and it’s unclear in advance which will win.  
- It’s very **meritocratic/experiment-driven**: good ideas + executed experiments rise, not politics. citeturn1search1  

That is exactly the environment where you maximize shots on goal: lots of people running lots of experiments, rather than one top-down plan.

---

### 4. Product cadence and “always-on” releases

A recent OpenAI go-to-market lead (Andy Brown) talked publicly about how AI is changing software cycles:

- Traditional companies run on long sprint cycles; OpenAI and peers are shifting to **“even more agile and ‘always-on’ product release cycles.”**  
- He gave the example that OpenAI’s **Agent Builder** was built in about **six weeks**, with **~80% of its code written by their own model**, which is exactly how you shrink cycles.  
- He also said AI companies like OpenAI can ship **multiple product updates in a single week**, enabled by this new way of working. citeturn0news32  

So while we don’t have “their sprint length,” we *do* have confirmation that they optimize for continuous shipping, not 2–4 week gated releases.

---

### 5. Customer-embedded feedback loops (Forward Deployed style)

OpenAI also uses **Forward-Deployed Engineers / similar roles**:

- These engineers embed with strategic customers, build custom solutions, and create **evals and data** that go back to core research/engineering. citeturn1search19  
- One documented example: FDEs working on voice call-center automation built evals, found the model wasn’t good enough, looped that back to research, improved the model, and then the customer became the *first* to deploy the advanced solution. citeturn1search28  

That is literally:  
customer pain → evals/metrics → model/product iteration → redeploy → repeat.  
Tight loop, but now closed with *live customer data*.

---

### 6. Safety & alignment add an extra (slower) loop on top

For model behavior, OpenAI has written about an **iterative feedback process** with labelers/reviewers:

- They maintain **continuous feedback loops** with reviewers and hold weekly meetings to adjust guidance.  
- The model is repeatedly fine-tuned using that feedback to gradually improve behavior. citeturn1search23  

So you can think of it as:

- **Fast loops:** product features, UI, code, customer experiments.  
- **Slower, heavier loops:** safety, alignment, big model releases, where more review and governance are required.

---

### 7. What we *don’t* know

What’s *not* public (or only very vaguely so):

- Exact sprint lengths (1 week vs 2 vs Kanban with no sprints).  
- Concrete metrics like “average cycle time from idea → shipped” for various teams.  
- Whether any teams actually run on an explicit “4-hour cycle” vs “deploy whenever tests/evals pass.”

Given the evidence, it’s safe to say they’re optimized for **short, continuous cycles** and lots of parallel shots on goal – but the precise numbers are kept internal.

---

### 8. If you want to copy the *spirit* of OpenAI’s dev cycle

If you’re trying to pull this into your own company, the pattern looks like:

1. **Compress build/test time** with tooling (prebuilt binaries, fast CI, etc.).
2. **Offload grunt work to AI** (code gen, docs, boilerplate tests) so humans do oversight and decision-making, not typing.
3. **Wire in evals & metrics from day one** so every experiment is measurable.
4. **Embed builders with users/customers** to shorten the feedback loop.
5. **Treat “ship” as the midpoint**, not the end: release → observe → tweak → repeat.

That’s about as close as we can get to “how OpenAI runs dev cycles” from public info, and it’s very aligned with Altman’s “more shots on goal” worldview.

navlistMore on OpenAI's product and dev cadenceturn0news32


**Topic:** [[chatgpt-clusters/coding_ai]]
