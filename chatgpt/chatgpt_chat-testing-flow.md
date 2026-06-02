---
title: "Chat Testing Flow"
type: guide
created: 2026-05-16
updated: 2026-05-16
source: chatgpt-export
conversation_id: 6a08908e-836c-83e8-ae7e-1c624407a441
message_count: 3
tags: [chatgpt, import, code, long-form]
---
# Chat Testing Flow

> Conversation ID: 6a08908e-836c-83e8-ae7e-1c624407a441
> Created: 2026-05-16T15:43:12Z
> Updated: 2026-05-16T15:47:21Z
> Messages: 3

---

## User

There's a bunch of things we need to test in the chat in jovie:
- Regenerating album art
- Channel conversations
What's the flow for us to calculate testing a lot? Do we need to have a chat experiment or something that doesn't require going off on local? Something I can just quickly run through? Or should it be the whole chat history and then I tell you what's right or wrong about it? Is there an interface for this? Is there a training software we should use? Should we build something into the op screen? What's the best way to handle this?

---

## Assistant

Mr. White, I’ll treat this as a Jovie chat eval workflow and compare lightweight in-product testing against third-party tooling to recommend a concrete build-vs-buy flow.

---

## Assistant

Mr. White, I’d handle this as **Jovie Chat Evals**, with a lightweight internal runner plus a review screen. Do **not** start by manually reading whole chat histories every time. Use full chat histories only to create test cases and regression cases.

## Best flow

### 1. Create a repeatable test-case dataset

Each test case should be a saved scenario:

```ts
{
  id: "regen_album_art_existing_release_001",
  feature: "album_art_regeneration",
  initial_state: {
    user_id: "...",
    artist_id: "...",
    release_id: "...",
    channel_id: null,
    existing_album_art_url: "...",
    permissions: ["artist_admin"]
  },
  messages: [
    "Can you regenerate the album art for this release?"
  ],
  expected: {
    must_call: ["regenerate_album_art"],
    must_write: ["album_art_job.created"],
    must_not_call: ["publish_release"],
    response_criteria: [
      "Confirms regeneration started",
      "Does not claim final art is ready unless job completed"
    ]
  }
}
```

For **channel conversations**, test cases need channel state:

```ts
{
  feature: "channel_conversations",
  initial_state: {
    channel_id: "artist_fans",
    participant_role: "fan",
    prior_messages: [...]
  },
  messages: [
    "Summarize what this channel decided about the rollout."
  ],
  expected: {
    must_use_channel_id: "artist_fans",
    must_not_expose_private_artist_notes: true,
    response_criteria: [
      "Summarizes only channel-visible messages",
      "Mentions uncertainty when context is incomplete"
    ]
  }
}
```

### 2. Run tests against staging, not local

The runner should hit the same chat API that production uses, with seeded test data. That gives you realistic coverage without everyone needing local setup.

Good setup:

```txt
Admin / Op Screen
  → Select eval suite
  → Select branch / deployment / prompt version / model version
  → Run 20, 100, or 500 cases
  → See failures
  → Review transcript + tool calls + DB diffs
```

This should be a **chat eval experiment**, meaning a versioned run over a fixed dataset. LangSmith describes the standard flow as creating a dataset, defining evaluators, then running experiments; its docs also support human review, code rules, LLM-as-judge, and pairwise comparison. citeturn908525search1turn908525search25 Braintrust frames evals similarly as data, task, and scores, with experiments stored as immutable snapshots you can compare over time. citeturn908525search2turn908525search10

### 3. Score the easy stuff automatically

For Jovie, many failures are deterministic. These should be hard checks:

**Album art regeneration**

| Check | Scoring |
|---|---:|
| Called correct regeneration action | pass/fail |
| Used correct artist/release ID | pass/fail |
| Did not regenerate wrong asset | pass/fail |
| Created job or task in DB | pass/fail |
| Response accurately described job state | pass/fail |
| Did not say image was complete before completion | pass/fail |
| New image URL differs from previous image URL | pass/fail |
| Image meets dimensions / format requirements | pass/fail |

**Channel conversations**

| Check | Scoring |
|---|---:|
| Used correct channel ID | pass/fail |
| Did not leak private data | pass/fail |
| Respected sender role and permissions | pass/fail |
| Referenced relevant channel history | pass/fail |
| Did not invent unavailable history | pass/fail |
| Routed reply to correct conversation/thread | pass/fail |
| Did not create unintended DB writes | pass/fail |

### 4. Use human review for subjective stuff

Some things need judgment:

| Question | Reviewer choice |
|---|---|
| Was the answer useful? | pass / fail / partial |
| Did it ask a good clarification question? | pass / fail |
| Was the album art direction followed? | pass / fail / partial |
| Was the tone right for artist/fan/admin context? | pass / fail |
| Was the channel summary accurate? | pass / fail |

