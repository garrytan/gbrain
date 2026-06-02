---
title: "Onboarding Chat Refinement"
type: guide
created: 2026-05-13
updated: 2026-05-13
source: chatgpt-export
conversation_id: 6a0504e8-21ec-83e8-96df-1809eccc8ac2
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Onboarding Chat Refinement

> Conversation ID: 6a0504e8-21ec-83e8-96df-1809eccc8ac2
> Created: 2026-05-13T23:10:32Z
> Updated: 2026-05-13T23:15:12Z
> Messages: 4

---

## User

We'd previously discussed an onboarding chat which would be based on the one that Stanley for Twitter uses, which I had previously uploaded screenshots of. During the onboarding, it spins up tools, grabs your social handles or Spotify or whatever, and then starts building your profile in real time. It then does the whole demo, which is the whole demo about your product, and it's partially implemented.

How do we refine the response structure and the way it handles conversation, and tune both the voice and speech style, and also root it more in knowledge? I basically want a workflow where we can ship, but I don't know what the best thing is for us to just have test conversations, or is it a testing infrastructure for this, or is there a prompt? There's a site where we can take our problem and feed it through 50 different LLMs all trying to converse with it, and then get example chat conversations back. I can read them back and then, in a voice memo, say what I like and what I don't like, and then feed that back in and just keep moving like that. Is that a good way to do it, or are there better ways to do it? Do you need to root it in all the knowledge that you have and then write it, or how do we do this? Should we have one of our agents set up a cron to perpetually improve it, and how do we think about that? 

---

## Assistant

Mr. White, I’ll turn this into a practical product workflow: what to ship first, how to test conversations, use the Stanley reference, and improve without overbuilding.

---

## Assistant

I’ll also account for current tooling options and propose a concrete architecture for reliability, voice control, and iteration loops.

---

## Assistant

Mr. White, I’d ship this as an **eval-driven onboarding system**, not as a prompt-tuning project.

The 50-LLM conversation idea is useful for breadth and inspiration. It should generate examples, edge cases, and alternative phrasings. Shipping decisions should come from testing the actual onboarding endpoint against scripted personas, tool states, and regression checks.

## The core recommendation

Build the onboarding chat as three layers:

1. **A deterministic onboarding state machine**
   - The model speaks.
   - The tools do the work.
   - The server owns state transitions.
   - The UI reveals progress based on tool results, not model confidence.

2. **A grounded Jovie knowledge layer**
   - Product facts.
   - Live/beta/future feature status.
   - Brand voice.
   - Demo script.
   - ICP and objection handling.
   - Tool capability rules.

3. **A conversation eval loop**
   - Synthetic users run through the flow.
   - The transcripts get scored.
   - You review the best/worst/weirdest examples.
   - Your voice memo feedback becomes rules, examples, and goldens.
   - Prompt/spec changes ship only after regression tests pass.

That gives you a workflow where you can move fast without letting the assistant drift into vague SaaS copy, fake product claims, or beautiful conversations that fail the actual onboarding job.

## What the onboarding chat is really doing

The chat should feel like Stanley-style onboarding: sharp, live, one-question-at-a-time, with visible work happening in the background. For Jovie, the “magic” is not that the assistant talks well. The magic is:

> “I found your artist profile. I’m pulling in your catalog. I matched your streaming links. I’m building your public profile. Now here’s what Jovie can do with it.”

That maps directly to Jovie’s canon: Jovie is AI that runs release workflows for independent artists, starting with profile setup, smart links, fan capture, notifications, metadata, and playlist pitches. The canon also says Spotify sync should build the profile automatically in under 60 seconds, which should be the emotional center of onboarding. fileciteturn3file0

The demo should then ladder into the bigger product story: claim profile → import catalog → profile/fan capture → notifications → release plan → workflow underneath. The strongest line to preserve is: **“No templates. No campaign builder. Just my music reaching my fans.”** The demo docs also make the key distinction between **release moments** and the **workflow underneath**, which should become a reusable conversation pattern. fileciteturn3file1

## The response structure I’d use

Every assistant turn should follow this structure internally:

```json
{
  "phase": "artist_identification | profile_build | demo | activation | checkout",
  "user_intent": "claim_profile | connect_spotify | ask_question | objection | stuck | off_path",
  "visible_reply": "Short user-facing message",
  "next_question": "At most one question",
  "tool_requests": ["search_spotify_artist", "check_handle", "start_dsp_discovery"],
  "profile_updates": {
    "artist_name": "...",
    "spotify_artist_id": "...",
    "preferred_handle": "..."
  },
  "ui_event": {
    "type": "reveal_panel | show_progress | show_profile_preview | show_release_plan"
  },
  "knowledge_sources_used": ["product_canon", "live_features", "pricing", "demo_script"],
  "claim_status": "live | beta | future | unknown"
}
```

