---
title: "Detecting AI Jank"
type: guide
created: 2026-04-24
updated: 2026-04-24
source: chatgpt-export
topic: business-jovie
message_count: 6
tags: [chatgpt, knowledge, business-jovie]
---
**Topic:** [[chatgpt-knowledge/_topics/business-jovie]]

# Detecting AI Jank

> **Source:** ChatGPT conversation
> **Date:** 2026-04-24T07:44:31Z
> **Messages:** 6
> **Topic:** business-jovie

## Question

we need to detect jank in our ai chat.

messages disappear and reappear at multiple oints in the rpcoess of conversation. sometimes chat just dioesnt respond. the product just "feels" unstable because of this. 

i dont understand how to quantify "jank" enough un ui particulary with streaming elements and ai.

## Answer

Mr. White, I’ll turn “jank” into measurable chat instability: message persistence, streaming continuity, latency, layout shifts, rendering stalls, state churn, and response failures.

## Answer

Mr. White, quantify this as **chat stability**, not generic “UI performance.”

For AI chat, “jank” means the user loses confidence that the conversation state is real. The product can have acceptable FPS and still feel broken if messages disappear, reappear, reorder, reset, or silently stall.

## 1. Define jank as observable violations

Use this taxonomy:

| Category | User-visible symptom | Metric |
|---|---|---|
| **Message continuity jank** | Message disappears, reappears, duplicates, changes order | message flap rate, remount count, reorder count |
| **Streaming jank** | Assistant starts, stops, resets, jumps backward, token stream freezes | time to first token, stall count, token rollback count |
| **Scroll jank** | Chat jumps while reading, input moves, latest message moves unexpectedly | unexpected scroll delta, anchor displacement |
| **Layout jank** | Bubbles shift, skeletons collapse, markdown/images resize late | chat-specific layout shift |
| **Responsiveness jank** | User clicks send and nothing seems to happen | send-to-feedback latency, INP |
| **Reliability jank** | Request never resolves, no error shown, UI stuck loading | silent failure rate, stuck response rate |

Standard browser metrics help, but they are incomplete. INP measures interaction responsiveness across clicks, taps, and keyboard input; web.dev considers ≤200ms good and >500ms poor. That helps quantify “I clicked send and the UI felt dead.” citeturn740486view0turn740486view1 CLS/layout-shift helps quantify visual instability when visible elements move between frames. citeturn119490view0 Long Animation Frames are useful for finding slow UI frames; a LoAF is a rendering update delayed beyond 50ms, and Chrome’s API can observe these in real user sessions. citeturn119490view1turn119490view2

## 2. Create a “jank-free conversation” metric

Your top-level product KPI should be:

**Jank-Free Conversation Rate**

A conversation is jank-free when all of these are true:

```text
No message disappears after being visible.
No message reorders after being visible.
No assistant stream stalls for >2s without visible status.
No token rollback occurs.
No unexpected scroll jump >48px.
No send action lacks visible feedback within 150ms.
No response remains stuck for >30s without an error/retry state.
```

Then track:

```text
jank_free_conversation_rate =
  conversations_with_zero_jank_events / total_conversations
```

This is better than average latency because users remember the broken-feeling sessions.

Target progression:

```text
<90%      visibly unstable
90–95%    tolerable but users will complain
95–98%    decent
98%+      feels solid
99%+      premium/chat-native quality
```

## 3. Instrument the chat lifecycle

Every user message should have a single immutable lifecycle:

```text
user_pressed_send
→ user_message_rendered
→ assistant_placeholder_rendered
→ request_started
→ stream_connected
→ first_token_received
→ first_token_painted
→ stream_completed
→ final_mes

*(Answer truncated — 10159 chars total)*

## Question

give me the mvp of this in a prompt i can have claude code tackle. it should include testing and then run ing gstack skills /qa --exhaustive to trigger and repair said tests.

## Answer

I’ll turn this into a copy-pasteable implementation prompt scoped to MVP instrumentation, regression tests, and a forced exhaustive QA repair loop.

## Answer

Mr. White, use this prompt with Claude Code:

```text
You are working in this repo as a senior frontend/product engineer.

Goal: implement an MVP system to detect, test, and prevent AI chat “jank.”

Context:
Our AI chat feels unstable. During conversations, messages sometimes disappear and reappear, reorder, duplicate, reset while streaming, or the chat simply stops responding without clear feedback. We need an MVP that makes this measurable and catches regressions in tests.

Do not overbuild a full observability platform. Build the smallest useful version that:
1. Detects message continuity jank.
2. Emits structured jank events.
3. Adds tests for the most likely failure modes.
4. Runs QA and repairs failures.

First, inspect the codebase and find:
- Chat message rendering components.
- Message list / thread components.
- Streaming response handling.
- Optimistic user message handling.
- Persistence/refetch logic.
- Existing analytics/event tracking utilities.
- Existing unit/integration/e2e test framework.

Implement the MVP using existing project conventions.

Core definitions:

A “jank event” is any user-visible break in chat continuity, especially:
- A visible message disappears and later reappears.
- A message changes identity during optimistic-to-server reconciliation.
- A message duplicates.
- Messages reorder unexpectedly.
- Assistant streaming text rolls backward or resets.
- Assistant stream stalls without visible status.
- User sends a message and no visible feedback appears quickly.
- Chat scroll jumps while the user is reading older messages.

MVP implementation requirements:

1. Stable message identity

Ensure every locally-created message gets a stable clientMessageId immediately.

Rules:
- clientMessageId must remain stable for the life of the message.
- serverMessageId should be attached later as metadata.
- React keys must use a stable message ID, never array index.
- Server updates/refetches should merge into existing messages rather than replacing visible messages wholesale.
- Optimistic user messages should reconcile with server messages without disappearing, duplicating, or remounting.

2. Jank instrumentation

Create a small chat jank monitor utility/hook/module.

It should track visible messages per conversation and emit structured events such as:

- chat_jank.message_disappeared
- chat_jank.message_reappeared
- chat_jank.message_duplicated
- chat_jank.message_reordered
- chat_jank.message_id_changed
- chat_jank.token_rollback
- chat_jank.stream_stall
- chat_jank.no_visible_feedback_after_send
- chat_jank.unexpected_scroll_jump

Each event should include, where available:
- conversationId
- clientMessageId
- serverMessageId
- role
- previousState
- nextState
- sequenceIndex
- streamRevision
- route/page
- timestamp
- app version/build if available

Use the project’s existing analytics/logging utility if one exists. If none exists, implement a small internal event emitter/logger that can be tested and later wired to analyti

*(Answer truncated — 8291 chars total)*