You should have a reviewer screen with quick labels:

```txt
✅ Correct
❌ Wrong tool
❌ Wrong entity
❌ Permission/privacy failure
❌ Hallucinated state
❌ Bad copy
❌ Needs clarification
❌ Image quality failure
❌ Regression from previous version
```

Every failed review should have an **“Add to regression suite”** button.

### 5. Use whole chat history only as a source of test cases

The whole chat history approach is useful once, then it becomes inefficient.

Better flow:

```txt
Production/staging chat history
  → Pick important or failed conversations
  → Convert into test cases
  → Add expected behavior
  → Run forever as regression tests
```

So yes, you can tell the system “what was right or wrong” about a transcript, but that feedback should get converted into structured eval cases. Otherwise you are repeatedly doing manual QA instead of building a quality system.

## Should this be in the op screen?

Yes, at least the Jovie-specific parts.

Third-party eval tools are useful for generic eval storage, comparison, traces, and scoring. The **op screen** is useful because Jovie has product-specific state: artists, releases, album art jobs, channels, permissions, fan/admin roles, and DB side effects.

Build this into the op screen:

```txt
Chat QA / Evals
├── Run Suite
│   ├── Album art regeneration
│   ├── Channel conversations
│   ├── Permissions/privacy
│   ├── Release-management actions
│   └── Full smoke test
├── Results
│   ├── Pass rate
│   ├── Failures by category
│   ├── Cost / latency
│   └── Regression vs previous run
├── Transcript Viewer
│   ├── User messages
│   ├── Assistant messages
│   ├── Retrieved context
│   ├── Tool calls
│   ├── DB writes
│   └── Generated assets
└── Review
    ├── Mark pass/fail
    ├── Label failure
    ├── Add note
    └── Add to regression suite
```

## Should you use external software?

Use external software for eval orchestration at first; build Jovie-specific UI where product state matters.

My recommendation:

| Option | Use when |
|---|---|
| **Braintrust** | Best general choice if you want datasets, experiments, human review, scoring, and team-visible comparisons. Braintrust supports datasets built from production logs, user feedback, or manual curation, and scores can be code, LLM, or human-driven. citeturn908525search2turn908525search26 |
| **LangSmith** | Good choice if your stack already uses LangChain or you want tracing plus dataset/experiment comparison. LangSmith supports datasets, evaluators, experiment runs, and side-by-side comparison of application versions. citeturn908525search1turn908525search25 |
| **promptfoo** | Good for a fast CLI/CI setup. It supports automated testing, model/prompt comparisons, assertions, a browser-based setup flow, and CI/CD usage. citeturn908525search3turn908525search19turn908525search23 |
| **Custom op-screen runner** | Needed for Jovie-specific state setup, permissions, asset generation, DB diffing, and channel routing. |

For Jovie, I’d start with **Braintrust or LangSmith + a small internal runner**. Use promptfoo only if you want the fastest CLI path and less product-specific state.

## The release gate

Before shipping chat changes, require:

```txt
Core smoke suite: 100% pass
Feature suite: ≥ 90–95% pass
Privacy/permission suite: 100% pass
Known regressions: 0 critical
Manual review: completed for subjective failures
```

For your two current areas:

```txt
Album art regeneration: require 100% on correct entity/tool/job creation
Channel conversations: require 100% on permissions, channel ID, and no leakage
```

## Minimal version to build first

Build this first:

```txt
1. A JSON/YAML test-case format
2. A staging eval runner that calls Jovie chat API
3. Automatic checks for:
   - tool calls
   - entity IDs
   - DB writes
   - response contains/does-not-contain
   - permissions
4. A results table in the op screen
5. A transcript reviewer with pass/fail labels
6. “Save this failure as regression test”
```

Then add:

```txt
7. LLM-as-judge scoring for fuzzy response quality
8. Batch replay of production conversations
9. Side-by-side comparison across prompt/model versions
10. CI gate before deploy
```

## Direct answer

The best setup is:

```txt
Jovie Chat Eval Runner + Op Screen Review UI
```

Use a third-party eval platform for experiment tracking, dataset management, and comparisons. Build the Jovie-specific pieces into the op screen because your failures will often depend on internal product state, permissions, generated assets, and DB side effects.

Do **not** make the main workflow “read the whole chat history and tell me what is right or wrong.” Use chat history to generate test cases, then run those cases repeatedly.


## See Also
- [[chatgpt/chatgpt_chat-testing-report]]
- [[chatgpt/chatgpt_e2e-flow-testing]]
- [[chatgpt/chatgpt_ai-app-testing-process-part1]]
- [[chatgpt/chatgpt_ai-app-testing-process-part2]]
- [[chatgpt/chatgpt_ai-app-testing-process-part3]]