The UI should only render `visible_reply` plus the relevant tool/progress UI. The server should validate every `tool_request`, `profile_update`, and `claim_status`.

A strong visible reply looks like:

> Found your Spotify profile. I’m pulling in your catalog and matching the rest of your streaming links now.  
> While that runs, what handle do you want: `jov.ie/timwhite` or something else?

A weak reply looks like:

> Tell me about your music career goals so I can personalize your experience.

Kill broad discovery questions. Ask concrete setup questions that advance the profile.

## Voice and speech style

Use this as the speech spec:

- One or two short sentences per turn.
- One question max.
- Always show progress when a tool is running.
- Say what Jovie is doing in plain language.
- Use musician language, not SaaS language.
- Be confident and direct.
- Be honest about live versus future features.
- Avoid “unlock,” “supercharge,” “take your career to the next level,” and generic AI-assistant warmth.

That aligns with the Jovie brand canon: direct, confident, concrete examples, no SaaS landing-page voice, no overselling unbuilt features, no talking down to musicians, and no label-exec jargon. fileciteturn3file9

The product voice should feel like an operator, not a chatbot:

> I found 14 releases. Three are missing Apple Music links, so I’m checking those now.  
> Do you want this profile to use your artist name or your DJ alias?

## How to root it in knowledge

Do not paste all Jovie knowledge into one giant prompt. Use a compact system prompt plus retrieval.

Create a small knowledge structure like this:

```text
/apps/web/lib/ai/onboarding/knowledge/
  product-live.md
  product-beta.md
  product-future.md
  brand-voice.md
  demo-script.md
  icp.md
  objections.md
  tool-capabilities.md
  safety-and-claims.md
```

Each retrieved fact should carry a status:

```ts
type ProductClaimStatus = 'live' | 'beta' | 'future' | 'unknown';
```

Then add a rule:

> The assistant may sell live features directly. It may preview beta/future features only when labeled as upcoming, planned, or demo-only.

This matters because the onboarding demo will naturally want to talk about the broader vision. Your canon has both the live wedge and the long-term system-of-record direction. The model needs to know which claims are shippable today and which are roadmap. fileciteturn3file0

The design/taste knowledge should also be retrieved when the assistant controls UI copy or demo narration. Your newer design canon says Jovie should be dark-mode first, calm by default, powerful on demand, with obvious primary actions, compact information, restrained motion, and concise outcome-oriented copy. That should shape onboarding copy and the visible setup UI. fileciteturn5file6

## The right testing workflow

Your proposed loop is directionally right:

> Generate many conversations → read them → voice memo what you like/dislike → feed that back → iterate.

I’d formalize it so the feedback compounds.

### Step 1: Build 20 golden scenarios

Examples:

- Artist connects Spotify successfully.
- Artist has multiple Spotify matches.
- Artist has no Spotify profile.
- Artist wants only a link-in-bio.
- Artist is skeptical about giving access.
- Artist asks “How is this different from Linktree?”
- Artist asks pricing.
- Artist is a manager, not the artist.
- Artist tries to skip onboarding.
- Artist asks for a feature that is future-only.
- Tool fails midway.
- User gives a social handle before Spotify.
- User gives vague input.
- User is impatient.
- User is not a musician.

### Step 2: Build synthetic personas

Each persona should have a short card:

```yaml
name: "Working DJ"
traits:
  - impatient
  - has Spotify
  - cares about shows and fan capture
success:
  - connects Spotify
  - claims handle
  - understands notifications
  - sees profile preview
failure:
  - asks vague goal questions
  - mentions unbuilt features as live
  - takes more than 6 turns to reach profile preview
```

### Step 3: Run model simulations

For the “site that runs lots of conversations,” the closest dedicated hosted product is **Coval**. It is built for simulating and evaluating AI voice and chat agents, including running simulated conversations and measuring them with metrics. citeturn949515search0turn949515search4turn949515search16

For a developer-controlled stack, use **Promptfoo + OpenRouter** for multi-model prompt/eval runs, and **Langfuse**, **LangSmith**, or **DeepEval** for traces, datasets, multi-turn evaluation, and LLM-as-judge scoring. Promptfoo supports test cases, assertions, CI, and OpenRouter providers; LangSmith supports datasets and evaluators; Langfuse has multi-turn simulation/evaluation workflows; DeepEval has multi-turn conversational metrics. citeturn693389search0turn693389search1turn648390search4turn648390search5turn693389search2

OpenRouter Fusion is useful for having multiple models critique a prompt or answer, but the more important test is whether the actual Jovie flow completes correctly with tools, state, UI events, and product truth intact. citeturn648390search10turn648390search14

## The eval scorecard

Score every conversation on:

| Category | What it checks |
|---|---|
| Tool correctness | Did it call the right tools in the right order? |
| State progress | Did the user move toward profile creation? |
| One-question rule | Did each turn ask at most one thing? |
| Voice | Direct, musician-native, no SaaS fluff |
| Product truth | Live/beta/future claims handled correctly |
| Demo clarity | Did the user understand what Jovie does? |
| Momentum | Did every turn make visible progress? |
| Conversion | Did it reach Spotify, handle, profile preview, or checkout? |

Then maintain:

```text
/evals/onboarding/
  personas.yml
  scenarios.yml
  rubrics.yml
  golden-conversations/
  failed-conversations/
  promptfooconfig.yaml
  run-simulations.ts
  summarize-failures.ts
```

Your voice memo loop becomes powerful when it produces structured deltas:

```text
Founder feedback:
- Keep: "I found your catalog. I'm matching the rest now."
- Kill: "Tell me about your goals."
- Rule: Never ask for goals before showing a profile preview.
- New golden: skeptical artist asks why Spotify access is needed.
- New banned phrase: "optimize your music career."
```

An agent can turn that into prompt updates, rubric updates, and new test cases.

## Should a cron perpetually improve it?

Use cron for **evaluation and reporting**, not autonomous prompt mutation.

Your May 13 hardening plan already points to the right automation posture: cron jobs should be no-agent/script jobs, idempotent, heartbeat-producing, protected with lockfiles, runtime-limited, and never recursively create new cron jobs. It also separates scheduler work from LLM reasoning. fileciteturn5file1

Good cron:

- Nightly: run 100 simulated onboarding conversations.
- Nightly: summarize top regressions.
- Nightly: create a report with 10 transcripts worth reviewing.
- Morning: send “what changed / what failed / what needs human taste.”
- On PR: run golden conversation regression tests.
- Weekly: create a proposed prompt/rubric PR.

Bad cron:

- “Improve the prompt forever.”
- “Auto-merge better voice.”
- “Let an agent rewrite onboarding based on vibes.”
- “Run expensive LLM reasoning inside the scheduler.”

The right autonomy boundary is:

> Agents can propose improvements. Humans approve changes that affect user-facing voice, product claims, or conversion flow.

## What I’d ship first

### Day 1–2: Freeze the spec

Create:

```text
docs/onboarding-chat-spec.md
docs/onboarding-voice-spec.md
docs/onboarding-knowledge-map.md
```

Define:

- Phases.
- Allowed tool calls.
- Required UI events.
- Live/beta/future claims.
- Response contract.
- Banned phrases.
- Golden lines.

### Day 3–4: Instrument the product

Log every onboarding turn with:

```ts
{
  promptVersion,
  knowledgeVersion,
  model,
  phase,
  userMessage,
  assistantVisibleReply,
  toolCallsRequested,
  toolCallsCompleted,
  uiEvents,
  completionStatus,
  failureReason
}
```

Use Langfuse or LangSmith for traces if you want hosted visibility; use local JSONL if you want speed.

### Day 5–6: Add evals

Start with 20 scenarios and 10 personas. Run 100 conversations per prompt version.

### Day 7: Founder review loop

Auto-select:

- 3 best conversations.
- 3 worst conversations.
- 3 weird conversations.
- 3 high-conversion conversations.
- 3 product-truth failures.

You record one voice memo. An agent converts that into:

- prompt diff
- rubric diff
- new golden examples
- new banned phrases
- new regression cases

### Day 8–10: Gate changes in CI

Every onboarding prompt/spec PR must pass:

- golden conversations
- tool-order assertions
- product-truth assertions
- max-turn checks
- one-question-per-turn checks
- forbidden phrase checks

## The cleanest tool stack

For Jovie right now:

| Need | Tool |
|---|---|
| Fast local prompt/model testing | Promptfoo |
| Many model providers | OpenRouter |
| Hosted simulated chat users | Coval |
| Tracing production conversations | Langfuse or LangSmith |
| Multi-turn eval metrics | DeepEval |
| Founder review | Voice memo → transcript → tagged feedback |
| CI gate | Promptfoo GitHub Action / local CI command |

Start with **Promptfoo + OpenRouter + JSONL traces** because it is the fastest to wire. Add Coval when the flow is stable enough that simulated users are testing product behavior rather than helping you discover the shape of the product.

## The main product decision

The onboarding assistant should not be “a smart chat that happens during onboarding.”

It should be **Jovie setting itself up in front of you**.

The conversation is just the control surface. The product moment is the live profile build. Every turn should either:

- find the artist,
- enrich the profile,
- claim the handle,
- show the profile,
- explain the Jovie workflow,
- remove an objection,
- or move the user to activation.

That is how you get something shippable: tight state machine, grounded knowledge, Stanley-style momentum, evals before deploy, and founder taste converted into goldens instead of scattered prompt notes.
